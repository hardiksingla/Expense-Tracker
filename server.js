require('dotenv').config();
const express = require('express');
const { processExpenseMessage, completePendingSplit, getTodayTotal, getMonthTotal, setMonthlyBudget, getBudgetStatus, getOwedSummary, getAveragePerDayThisMonth, getCategoryOverviewThisMonth, undoLastExpense, getLastExpense } = require('./expenseService');
const { telegramAuthMiddleware, verifyTelegramWebhook } = require('./telegramMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_ADMIN_TOKEN = process.env.WEBHOOK_ADMIN_TOKEN;

app.use(express.json());

// Idempotency cache: store recently processed update IDs
const processedUpdates = new Set();
const pendingSplitClarifications = new Map();
const PENDING_SPLIT_TTL_MS = 10 * 60 * 1000;
// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function sendTelegramReply(chatId, text) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error("Missing TELEGRAM_BOT_TOKEN to send replies");
        return;
    }
    const cleanText = String(text ?? '')
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n /g, '\n')
        .trim();
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: cleanText })
        });
    } catch (e) {
        console.error("Failed to send telegram message:", e);
    }
}

function authorizeWebhookAdmin(req, res, next) {
    if (!WEBHOOK_ADMIN_TOKEN || req.query.adminToken !== WEBHOOK_ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

async function callTelegramApi(method, body = {}) {
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error('TELEGRAM_BOT_TOKEN is missing');
    }

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
        throw new Error(result.description || `Telegram API request failed with status ${response.status}`);
    }
    return result.result;
}

