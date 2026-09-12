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

async function ensureOwedSheetExists(spreadsheetId) {
    if (!sheets || !spreadsheetId) return;

    const sheetName = 'Owed';
    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName);

        if (!sheetExists) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{ addSheet: { properties: { title: sheetName } } }]
                }
            });

            const headers = [[
                'Date', 'Name', 'Amount Owed', 'Expense Amount', 'Description', 'AddedAt', 'Total Owed By Person', 'Reason / Note'
            ]];
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A1:H1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: headers }
            });
        } else {
            const headerResponse = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetName}!A1:H1`
            });
            const headers = headerResponse.data.values?.[0] || [];
            if (headers[7] !== 'Reason / Note') {
                await sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${sheetName}!H1`,
                    valueInputOption: 'RAW',
                    requestBody: { values: [['Reason / Note']] }
                });
            }
        }
    } catch (error) {
        console.error('❌ Error checking/creating Owed sheet:', error.message);
    }
}

async function ensureBudgetSheetExists(spreadsheetId) {
    if (!sheets || !spreadsheetId) return false;

    const sheetName = 'Budget';
    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName);
        if (!sheetExists) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{ addSheet: { properties: { title: sheetName } } }]
                }
            });
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A1:C1`,
                valueInputOption: 'RAW',
                requestBody: { values: [['Month', 'Budget', 'UpdatedAt']] }
            });
        }
        return true;
    } catch (error) {
        console.error('Error checking/creating Budget sheet:', error.message);
        return false;
    }
}

function parseSplitExpenseMessage(message) {
    const text = message.trim();
    const amountMatch = text.match(/^(\d+(?:\.\d+)?)(.*)$/);
    if (!amountMatch) return null;

    const originalAmount = Number(amountMatch[1]);
    const body = amountMatch[2].trim();
    const reasonMatch = body.match(/^\(([^)]+)\)/);
    const reason = reasonMatch?.[1]?.trim() || 'Split expense';
    const splitInstruction = body.replace(/^\([^)]*\)\s*/, '').replace(/^[-:]\s*/, '').trim();

    if (/\brest\s+(?:is\s+)?(?:divide|divided)\s+by\s+\d+/i.test(splitInstruction)) {
        const remainderMatch = splitInstruction.match(/^(\d+(?:\.\d+)?)\s+(?:me|myself|i)\s*,\s*rest\s+(?:is\s+)?(?:divide|divided)\s+by\s+(\d+)/i);
        return {
            error: 'Please reply with the names of the people included in the remaining split, separated by commas.',
            pending: remainderMatch ? {
                originalAmount,
                personalAmount: Number(remainderMatch[1]),
                peopleCount: Number(remainderMatch[2]),
                reason
            } : null
        };
    }

    const equalMatch = splitInstruction.match(/^split\s+equally\s+between\s+(.+)$/i);
    if (equalMatch) {
        const people = equalMatch[1]
            .replace(/\s+and\s+/gi, ',')
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);
        const owedPeople = people.filter(name => !/^(me|myself|i)$/i.test(name));
        if (people.length < 2 || owedPeople.length === 0) return null;

        const share = Number((originalAmount / people.length).toFixed(2));
        return {
            amount: Number((originalAmount - share * owedPeople.length).toFixed(2)),
            originalAmount,
            owedEntries: owedPeople.map(name => ({ amount: share, name })),
            reason: reasonMatch?.[1]?.trim() || 'Split equally'
        };
    }

    if (!splitInstruction) return null;

    const owedEntries = splitInstruction.split(',').map(entry => {
        const entryMatch = entry.match(/^\s*(\d+(?:\.\d+)?)\s+(.+?)\s*$/);
        if (!entryMatch) return null;
        return { amount: Number(entryMatch[1]), name: entryMatch[2].trim() };
    });

    if (owedEntries.some(entry => !entry) || owedEntries.length === 0) return null;

    const totalOwed = owedEntries.reduce((total, entry) => total + entry.amount, 0);
    const remainingAmount = Number((originalAmount - totalOwed).toFixed(2));
    if (remainingAmount < 0) return null;

    return {
        amount: remainingAmount,
        originalAmount,
        owedEntries,
        reason: reasonMatch?.[1]?.trim() || 'Split expense'
    };
}

function completePendingSplit(pending, namesMessage) {
    const names = namesMessage
        .replace(/^names?\s*(?:are|:)?\s*/i, '')
        .replace(/\s+and\s+/gi, ',')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);

    if (names.length !== pending.peopleCount) {
        return { error: `Please provide exactly ${pending.peopleCount} names, separated by commas.` };
    }
    if (names.some(name => /^(me|myself|i)$/i.test(name))) {
        return { error: 'Please provide the names of the other people. Your personal share is already recorded.' };
    }

    const remainder = Number((pending.originalAmount - pending.personalAmount).toFixed(2));
    if (remainder < 0 || pending.personalAmount < 0) {
        return { error: 'The personal share cannot be greater than the total transaction amount.' };
    }

    const baseShare = Number((remainder / pending.peopleCount).toFixed(2));
    const owedEntries = names.map((name, index) => ({
        name,
        amount: index === names.length - 1
            ? Number((remainder - baseShare * (names.length - 1)).toFixed(2))
            : baseShare
    }));
    return {
        amount: pending.personalAmount,
        originalAmount: pending.originalAmount,
        owedEntries,
        reason: pending.reason
    };
}

async function appendOwedEntries(splitData, date, addedAtTime, spreadsheetId) {
    if (!sheets || !spreadsheetId) return;

    await ensureOwedSheetExists(spreadsheetId);
    const existingRowsResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Owed!A:A'
    });
    const firstDataRow = (existingRowsResponse.data.values || []).length + 1;
    const values = splitData.owedEntries.map((entry, index) => [
        date,
        entry.name,
        entry.amount,
        splitData.originalAmount,
        `Split expense of ₹${splitData.originalAmount}`,
        addedAtTime,
        `=SUMIF($B$2:$B,B${firstDataRow + index},$C$2:$C)`,
        splitData.reason
    ]);

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Owed!A:H',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values }
    });
}

async function processExpenseMessage(message, spreadsheetId, splitOverride = null) {
    const splitData = splitOverride || parseSplitExpenseMessage(message);
    if (splitData?.error) {
        return { error: splitData.error, pending: splitData.pending };
    }
    if (splitData) {
        const d = new Date();
        const datePart = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const timePart = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });
        const addedAtTime = `${datePart} ${timePart}`;
        const expenseData = {
            is_error: false,
            amount: splitData.amount,
            category: 'Miscellaneous',
            subcategory: 'Split expense',
            description: `Paid ₹${splitData.originalAmount}; ${splitData.owedEntries.map(entry => `${entry.name} owes ₹${entry.amount}`).join(', ')}`,
            merchant: 'Split expense',
            payment_method: 'UPI',
            need_want: 'Need',
            date: datePart
        };

        if (sheets && spreadsheetId) {
            const sheetName = getMonthSheetName(expenseData.date);
            await ensureMonthlySheetExists(sheetName, spreadsheetId);
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A:J`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[
                    expenseData.date,
                    expenseData.amount,
                    expenseData.category,
                    expenseData.subcategory,
                    expenseData.merchant,
                    expenseData.description,
                    expenseData.payment_method,
                    expenseData.need_want,
                    addedAtTime,
                    '=SUM($B$2:INDIRECT("B"&ROW()))'
                ]] }
            });
            await appendOwedEntries(splitData, datePart, addedAtTime, spreadsheetId);
        }

        return { type: 'log', data: expenseData, owed: splitData.owedEntries };
    }

    const todayIST = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
    const prompt = `You are a discreet, capable personal finance butler. Evaluate this message: "${message}". Decide whether the user wants to record an expense, query spending, or chat. For an expense, call logExpense only when the amount is clear; never invent a real amount, merchant, or date. If essential information is missing, set is_error to true and ask one concise clarification. Negative amounts are income and must remain negative. For queries, call queryExpenses. Use today's date in India when no date is given: ${todayIST}. Default payment_method to "UPI" only when it is not stated. Choose need_want conservatively: recurring essentials are Needs, discretionary purchases are Wants. Be practical and gently point out useful context when replying, but do not lecture. Keep replies concise, plain text, and free of Markdown markers and emojis.`;

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

        const normalizedAmount = Number(expenseData.amount);
        if (!Number.isFinite(normalizedAmount)) {
            return { error: 'I need a clear numeric amount before I can record that expense.' };
        }
        expenseData.amount = Number(normalizedAmount.toFixed(2));
        if (!CATEGORIES.includes(expenseData.category)) {
            expenseData.category = 'Miscellaneous';
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseData.date) || Number.isNaN(Date.parse(expenseData.date))) {
            expenseData.date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        }
        expenseData.description = String(expenseData.description || expenseData.merchant || 'Expense').trim();

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

