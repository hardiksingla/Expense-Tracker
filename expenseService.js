const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');
const fs = require('fs');

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Setup Google Sheets auth
let sheets = null;
try {
    let auth;
    if (process.env.GOOGLE_CREDENTIALS) {
        // For Vercel/serverless environments
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    } else if (fs.existsSync('credentials.json')) {
        // For local development
        auth = new google.auth.GoogleAuth({
            keyFile: 'credentials.json',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    if (auth) {
        sheets = google.sheets({ version: 'v4', auth });
        console.log("✅ Google Sheets auth configured successfully");
    } else {
        console.warn("⚠️ No GOOGLE_CREDENTIALS env var or credentials.json found. Proceeding without Google Sheets DB writing.");
    }
} catch (error) {
    console.error("❌ Error setting up Google Sheets auth:", error.message);
}

const CATEGORIES = [
    "Food & Dining",
    "Transportation",
    "Shopping",
    "Entertainment",
    "Bills & Utilities",
    "Healthcare",
    "Housing",
    "Personal Care",
    "Education",
    "Miscellaneous"
];

const llmSchema = {
    type: "OBJECT",
    properties: {
        is_error: { type: "BOOLEAN", description: "Set to true if the message does not contain enough information to be a valid expense (e.g., missing amount) or is not an expense at all." },
        error_message: { type: "STRING", description: "If is_error is true, provide a brief message asking the user for the missing required information." },
        amount: { type: "NUMBER" },
        category: { type: "STRING", enum: CATEGORIES, description: "Must be one of the provided categories." },
        subcategory: { type: "STRING" },
        description: { type: "STRING" },
        merchant: { type: "STRING" },
        payment_method: { type: "STRING", description: "Payment method used. Default to 'UPI' if not specified." },
        need_want: { type: "STRING", enum: ["Need", "Want"], description: "Categorize if the expense is an essential 'Need' or non-essential 'Want'." },
        date: { type: "STRING", description: "YYYY-MM-DD format" },
    },
    // We make everything required but explain that if is_error is true, the LLM can provide dummy values for the other required fields like amount: 0, category: "Miscellaneous", etc.
    required: ["is_error", "error_message", "amount", "category", "subcategory", "description", "merchant", "payment_method", "need_want", "date"],
};

function getMonthSheetName(dateInput = new Date()) {
    const dateObj = new Date(dateInput);
    const monthName = dateObj.toLocaleString('default', { month: 'long' });
    const year = dateObj.getFullYear();
    return `${monthName} ${year}`;
}

async function ensureMonthlySheetExists(sheetName) {
    if (!sheets || !SPREADSHEET_ID) return;

    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName);

        if (!sheetExists) {
            console.log(`Creating new sheet for month: ${sheetName}...`);
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                requestBody: {
                    requests: [{
                        addSheet: { properties: { title: sheetName } }
                    }]
                }
            });

            // Order of headers: Date, Amount, Category, Subcategory, Merchant, Description, Payment Method, Need/Want, AddedAt
            const headers = [["Date", "Amount", "Category", "Subcategory", "Merchant", "Description", "Payment Method", "Need/Want", "AddedAt"]];

            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A1:I1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: headers }
            });
            console.log(`✅ Successfully initialized sheet: ${sheetName}`);
        }
    } catch (error) {
        console.error(`❌ Error checking/creating monthly sheet:`, error.message);
    }
}