app.get('/telegram/webhook-info', authorizeWebhookAdmin, async (req, res) => {
    try {
        const info = await callTelegramApi('getWebhookInfo');
        res.json({
            url: info.url,
            hasCustomCertificate: info.has_custom_certificate,
            pendingUpdateCount: info.pending_update_count,
            lastErrorDate: info.last_error_date,
            lastErrorMessage: info.last_error_message
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/telegram/set-webhook', authorizeWebhookAdmin, async (req, res) => {
    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const webhookUrl = req.query.url || `${publicBaseUrl}/telegram/webhook`;

    if (!webhookUrl.startsWith('https://')) {
        return res.status(400).json({ error: 'A public HTTPS webhook URL is required.' });
    }

    try {
        const result = await callTelegramApi('setWebhook', {
            url: webhookUrl,
            ...(process.env.TELEGRAM_WEBHOOK_SECRET
                ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET }
                : {})
        });
        res.json({ ok: result, webhookUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// WhatsApp Webhook endpoint
app.post('/webhook', async (req, res) => {
    const payload = req.body;

    try {
        const message = payload?.data?.body;
        const msgType = payload?.data?.type;

        if (message && msgType === 'text') {
            const spreadsheetId = process.env.Hardiksingla07_SPREADSHEET_ID;
            await processExpenseMessage(message, spreadsheetId);
        }
        // ONLY send 200 AFTER processing is complete to keep Vercel alive
        res.status(200).send('Webhook processed');
    } catch (error) {
        console.error("❌ Error processing WA webhook logic:", error);
        res.status(500).send('Internal Error');
    }
});

// Telegram Webhook endpoint
app.post('/telegram/webhook', verifyTelegramWebhook, telegramAuthMiddleware, async (req, res) => {
    const payload = req.body;
    console.log(payload);

    // return res.status(200).send('Webhook processed');

    try {
        const updateId = payload?.update_id;
        if (updateId) {
            if (processedUpdates.has(updateId)) {
                console.log(`[Idempotency] Ignoring already processed update_id: ${updateId}`);
                return res.status(200).send('Ignored: Already processed');
            }
            processedUpdates.add(updateId);
            // Keep cache size bounded
            if (processedUpdates.size > 200) {
                const first = processedUpdates.values().next().value;
                processedUpdates.delete(first);
            }
        }

        // Safe access Telegram message payload
        const msgObj = payload?.message;
        const { username, spreadsheetId } = req;
        const text = msgObj.text;
        const chatId = msgObj.chat?.id;

        if (!text) {
            return res.status(200).send('Ignored: No text');
        }

        console.log(`Processing Telegram Command: "${text}" from ${username}`);

        const pendingSplit = pendingSplitClarifications.get(String(chatId));
        if (pendingSplit && Date.now() - pendingSplit.createdAt > PENDING_SPLIT_TTL_MS) {
            pendingSplitClarifications.delete(String(chatId));
        }

        if (text === '/today') {
            const total = await getTodayTotal(spreadsheetId);
            await sendTelegramReply(chatId, `Today's Total Expenses: ₹${total.toFixed(2)}`);
        }
        else if (text === '/month') {
            const total = await getMonthTotal(spreadsheetId);
            await sendTelegramReply(chatId, `This Month's Total Expenses: ₹${total.toFixed(2)}`);
        }
        else if (text === '/budget' || text.startsWith('/budget ')) {
            const budgetInput = text.slice('/budget'.length).trim();
            if (budgetInput) {
                const result = await setMonthlyBudget(budgetInput, spreadsheetId);
                await sendTelegramReply(chatId, result.error
                    ? result.error
                    : `Monthly budget set to ₹${result.budget.toFixed(2)} for ${result.month}.`);
            } else {
                const status = await getBudgetStatus(spreadsheetId);
                if (status.error) {
                    await sendTelegramReply(chatId, status.error);
                } else if (status.budget === null) {
                    await sendTelegramReply(chatId, `No budget is set for ${status.month}. Use /budget amount, for example /budget 30000.`);
                } else {
                    const pace = status.spent > status.expectedSpend
                        ? 'You are spending faster than the calendar pace.'
                        : 'Your spending is within the calendar pace.';
                    await sendTelegramReply(chatId, `Budget for ${status.month}: ₹${status.budget.toFixed(2)}\nSpent: ₹${status.spent.toFixed(2)}\nRemaining: ₹${status.remaining.toFixed(2)}\n${pace}`);
                }
            }
        }
        else if (text === '/owed') {
            const summary = await getOwedSummary(spreadsheetId);
            if (summary.error) {
                await sendTelegramReply(chatId, summary.error);
            } else if (summary.people.length === 0) {
                await sendTelegramReply(chatId, 'There are no recorded outstanding amounts yet.');
            } else {
                const lines = summary.people.map(person => {
                    const recentReasons = person.transactions
                        .slice(-3)
                        .map(transaction => `${transaction.date}: ₹${transaction.amount.toFixed(2)} for ${transaction.reason}`)
                        .join('\n  ');
                    return `${person.name}: ₹${person.total.toFixed(2)}\n  ${recentReasons}`;
                });
                await sendTelegramReply(chatId, `Outstanding amounts: ₹${summary.total.toFixed(2)}\n\n${lines.join('\n\n')}`);
            }
        }
        else if (text === '/avg') {
            const stats = await getAveragePerDayThisMonth(spreadsheetId);
            if (!stats) {
                await sendTelegramReply(chatId, "Could not fetch the average. Please ensure Google Sheets is configured.");
            } else {
                const projected = stats.average * 30;
                const msg = `Here is your monthly summary, ${username}.\n\nSpent: ₹${stats.total.toFixed(2)} across ${stats.transactionCount} transactions.\nDaily average: ₹${stats.average.toFixed(2)} over ${stats.daysPast} days.\nProjected month-end total: ₹${projected.toFixed(2)}.`;
                await sendTelegramReply(chatId, msg);
            }
        }
        else if (text.startsWith('/overview')) {
            const args = text.split(' ');
            const targetMonth = args.length > 1 ? args.slice(1).join(' ') : null;
            const overviewStr = await getCategoryOverviewThisMonth(spreadsheetId, targetMonth);
            if (overviewStr) {
                if (overviewStr.error) {
                    await sendTelegramReply(chatId, overviewStr.error);
                } else {
                    await sendTelegramReply(chatId, overviewStr);
                }
            } else {
                await sendTelegramReply(chatId, "I could not fetch the overview. Please ensure Google Sheets is configured.");
            }
        }
        else if (text === '/undo') {
            const deletedAmount = await undoLastExpense(spreadsheetId);
            if (deletedAmount !== null) {
                await sendTelegramReply(chatId, `The last recorded expense of ₹${deletedAmount} has been removed.`);
            } else {
                await sendTelegramReply(chatId, `I could not find a recent expense to remove.`);
            }
        }
        else if (text === '/last') {
            const lastExp = await getLastExpense(spreadsheetId);
            if (lastExp) {
                await sendTelegramReply(chatId, `Most recent expense:\n₹${lastExp.amount} for ${lastExp.category}\nDate: ${lastExp.date}\nDescription: ${lastExp.description}\nAdded at: ${lastExp.addedAt}`);
            } else {
                await sendTelegramReply(chatId, `I could not find a recent expense.`);
            }
        }
        else if (text === '/start') {
            await sendTelegramReply(chatId, `Good to see you, ${username}. I am ready to keep your finances in order.\n\nTry: "150 auto rickshaw"\n\nCommands:\n/today - today's total\n/month - this month's total\n/budget 30000 - set a monthly budget\n/budget - review budget status\n/avg - daily average and projection\n/overview - category breakdown\n/last - most recent transaction\n/undo - remove the last expense\n/owed - amounts owed to you`);
        }
        else {
            let aiResult;
            const activePendingSplit = pendingSplitClarifications.get(String(chatId));
            if (activePendingSplit) {
                const completedSplit = completePendingSplit(activePendingSplit, text);
                if (completedSplit.error) {
                    await sendTelegramReply(chatId, completedSplit.error);
                    return res.status(200).send('Telegram webhook processed');
                }
                pendingSplitClarifications.delete(String(chatId));
                aiResult = await processExpenseMessage(text, spreadsheetId, completedSplit);
            } else {
                aiResult = await processExpenseMessage(text, spreadsheetId);
            }
            if (aiResult.error) {
                // LLM or Service error
                if (aiResult.pending) {
                    pendingSplitClarifications.set(String(chatId), {
                        ...aiResult.pending,
                        createdAt: Date.now()
                    });
                }
                await sendTelegramReply(chatId, `I could not complete that request: ${aiResult.error}`);
            } else if (aiResult.type === 'log') {
                const expenseData = aiResult.data;
                const owedMessage = aiResult.owed?.length
                    ? `\nOwed: ${aiResult.owed.map(entry => `${entry.name} ₹${entry.amount}`).join(', ')}`
                    : '';
                await sendTelegramReply(chatId, `Recorded ₹${expenseData.amount} for ${expenseData.category} (${expenseData.need_want}).${owedMessage}`);
            } else if (aiResult.type === 'query' || aiResult.type === 'chat') {
                await sendTelegramReply(chatId, aiResult.text);
            }
        }

        // ONLY send 200 AFTER everything, including fetch(), is fully complete so Vercel does not terminate the process.
        res.status(200).send('Telegram webhook processed');
    } catch (error) {
        console.error("Error processing telegram webhook:", error);
        res.status(500).send('Internal Error');
    }
});

app.listen(PORT, () => {
    if (!process.env.Hardiksingla07_SPREADSHEET_ID) console.warn("⚠️ Hardiksingla07_SPREADSHEET_ID is missing from .env");
    if (!process.env.TELEGRAM_BOT_TOKEN) console.warn("⚠️ TELEGRAM_BOT_TOKEN is missing from .env");
    console.log(`🚀 Webhook server is running on port ${PORT}`);
});