async function setMonthlyBudget(amount, spreadsheetId) {
    const budget = Number(amount);
    if (!Number.isFinite(budget) || budget <= 0) {
        return { error: 'Please provide a monthly budget greater than zero.' };
    }
    if (!await ensureBudgetSheetExists(spreadsheetId)) {
        return { error: 'Google Sheets is not configured.' };
    }

    const month = getMonthSheetName();
    const updatedAt = new Date().toISOString();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Budget!A:C' });
    const rows = response.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === month);
    const values = [[month, budget, updatedAt]];

    if (rowIndex >= 1) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Budget!A${rowIndex + 1}:C${rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Budget!A:C',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });
    }
    return { month, budget };
}

async function getBudgetStatus(spreadsheetId) {
    if (!await ensureBudgetSheetExists(spreadsheetId)) {
        return { error: 'Google Sheets is not configured.' };
    }

    const month = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Budget!A:C' });
    const row = (response.data.values || []).find(values => values[0] === month);
    if (!row || !Number.isFinite(Number(row[1]))) {
        return { month, budget: null, spent: await getMonthTotal(spreadsheetId) };
    }

    const budget = Number(row[1]);
    const spent = await getMonthTotal(spreadsheetId);
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dayOfMonth = today.getDate();
    const expectedSpend = (budget / daysInMonth) * dayOfMonth;
    return {
        month,
        budget,
        spent,
        remaining: budget - spent,
        expectedSpend
    };
}

