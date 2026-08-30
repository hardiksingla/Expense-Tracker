const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');
const fs = require('fs');

// Initialize Gemini keys list
const GEMINI_API_KEYS = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.split(',').map(k => k.trim()).filter(Boolean) : [];

function getRandomGeminiKey() {
    if (GEMINI_API_KEYS.length === 0) return null;
    return GEMINI_API_KEYS[Math.floor(Math.random() * GEMINI_API_KEYS.length)];
}
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

const geminiTools = [{
    functionDeclarations: [
        {
            name: "logExpense",
            description: "Logs a new expense. Use this tool if the user provides a transaction or an expense to record. Generate dummy values if is_error is true. If the user mentions earning money (or uses a negative amount), the logged amount must be a negative number.",
            parameters: {
                type: "OBJECT",
                properties: {
                    is_error: { type: "BOOLEAN", description: "Set to true if there is missing vital information to log the expense, like amount." },
                    error_message: { type: "STRING", description: "Friendly message asking for the missing info if is_error is true." },
                    amount: { type: "NUMBER" },
                    category: { type: "STRING", enum: CATEGORIES, description: "Must be one of the provided categories." },
                    subcategory: { type: "STRING" },
                    description: { type: "STRING" },
                    merchant: { type: "STRING" },
                    payment_method: { type: "STRING", description: "Default to 'UPI' if unspecified." },
                    need_want: { type: "STRING", enum: ["Need", "Want"] },
                    date: { type: "STRING", description: "YYYY-MM-DD format" },
                },
                required: ["is_error", "error_message", "amount", "category", "subcategory", "description", "merchant", "payment_method", "need_want", "date"],
            }
        },
        {
            name: "queryExpenses",
            description: "Queries past expenses for a specific timeframe. Use this when the user asks questions like 'how much did I spend on food this week?'.",
            parameters: {
                type: "OBJECT",
                properties: {
                    startDate: { type: "STRING", description: "YYYY-MM-DD" },
                    endDate: { type: "STRING", description: "YYYY-MM-DD" },
                    category: { type: "STRING", description: "Optional category to filter by", enum: CATEGORIES }
                },
                required: ["startDate", "endDate"]
            }
        }
    ]
}];

function getMonthSheetName(dateInput = new Date()) {
    const dateObj = new Date(dateInput);
    const monthName = dateObj.toLocaleString('default', { month: 'long' });
    const year = dateObj.getFullYear();
    return `${monthName} ${year}`;
}

