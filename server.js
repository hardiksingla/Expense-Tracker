require('dotenv').config();
const express = require('express');
const { processExpenseMessage, getTodayTotal, getMonthTotal, getAveragePerDayThisMonth, getCategoryOverviewThisMonth, undoLastExpense, getLastExpense } = require('./expenseService');
const { telegramAuthMiddleware, verifyTelegramWebhook } = require('./telegramMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_ADMIN_TOKEN = process.env.WEBHOOK_ADMIN_TOKEN;

app.use(express.json());

// Idempotency cache: store recently processed update IDs
const processedUpdates = new Set();
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
        .replace(/__/g, '');
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

        if (text === '/today') {
            const total = await getTodayTotal(spreadsheetId);
            await sendTelegramReply(chatId, `Today's Total Expenses: ₹${total.toFixed(2)}`);
        }
        else if (text === '/month') {
            const total = await getMonthTotal(spreadsheetId);
            await sendTelegramReply(chatId, `This Month's Total Expenses: ₹${total.toFixed(2)}`);
        }
        else if (text === '/avg') {
            const stats = await getAveragePerDayThisMonth(spreadsheetId);
            if (!stats) {
                await sendTelegramReply(chatId, "⚠️ Could not fetch average. Ensure Google Sheets is configured.");
            } else {
                const projected = stats.average * 30;
                const msg = `Your total expenses for this month (${stats.monthName} 1 to ${stats.monthName} ${stats.daysPast}, ${stats.year}) are **₹${stats.total.toFixed(2)}** across ${stats.transactionCount} transactions.\n\nOver the ${stats.daysPast} days so far, your average daily expense is **₹${stats.average.toFixed(2)} per day**.\n\nProjected Monthly Total: **₹${projected.toFixed(2)}**`;
                await sendTelegramReply(chatId, msg);
            }
        }
        else if (text.startsWith('/overview')) {
            const args = text.split(' ');
            const targetMonth = args.length > 1 ? args.slice(1).join(' ') : null;
            const overviewStr = await getCategoryOverviewThisMonth(spreadsheetId, targetMonth);
            if (overviewStr) {
                if (overviewStr.error) {
                    await sendTelegramReply(chatId, `⚠️ ${overviewStr.error}`);
                } else {
                    await sendTelegramReply(chatId, overviewStr);
                }
            } else {
                await sendTelegramReply(chatId, "⚠️ Could not fetch overview. Ensure Google Sheets is configured.");
            }
        }
        else if (text === '/undo') {
            const deletedAmount = await undoLastExpense(spreadsheetId);
            if (deletedAmount !== null) {
                await sendTelegramReply(chatId, `↩️ Undid the last recorded expense of ₹${deletedAmount}.`);
            } else {
                await sendTelegramReply(chatId, `⚠️ Could not find anything to undo.`);
            }
        }
        else if (text === '/last') {
            const lastExp = await getLastExpense(spreadsheetId);
            if (lastExp) {
                await sendTelegramReply(chatId, `🕒 Last Expense:\n₹${lastExp.amount} for ${lastExp.category}\nDate: ${lastExp.date}\nDescription: ${lastExp.description}\nAdded At: ${lastExp.addedAt}`);
            } else {
                await sendTelegramReply(chatId, `⚠️ No recent expenses found.`);
            }
        }
        else if (text === '/start') {
            await sendTelegramReply(chatId, `Hello ${username}! I am ready to track your expenses.\n\nSend an expense like: "150 auto rickshaw"\n\nCommands:\n/today (see today's total)\n/month (see month's total)\n/avg (see month's average per day)\n/overview (category breakdown)\n/last (view last transaction)\n/undo (remove last expense)`);
        }
        else {
            const aiResult = await processExpenseMessage(text, spreadsheetId);
            if (aiResult.error) {
                // LLM or Service error
                await sendTelegramReply(chatId, `⚠️ Oops! ${aiResult.error}`);
            } else if (aiResult.type === 'log') {
                const expenseData = aiResult.data;
                const owedMessage = aiResult.owed?.length
                    ? `\nOwed: ${aiResult.owed.map(entry => `${entry.name} ₹${entry.amount}`).join(', ')}`
                    : '';
                await sendTelegramReply(chatId, `✅ Added Expense: ₹${expenseData.amount} for ${expenseData.category} (${expenseData.need_want}).${owedMessage}`);
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