async function getOwedSummary(spreadsheetId) {
    if (!sheets || !spreadsheetId) {
        return { error: 'Google Sheets is not configured.' };
    }

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Owed!A:H'
    }).catch(() => null);
    const rows = response?.data?.values || [];
    if (rows.length <= 1) {
        return { total: 0, people: [] };
    }

    const peopleByKey = new Map();
    for (const row of rows.slice(1)) {
        const name = String(row[1] || '').trim();
        const amount = Number(row[2]);
        if (!name || !Number.isFinite(amount) || amount <= 0) continue;

        const key = name.toLowerCase();
        let person = peopleByKey.get(key);
        if (!person) {
            person = { name, total: 0, transactions: [] };
            peopleByKey.set(key, person);
        }
        person.total = Number((person.total + amount).toFixed(2));
        person.transactions.push({
            date: row[0] || 'Unknown date',
            amount,
            reason: row[7] || row[4] || 'No reason recorded'
        });
    }

    const people = [...peopleByKey.values()].sort((first, second) => second.total - first.total);
    return {
        total: Number(people.reduce((sum, person) => sum + person.total, 0).toFixed(2)),
        people
    };
}

async function getAveragePerDayThisMonth(spreadsheetId) {
    if (!sheets) return null;
    const sheetName = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
    if (!response || !response.data.values) return null;

    let total = 0;
    const rows = response.data.values;
    const transactionCount = rows.length > 1 ? rows.length - 1 : 0;
    for (let i = 1; i < rows.length; i++) {
        total += parseFloat(rows[i][1]) || 0;
    }

    const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const daysPast = todayIST.getDate();
    const average = daysPast > 0 ? total / daysPast : 0;
    const monthName = todayIST.toLocaleString('default', { month: 'long' });
    const year = todayIST.getFullYear();

    return {
        total,
        transactionCount,
        daysPast,
        average,
        monthName,
        year
    };
}

async function getCategoryOverviewThisMonth(spreadsheetId, targetMonthStr = null) {
    if (!sheets) return null;

    let sheetName = getMonthSheetName();
    const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    let daysPast = todayIST.getDate();
    let displayTitle = "this Month";

    if (targetMonthStr) {
        const currentYear = todayIST.getFullYear();
        const parseStr = /\d/.test(targetMonthStr) ? targetMonthStr : `${targetMonthStr} 1, ${currentYear}`;
        const ts = Date.parse(parseStr);
        if (!isNaN(ts)) {
            const targetDate = new Date(ts);
            sheetName = getMonthSheetName(targetDate);
            displayTitle = `for ${sheetName}`;
            if (sheetName !== getMonthSheetName(todayIST)) {
                // If it's a past/future month, use total days in that month
                daysPast = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0).getDate();
            }
        }
    }

    const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
    if (!response || !response.data.values) return { error: `Could not find data for ${sheetName}.` };

    const rows = response.data.values;
    const categoryTotals = {};
    let totalSpend = 0;

    for (let i = 1; i < rows.length; i++) {
        const amount = parseFloat(rows[i][1]) || 0;
        const category = rows[i][2] || "Uncategorized";
        if (!categoryTotals[category]) categoryTotals[category] = 0;
        categoryTotals[category] += amount;
        totalSpend += amount;
    }

    let overviewString = `📊 Category Overview ${displayTitle}:\n`;
    for (const [cat, total] of Object.entries(categoryTotals)) {
        const avg = daysPast > 0 ? total / daysPast : 0;
        overviewString += `\n${cat}: ₹${total.toFixed(2)} (Avg: ₹${avg.toFixed(2)}/day)`;
    }

    const totalAvg = daysPast > 0 ? totalSpend / daysPast : 0;
    overviewString += `\n\n💰 **Total Spend: ₹${totalSpend.toFixed(2)}** (Avg: ₹${totalAvg.toFixed(2)}/day)`;

    return overviewString;
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

    // To prevent checking 600+ months if AI hallucinates 1970 start date, let's fetch available sheets first.
    const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId }).catch(() => null);
    if (!spreadsheetInfo) return { error: "Could not fetch spreadsheet data." };

    const availableSheets = new Set(spreadsheetInfo.data.sheets.map(s => s.properties.title));
    const sheetsToQuery = Array.from(monthsToFetch).filter(s => availableSheets.has(s));

    let totalAmount = 0;
    let transactions = [];

    // Try fetching every relevant month sheet
    for (const sheetName of sheetsToQuery) {
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
    parseSplitExpenseMessage,
    completePendingSplit,
    getTodayTotal,
    getMonthTotal,
    setMonthlyBudget,
    getBudgetStatus,
    getOwedSummary,
    getAveragePerDayThisMonth,
    getCategoryOverviewThisMonth,
    undoLastExpense,
    getLastExpense
};
