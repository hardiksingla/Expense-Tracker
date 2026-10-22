const { User } = require('./models');
const mongoose = require('mongoose');

const verifyTelegramWebhook = (req, res, next) => {
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;

    // If a secret token is configured in .env, enforce it
    if (secretToken) {
        const receivedToken = req.headers['x-telegram-bot-api-secret-token'];
        if (receivedToken !== secretToken) {
            console.error('Unauthorized request blocked: Invalid Telegram Secret Token');
            return res.status(403).send('Forbidden');
        }
    }
    next();
};

const telegramAuthMiddleware = async (req, res, next) => {
    const payload = req.body;
    const msgObj = payload?.message;
    if (!msgObj) {
        return res.status(200).send('Ignored: No message object');
    }

    const username = msgObj.from?.username;
    const chatId = msgObj.chat?.id;

    if (!chatId) {
        return res.status(200).send('Ignored: No chatId');
    }

    let spreadsheetId = undefined;
    let bikeSpreadsheetId = undefined;

    // Try finding the user in DB only if connected, otherwise fallback immediately to .env
    if (mongoose.connection.readyState === 1) {
        try {
            const user = await User.findOneAndUpdate(
                { chatId },
                {
                    $inc: { messageCount: 1 },
                    $setOnInsert: { username, createdAt: new Date() }
                },
                { upsert: true, new: true, maxTimeMS: 3000 }
            );
            if (user) {
                if (user.spreadsheetId) spreadsheetId = user.spreadsheetId;
                if (user.bikeSpreadsheetId) bikeSpreadsheetId = user.bikeSpreadsheetId;
            }
        } catch (e) {
            console.error("DB Error finding user:", e.message);
        }
    } else {
        console.warn("⚠️ MongoDB not connected yet (readyState != 1). Falling back to .env.");
    }

    // Fallback to .env for legacy users if not in DB
    if (!spreadsheetId && username) {
        const targetKey = `${username}_SPREADSHEET_ID`.toLowerCase();
        const foundKey = Object.keys(process.env).find(k => k.toLowerCase() === targetKey);
        if (foundKey) {
            spreadsheetId = process.env[foundKey];
        }
    }
    if (!spreadsheetId && process.env.SPREADSHEET_ID) {
        spreadsheetId = process.env.SPREADSHEET_ID;
    }

    // Resolve bikeSpreadsheetId from .env if not found in DB
    if (!bikeSpreadsheetId && username) {
        const targetBikeKey = `${username}_BIKE_SPREADSHEET_ID`.toLowerCase();
        const foundBikeKey = Object.keys(process.env).find(k => k.toLowerCase() === targetBikeKey);
        if (foundBikeKey) {
            bikeSpreadsheetId = process.env[foundBikeKey];
        }
    }
    if (!bikeSpreadsheetId && process.env.BIKE_SPREADSHEET_ID) {
        bikeSpreadsheetId = process.env.BIKE_SPREADSHEET_ID;
    }

    req.spreadsheetId = spreadsheetId;
    req.bikeSpreadsheetId = bikeSpreadsheetId;
    req.username = username || 'User';
    req.chatId = chatId;
    next();
};

module.exports = {
    telegramAuthMiddleware,
    verifyTelegramWebhook
};
