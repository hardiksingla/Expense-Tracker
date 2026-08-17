require('dotenv').config();
const express = require('express');
const { processExpenseMessage, getTodayTotal, getMonthTotal, undoLastExpense, getLastExpense } = require('./expenseService');
const { telegramAuthMiddleware, verifyTelegramWebhook } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function sendTelegramReply(chatId, text) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error("Missing TELEGRAM_BOT_TOKEN to send replies");
        return;
    }
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text })
        });
    } catch (e) {
        console.error("Failed to send telegram message:", e);
    }
}

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

    try {
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
            await sendTelegramReply(chatId, `Hello ${username}! I am ready to track your expenses.\n\nSend an expense like: "150 auto rickshaw"\n\nCommands:\n/today (see today's total)\n/month (see month's total)\n/last (view last transaction)\n/undo (remove last expense)`);
        }
        else {
            const aiResult = await processExpenseMessage(text, spreadsheetId);
            if (aiResult.error) {
                // LLM or Service error
                await sendTelegramReply(chatId, `⚠️ Oops! ${aiResult.error}`);
            } else if (aiResult.type === 'log') {
                const expenseData = aiResult.data;
                await sendTelegramReply(chatId, `✅ Added Expense: ₹${expenseData.amount} for ${expenseData.category} (${expenseData.need_want}).`);
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
