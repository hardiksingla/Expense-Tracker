const { User } = require('./models');

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

    // Try finding the user in DB and incrementing message count
    try {
        const user = await User.findOneAndUpdate(
            { chatId },
            {
                $inc: { messageCount: 1 },
                $setOnInsert: { username, createdAt: new Date() }
            },
            { upsert: true, new: true }
        );
        if (user && user.spreadsheetId) {
            spreadsheetId = user.spreadsheetId;
        }
    } catch (e) {
        console.error("DB Error finding user:", e);
    }

    // Fallback to .env for legacy users if not in DB
    if (!spreadsheetId && username) {
        const targetKey = `${username}_SPREADSHEET_ID`.toLowerCase();
        const foundKey = Object.keys(process.env).find(k => k.toLowerCase() === targetKey);
        if (foundKey) {
            spreadsheetId = process.env[foundKey];
        }
    }

    req.spreadsheetId = spreadsheetId;
    req.username = username || 'User';
    req.chatId = chatId;
    next();
};

module.exports = {
    telegramAuthMiddleware,
    verifyTelegramWebhook
};