async function processExpenseMessage(message) {
    const todayIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const prompt = `Evaluate the following message: "${message}". If it is a valid expense description containing at least a discernible amount, extract the details precisely. If it is NOT an expense or is missing an amount, set "is_error" to true and populate "error_message" with a short friendly response explaining what is missing. Fill in dummy data (e.g. amount: 0) for the other fields if is_error is true. Assume current year/context if not specified (today is ${todayIST} Indian Standard Time). Unless explicitly mentioned, set payment_method to "UPI". Deduce "need_want" logically based on the nature of the expense.`;

    console.log(`[DEBUG] Calling Gemini API...`);

    let expenseData;
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: llmSchema,
            }
        });
        console.log(`[DEBUG] Gemini API returned successfully!`);

        const parsedText = response.text;
        expenseData = JSON.parse(parsedText);
    } catch (apiError) {
        console.error(`[DEBUG] ❌ Gemini API threw an error/hung up:`, apiError);
        return { error: `API Connection Failed: ${apiError.message}. Check if your model name is valid.` };
    }

    if (expenseData.is_error) {
        console.log(`⚠️ Blocked invalid expense due to missing info: ${expenseData.error_message}`);
        return { error: expenseData.error_message };
    }

    const d = new Date();
    const datePart = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const timePart = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });
    const addedAtTime = `${datePart} ${timePart}`;

    console.log("🧠 Parsed Expense Data from Gemini:", JSON.stringify(expenseData, null, 2));

    if (sheets && SPREADSHEET_ID) {
        const sheetName = getMonthSheetName(expenseData.date);
        await ensureMonthlySheetExists(sheetName);

        const values = [[
            expenseData.date,
            expenseData.amount,
            expenseData.category,
            expenseData.subcategory,
            expenseData.merchant,
            expenseData.description,
            expenseData.payment_method,
            expenseData.need_want,
            addedAtTime
        ]];

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!A:I`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });
    }

    return expenseData;
}

async function getTodayTotal() {
    if (!sheets) return 0;
    const sheetName = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: sheetName }).catch(() => null);
    if (!response || !response.data.values) return 0;

    const localToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    let total = 0;
    const rows = response.data.values;
    for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === localToday) {
            total += parseFloat(rows[i][1]) || 0;
        }
    }
    return total;
}

async function getMonthTotal() {
    if (!sheets) return 0;
    const sheetName = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: sheetName }).catch(() => null);
    if (!response || !response.data.values) return 0;

    let total = 0;
    const rows = response.data.values;
    for (let i = 1; i < rows.length; i++) {
        total += parseFloat(rows[i][1]) || 0;
    }
    return total;
}

async function getLastExpense() {
    if (!sheets || !SPREADSHEET_ID) return null;
    const sheetName = getMonthSheetName();
    try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: sheetName }).catch(() => null);
        if (!response || !response.data.values) return null;

        const rows = response.data.values;
        if (rows.length <= 1) return null;

        let maxRowIndex = -1;
        let maxDate = 0;
        let lastRow = null;

        for (let i = 1; i < rows.length; i++) {
            const addedAtStr = rows[i][8];
            if (addedAtStr) {
                let ms = new Date(addedAtStr).getTime();
                if (isNaN(ms)) ms = new Date(addedAtStr.replace(' ', 'T')).getTime();

                if (ms > maxDate) {
                    maxDate = ms;
                    maxRowIndex = i;
                    lastRow = rows[i];
                }
            }
        }

        if (lastRow) {
            // [Date, Amount, Category, Subcategory, Merchant, Description, Payment Method, Need/Want, AddedAt]
            return {
                date: lastRow[0],
                amount: lastRow[1],
                category: lastRow[2],
                description: lastRow[5],
                addedAt: lastRow[8]
            };
        }
        return null;
    } catch (e) {
        console.error(e);
        return null;
    }
}

async function undoLastExpense() {
    if (!sheets || !SPREADSHEET_ID) return null;
    const sheetName = getMonthSheetName();
    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheet = spreadsheetInfo.data.sheets.find(s => s.properties.title === sheetName);
        if (!sheet) return null;
        const sheetId = sheet.properties.sheetId;

        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: sheetName });
        const rows = response.data.values || [];
        if (rows.length <= 1) return null; // No data rows

        let maxRowIndex = -1;
        let maxDate = 0;
        let deletedAmount = 0;

        for (let i = 1; i < rows.length; i++) {
            const addedAtStr = rows[i][8];
            if (addedAtStr) {
                let ms = new Date(addedAtStr).getTime();
                if (isNaN(ms)) ms = new Date(addedAtStr.replace(' ', 'T')).getTime();

                if (ms > maxDate) {
                    maxDate = ms;
                    maxRowIndex = i;
                    deletedAmount = rows[i][1];
                }
            }
        }

        if (maxRowIndex === -1) {
            maxRowIndex = rows.length - 1;
            deletedAmount = rows[maxRowIndex][1];
        }

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetId: sheetId,
                            dimension: "ROWS",
                            startIndex: maxRowIndex,
                            endIndex: maxRowIndex + 1
                        }
                    }
                }]
            }
        });
        return deletedAmount;
    } catch (e) {
        console.error(e);
        return null;
    }
}

module.exports = {
    processExpenseMessage,
    getTodayTotal,
    getMonthTotal,
    undoLastExpense,
    getLastExpense
};
