const verifyTelegramWebhook = (req, res, next) => {
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
    console.log('Secret Token:', secretToken);
    console.log('Received Token:', req.headers['x-telegram-bot-api-secret-token']);
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

const telegramAuthMiddleware = (req, res, next) => {
    const payload = req.body;
    const msgObj = payload?.message;
    if (!msgObj) {
        return res.status(200).send('Ignored: No message object');
    }

    const username = msgObj.from?.username;
    if (!username) {
        return res.status(200).send('Ignored: No username');
    }

    const spreadsheetId = process.env[`${username}_SPREADSHEET_ID`];

    if (!spreadsheetId) {
        console.log(`Ignored message: No spreadsheet ID found for user: ${username}`);
        return res.status(200).send('Ignored: Unauthorized');
    }

    req.spreadsheetId = spreadsheetId;
    req.username = username;
    next();
};

module.exports = {
    telegramAuthMiddleware,
    verifyTelegramWebhook
};
