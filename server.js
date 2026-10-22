const dns = require('dns');
try { dns.setServers(['8.8.8.8', '8.8.4.4']); } catch (_) {}
require('dotenv').config();
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { connectDB, User } = require('./models');
connectDB();
const { processExpenseMessage, getTodayTotal, getMonthTotal, getAveragePerDayThisMonth, getCategoryOverviewThisMonth, undoLastExpense, getLastExpense, getAllExpenses, verifySpreadsheetAccess, refreshFuelPrices, ensureBikeSheetsExist } = require('./expenseService');
const { telegramAuthMiddleware, verifyTelegramWebhook } = require('./telegramMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-demo-key';

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
        const { username, spreadsheetId, bikeSpreadsheetId } = req;
        const text = msgObj.text;
        const chatId = req.chatId || msgObj.chat?.id;

        if (!text) {
            return res.status(200).send('Ignored: No text');
        }

        console.log(`Processing Telegram Command: "${text}" from ${username}`);

        if (text === '/start') {
            await sendTelegramReply(chatId, `Hello ${username}! Welcome to your personal expense tracker. 📊\n\nTo get started with personal expenses:\n1. Create a new Google Sheet.\n2. Share it as an **Editor** with our service bot:\nsheet-bot@hazel-charter-505618-s2.iam.gserviceaccount.com\n3. Copy the URL of the Google Sheet and send it to me here.\n\n🏍️ **Triumph Speed 400 Motorcycle Tracker**:\nTo track fuel, maintenance, and bike observations, share a dedicated Google Sheet with the bot and send:\n/bikesheet <Google Sheet URL>\n\nOnce done, you can start logging expenses immediately!`);
            return res.status(200).send('Telegram webhook processed');
        }

        if (text.startsWith('/bikesheet') || text.startsWith('/bike_sheet')) {
            const match = text.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
            if (!match) {
                await sendTelegramReply(chatId, `⚠️ Please provide a valid Google Sheet URL. Example:\n/bikesheet https://docs.google.com/spreadsheets/d/your-sheet-id`);
                return res.status(200).send('Telegram webhook processed');
            }
            const newBikeSpreadsheetId = match[1];

            const hasAccess = await verifySpreadsheetAccess(newBikeSpreadsheetId);
            if (!hasAccess) {
                await sendTelegramReply(chatId, `⚠️ I couldn't access that Google Sheet. Please make sure you have shared it with:\nsheet-bot@hazel-charter-505618-s2.iam.gserviceaccount.com\nas an **Editor** and try sending the link again.`);
                return res.status(200).send('Telegram webhook processed');
            }

            await User.findOneAndUpdate(
                { chatId },
                { username, bikeSpreadsheetId: newBikeSpreadsheetId },
                { upsert: true, returnDocument: 'after' }
            );
            await ensureBikeSheetsExist(newBikeSpreadsheetId);
            await sendTelegramReply(chatId, `🏍️ Success! Linked your Triumph Speed 400 bike tracker.\nWorksheets 'BikeExpenses' and 'FuelPrices' are configured.\nYou can now log fuel refills (e.g., "500 petrol odo 1200"), service expenses, or observations!`);
            return res.status(200).send('Telegram webhook processed');
        }

        if (text === '/sheets' || text === '/status') {
            const expMsg = spreadsheetId ? `✅ Linked (\`${spreadsheetId}\`)` : `❌ Not linked (send sheet link or /expensesheet <URL>)`;
            const bikeMsg = bikeSpreadsheetId ? `✅ Linked (\`${bikeSpreadsheetId}\`)` : `❌ Not linked (send /bikesheet <URL>)`;
            await sendTelegramReply(chatId, `📊 **Your Configured Spreadsheets**:\n\n1️⃣ **Personal Expenses Sheet**:\n${expMsg}\n\n2️⃣ **Triumph Speed 400 Bike Sheet**:\n${bikeMsg}\n\n💡 **How to link or change**:\n• Personal expenses: \`/expensesheet <Google Sheet URL>\` (or paste link)\n• Bike tracker: \`/bikesheet <Google Sheet URL>\``);
            return res.status(200).send('Telegram webhook processed');
        }

        if (text.startsWith('/expensesheet') || text.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)) {
            const match = text.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
            if (!match) {
                await sendTelegramReply(chatId, `⚠️ Please provide a valid Google Sheet URL. Example:\n/expensesheet https://docs.google.com/spreadsheets/d/your-sheet-id`);
                return res.status(200).send('Telegram webhook processed');
            }
            const newSpreadsheetId = match[1];

            const hasAccess = await verifySpreadsheetAccess(newSpreadsheetId);
            if (!hasAccess) {
                await sendTelegramReply(chatId, `⚠️ I couldn't access that Google Sheet. Please make sure you have shared it with:\nsheet-bot@hazel-charter-505618-s2.iam.gserviceaccount.com\nas an **Editor** and try sending the link again.`);
                return res.status(200).send('Telegram webhook processed');
            }

            await User.findOneAndUpdate(
                { chatId },
                { username, spreadsheetId: newSpreadsheetId },
                { upsert: true, returnDocument: 'after' }
            );
            await sendTelegramReply(chatId, `🎉 Success! Linked your Personal Expense Sheet.\nYou can now start logging expenses directly by typing them (e.g., "150 lunch").`);
            return res.status(200).send('Telegram webhook processed');
        }

        if (!spreadsheetId && !bikeSpreadsheetId) {
            await sendTelegramReply(chatId, `⚠️ You haven't set up your Google Sheet yet. Type /start for instructions.`);
            return res.status(200).send('Ignored: No spreadsheet setup');
        }

        if (text === '/today') {
            if (!spreadsheetId) {
                await sendTelegramReply(chatId, `⚠️ You haven't linked a personal expense sheet yet. Send your Google Sheet link or /expensesheet <URL> to set it up.`);
                return res.status(200).send('Telegram webhook processed');
            }
            const total = await getTodayTotal(spreadsheetId);
            await sendTelegramReply(chatId, `Today's Total Expenses: ₹${total.toFixed(2)}`);
        }
        else if (text === '/month') {
            if (!spreadsheetId) {
                await sendTelegramReply(chatId, `⚠️ You haven't linked a personal expense sheet yet. Send your Google Sheet link or /expensesheet <URL> to set it up.`);
                return res.status(200).send('Telegram webhook processed');
            }
            const total = await getMonthTotal(spreadsheetId);
            await sendTelegramReply(chatId, `This Month's Total Expenses: ₹${total.toFixed(2)}`);
        }
        else if (text === '/avg') {
            if (!spreadsheetId) {
                await sendTelegramReply(chatId, `⚠️ You haven't linked a personal expense sheet yet. Send your Google Sheet link or /expensesheet <URL> to set it up.`);
                return res.status(200).send('Telegram webhook processed');
            }
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
            if (!spreadsheetId) {
                await sendTelegramReply(chatId, `⚠️ You haven't linked a personal expense sheet yet. Send your Google Sheet link or /expensesheet <URL> to set it up.`);
                return res.status(200).send('Telegram webhook processed');
            }
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
            if (!spreadsheetId) {
                await sendTelegramReply(chatId, `⚠️ You haven't linked a personal expense sheet yet. Send your Google Sheet link or /expensesheet <URL> to set it up.`);
                return res.status(200).send('Telegram webhook processed');
            }
            const deletedAmount = await undoLastExpense(spreadsheetId);
            if (deletedAmount !== null) {
                await sendTelegramReply(chatId, `↩️ Undid the last recorded expense of ₹${deletedAmount}.`);
            } else {
                await sendTelegramReply(chatId, `⚠️ Could not find anything to undo.`);
            }
        }
        else if (text === '/last') {
            if (!spreadsheetId) {
                await sendTelegramReply(chatId, `⚠️ You haven't linked a personal expense sheet yet. Send your Google Sheet link or /expensesheet <URL> to set it up.`);
                return res.status(200).send('Telegram webhook processed');
            }
            const lastExp = await getLastExpense(spreadsheetId);
            if (lastExp) {
                await sendTelegramReply(chatId, `🕒 Last Expense:\n₹${lastExp.amount} for ${lastExp.category}\nDate: ${lastExp.date}\nDescription: ${lastExp.description}\nAdded At: ${lastExp.addedAt}`);
            } else {
                await sendTelegramReply(chatId, `⚠️ No recent expenses found.`);
            }
        }
        else if (text === '/dashboard') {
            if (!spreadsheetId) {
                await sendTelegramReply(chatId, `⚠️ You haven't linked a personal expense sheet yet. Send your Google Sheet link or /expensesheet <URL> to set it up.`);
                return res.status(200).send('Telegram webhook processed');
            }
            const token = jwt.sign({ spreadsheetId, username }, JWT_SECRET, { expiresIn: '7d' });
            // Try to figure out current host
            const host = req.get('host');
            const protocol = req.protocol === 'https' || req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
            const magicLink = `${protocol}://${host}/?token=${token}`;
            await sendTelegramReply(chatId, `🎨 Here is your magic link to the dashboard (valid for 7 days):\n${magicLink}`);
        }
        else if (text === '/refreshfuel' || text === '/refreshfuelprices') {
            if (!bikeSpreadsheetId) {
                await sendTelegramReply(chatId, `⚠️ No bike spreadsheet configured. Link one with /bikesheet <Google Sheet URL>.`);
                return res.status(200).send('Telegram webhook processed');
            }
            const result = await refreshFuelPrices(bikeSpreadsheetId);
            if (result.error) {
                await sendTelegramReply(chatId, `⚠️ Error refreshing fuel prices: ${result.error}`);
            } else {
                const lines = result.prices.map(p => `• ${p.original_name || p.fuel_name}: ₹${p.price_per_litre.toFixed(2)}/L${p.is_default ? ' (Default)' : ''}${p.active ? '' : ' [Inactive]'}`);
                await sendTelegramReply(chatId, `⛽ Fuel prices refreshed from sheet:\n${lines.join('\n')}`);
            }
        }
        else {
            const aiResult = await processExpenseMessage(text, spreadsheetId, {
                chatId,
                sendTelegramReply,
                bikeSpreadsheetId,
                messageId: msgObj.message_id
            });
            if (aiResult.error) {
                // LLM or Service error
                await sendTelegramReply(chatId, `⚠️ Oops! ${aiResult.error}`);
            } else if (aiResult.finalReply) {
                await sendTelegramReply(chatId, aiResult.finalReply);
            }
        }

        // ONLY send 200 AFTER everything, including fetch(), is fully complete so Vercel does not terminate the process.
        res.status(200).send('Telegram webhook processed');
    } catch (error) {
        console.error("Error processing telegram webhook:", error);
        res.status(500).send('Internal Error');
    }
});

// Middleware for checking JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// API endpoint for dashboard data
app.get('/api/dashboard/data', authenticateToken, async (req, res) => {
    try {
        const { spreadsheetId } = req.user;
        const { start, end } = req.query;
        const data = await getAllExpenses(spreadsheetId, start, end);
        res.json(data);
    } catch (err) {
        console.error("Dashboard data error:", err);
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

app.listen(PORT, () => {
    if (!process.env.Hardiksingla07_SPREADSHEET_ID) console.warn("⚠️ Hardiksingla07_SPREADSHEET_ID is missing from .env");
    if (!process.env.TELEGRAM_BOT_TOKEN) console.warn("⚠️ TELEGRAM_BOT_TOKEN is missing from .env");
    console.log(`🚀 Webhook server is running on port ${PORT}`);
});

module.exports = app;