async function ensureMonthlySheetExists(sheetName, spreadsheetId) {
    if (!sheets || !spreadsheetId) return;

    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId });
        const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName);

        if (!sheetExists) {
            console.log(`Creating new sheet for month: ${sheetName}...`);
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: { properties: { title: sheetName } }
                    }]
                }
            });

            // Order of headers: Date, Amount, Category, Subcategory, Merchant, Description, Payment Method, Need/Want, AddedAt, Cumulative Total
            const headers = [["Date", "Amount", "Category", "Subcategory", "Merchant", "Description", "Payment Method", "Need/Want", "AddedAt", "Cumulative Total"]];

            await sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: `${sheetName}!A1:J1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: headers }
            });
            console.log(`✅ Successfully initialized sheet: ${sheetName}`);
        }
    } catch (error) {
        console.error(`❌ Error checking/creating monthly sheet:`, error.message);
    }
}

async function processExpenseMessage(message, spreadsheetId) {
    const todayIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const prompt = `Evaluate the following message: "${message}". Decide if the user wants to log an expense or query past expenses. If it's a logging request, call the logExpense tool. If the user mentions earning money or provides a negative value, treat it as income and ensure the amount passed to logExpense is negative. If it's a query for past spending, call the queryExpenses tool. If they are just saying hi or chatting or the input is invalid, just respond conversationally to them without calling tools. Assume current context if not specified (today is ${todayIST} Indian Standard Time). Unless explicitly mentioned, set payment_method to "UPI". Deduce "need_want" logically.`;

    console.log(`[DEBUG] Calling Gemini API...`);

    let resultPayload = null;
    let success = false;
    let attempts = 0;
    const maxAttempts = GEMINI_API_KEYS.length > 0 ? Math.min(GEMINI_API_KEYS.length + 1, 3) : 1;
    let lastError = null;

    while (!success && attempts < maxAttempts) {
        attempts++;
        const apiKey = GEMINI_API_KEYS.length > 0 ? getRandomGeminiKey() : process.env.GEMINI_API_KEY;

        if (!apiKey) {
            console.error(`[DEBUG] ❌ No Gemini API Key found in environment variables.`);
            return { error: `Server Configuration Error: Missing API Key.` };
        }

        const ai = new GoogleGenAI({ apiKey: apiKey });

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                config: {
                    tools: geminiTools
                }
            });
            console.log(`[DEBUG] Gemini API returned successfully on attempt ${attempts}!`);

            const functionCall = response.functionCalls?.[0];

            if (functionCall) {
                if (functionCall.name === "logExpense") {
                    resultPayload = { type: 'log', data: functionCall.args };
                    success = true;
                } else if (functionCall.name === "queryExpenses") {
                    // Execute Query
                    const queryArgs = functionCall.args;
                    const queryResult = await queryExpenses(queryArgs.startDate, queryArgs.endDate, queryArgs.category, spreadsheetId);

                    // Call Gemini again to construct final message
                    const followupResponse = await ai.models.generateContent({
                        model: 'gemini-3.6-flash',
                        contents: [
                            { role: "user", parts: [{ text: prompt }] },
                            response.candidates[0].content,
                            { role: "user", parts: [{ functionResponse: { name: functionCall.name, response: queryResult } }] }
                        ]
                    });

                    resultPayload = { type: 'query', text: followupResponse.text };
                    success = true;
                }
            } else {
                // If the model didn't call a tool, it likely means invalid request or casual chat
                resultPayload = { type: 'chat', text: response.text };
                success = true;
            }
        } catch (apiError) {
            lastError = apiError;
            console.error(`[DEBUG] ❌ Gemini API threw an error on attempt ${attempts}:`, apiError.message);

            const isRateLimit = apiError.status === 429 ||
                (apiError.message && (apiError.message.includes('429') || apiError.message.includes('Too Many Requests') || apiError.message.includes('quota')));

            if (isRateLimit && attempts < maxAttempts) {
                console.log(`⚠️ 429 error encountered limit hit. Retrying with another key...`);
            } else {
                break;
            }
        }
    }

    if (!success) {
        return { error: `API Connection Failed: ${lastError?.message}. Check if your model name is valid.` };
    }

    // Process the result if it was a logging request
    if (resultPayload.type === 'log') {
        const expenseData = resultPayload.data;

        if (expenseData.is_error) {
            console.log(`⚠️ Blocked invalid expense due to missing info: ${expenseData.error_message}`);
            return { error: expenseData.error_message };
        }

        const d = new Date();
        const datePart = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const timePart = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });
        const addedAtTime = `${datePart} ${timePart}`;

        console.log("🧠 Parsed Expense Data from Gemini:", JSON.stringify(expenseData, null, 2));

        if (sheets && spreadsheetId) {
            const sheetName = getMonthSheetName(expenseData.date);
            await ensureMonthlySheetExists(sheetName, spreadsheetId);

            const values = [[
                expenseData.date,
                expenseData.amount,
                expenseData.category,
                expenseData.subcategory,
                expenseData.merchant,
                expenseData.description,
                expenseData.payment_method,
                expenseData.need_want,
                addedAtTime,
                `=SUM($B$2:INDIRECT("B"&ROW()))`
            ]];

            await sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: `${sheetName}!A:J`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values }
            });
        }

        return { type: 'log', data: expenseData };
    }

    // Pass through query or chat results
    return resultPayload;
}

async function getTodayTotal(spreadsheetId) {
    if (!sheets) return 0;
    const sheetName = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
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

async function getMonthTotal(spreadsheetId) {
    if (!sheets) return 0;
    const sheetName = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
    if (!response || !response.data.values) return 0;

    let total = 0;
    const rows = response.data.values;
    for (let i = 1; i < rows.length; i++) {
        total += parseFloat(rows[i][1]) || 0;
    }
    return total;
}

async function getAveragePerDayThisMonth(spreadsheetId) {
    const total = await getMonthTotal(spreadsheetId);
    if (total === 0) return 0;

    const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const daysPast = todayIST.getDate();

    return daysPast > 0 ? total / daysPast : 0;
}

async function queryExpenses(startDate, endDate, category, spreadsheetId) {
    if (!sheets) return { error: "Google Sheets not configured." };

    // Convert strings to date objects for comparison
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start) || isNaN(end)) return { error: "Invalid date format." };

    let current = new Date(start);
    const monthsToFetch = new Set();
    while (current <= end) {
        monthsToFetch.add(getMonthSheetName(current));
        current.setMonth(current.getMonth() + 1);
    }
    // Also add the end date's month just in case
    monthsToFetch.add(getMonthSheetName(end));

    let totalAmount = 0;
    let transactions = [];

    // Try fetching every relevant month sheet
    for (const sheetName of monthsToFetch) {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName }).catch(() => null);
        if (!response || !response.data.values) continue;

        const rows = response.data.values;
        for (let i = 1; i < rows.length; i++) { // Skip headers
            const dateStr = rows[i][0];
            const amount = parseFloat(rows[i][1]) || 0;
            const rCategory = rows[i][2];

            const rDate = new Date(dateStr);
            if (rDate >= start && rDate <= end) {
                if (!category || rCategory === category) {
                    totalAmount += amount;
                    transactions.push({
                        date: dateStr,
                        amount: amount,
                        category: rCategory,
                        subcategory: rows[i][3],
                        merchant: rows[i][4],
                        description: rows[i][5],
                    });
                }
            }
        }
    }

    return {
        totalAmount,
        transactionCount: transactions.length,
        timeframe: `${startDate} to ${endDate}`
    };
}

async function getLastExpense(spreadsheetId) {
    if (!sheets || !spreadsheetId) return null;
    const sheetName = getMonthSheetName();
    try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
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

async function undoLastExpense(spreadsheetId) {
    if (!sheets || !spreadsheetId) return null;
    const sheetName = getMonthSheetName();
    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId });
        const sheet = spreadsheetInfo.data.sheets.find(s => s.properties.title === sheetName);
        if (!sheet) return null;
        const sheetId = sheet.properties.sheetId;

        const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName });
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
            spreadsheetId: spreadsheetId,
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
    getAveragePerDayThisMonth,
    undoLastExpense,
    getLastExpense
};
