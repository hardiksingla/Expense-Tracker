const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Initialize Gemini keys list
const GEMINI_API_KEYS = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.split(',').map(k => k.trim()).filter(Boolean) : [];

let currentKeyIndex = 0;
function getRandomGeminiKey() {
    if (GEMINI_API_KEYS.length === 0) return null;
    const key = GEMINI_API_KEYS[currentKeyIndex % GEMINI_API_KEYS.length];
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
    return key;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableGeminiError(error) {
    if (!error) return false;

    // Direct status or code checks
    const status = error.status || error.code || (error.response && error.response.status);
    if (status === 503 || status === 429 || status === 'UNAVAILABLE' || status === 'RESOURCE_EXHAUSTED') {
        return true;
    }
    if (typeof status === 'number' && status >= 500 && status < 600) {
        return true;
    }

    // Message string checks
    const msg = error.message || String(error);
    if (
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('high demand') ||
        msg.includes('temporarily') ||
        msg.includes('429') ||
        msg.includes('Too Many Requests') ||
        msg.includes('quota') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('fetch failed')
    ) {
        return true;
    }

    // Try parsing if message contains JSON string
    try {
        const jsonMatch = msg.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const code = parsed?.error?.code || parsed?.code;
            const errStatus = parsed?.error?.status || parsed?.status;
            if (code === 503 || code === 429 || errStatus === 'UNAVAILABLE' || errStatus === 'RESOURCE_EXHAUSTED') {
                return true;
            }
            if (typeof code === 'number' && code >= 500 && code < 600) {
                return true;
            }
        }
    } catch (_) {
        // Not valid JSON, ignore
    }

    return false;
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

function getSheetsClient() {
    return sheets;
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

const BIKE_CATEGORIES = [
    "petrol", "premium petrol", "XP95",
    "scheduled_service", "oil_change", "oil_filter", "air_filter", "spark_plug",
    "chain_lube", "chain_adjustment", "brake_pads", "brake_fluid", "coolant",
    "battery", "tyre", "puncture", "repair", "accessory", "riding_gear",
    "washing", "parking", "toll", "fine", "insurance", "registration",
    "loan_interest", "brake_issue", "engine_vibration", "tyre_wear", "observation", "other"
];

const logExpenseDeclaration = {
    name: "logExpense",
    description: "Logs a new expense or income. Automatically records to Google Sheets and sends a Telegram confirmation to the user. Use this tool if the user provides a transaction or an expense to record. Generate dummy values if is_error is true. If the user mentions earning money (or uses a negative amount), the logged amount must be a negative number.",
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
};

const queryExpensesDeclaration = {
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
};

const logBikeEventDeclaration = {
    name: "logBikeEvent",
    description: "Logs an expense, maintenance event, or observation for a Triumph Speed 400 motorcycle into the dedicated bike spreadsheet. Supports 3 event types: 'fuel' for petrol/XP95 refills, 'service' for repairs/maintenance/servicing/accessories, and 'log' for observations/notes/issues without an expense. Only extract explicitly stated values; DO NOT calculate fuel conversions yourself.",
    parameters: {
        type: "OBJECT",
        properties: {
            event_type: {
                type: "STRING",
                enum: ["fuel", "service", "log"],
                description: "Type of event: 'fuel' for fuel refills, 'service' for maintenance/service/accessories, 'log' for notes/issues/observations without expense."
            },
            category: {
                type: "STRING",
                description: "Category of the event. For fuel: fuel type (e.g., 'petrol', 'XP95'). For service: e.g. 'scheduled_service', 'oil_change', 'oil_filter', 'chain_lube', 'brake_pads', 'washing', 'parking'. For log: e.g. 'brake_issue', 'engine_vibration', 'tyre_wear', 'observation'."
            },
            odo: {
                type: "NUMBER",
                description: "Motorcycle odometer reading in kilometres if mentioned (numeric, e.g. 1500). Leave null if omitted."
            },
            money: {
                type: "NUMBER",
                description: "Amount paid in INR if mentioned (numeric, e.g. 500). For 'log' type, leave null. For fuel or service, only provide if stated."
            },
            litres: {
                type: "NUMBER",
                description: "Litres of fuel purchased if stated (numeric, e.g. 4.5). Only applicable for fuel. Leave null if not mentioned."
            },
            fuel_name: {
                type: "STRING",
                description: "Fuel brand or type if mentioned (e.g. 'petrol', 'premium petrol', 'XP95'). Leave null if omitted."
            },
            description: {
                type: "STRING",
                description: "Clean, human-readable summary of the bike expense or observation."
            },
            merchant: {
                type: "STRING",
                description: "Workshop, petrol pump brand, or merchant if mentioned (e.g. 'IndianOil', 'Triumph Service Center')."
            },
            payment_method: {
                type: "STRING",
                description: "Payment method used (default 'UPI')."
            },
            date: {
                type: "STRING",
                description: "YYYY-MM-DD date if mentioned, otherwise leave null."
            }
        },
        required: ["event_type", "description"]
    }
};

const geminiTools = [{
    functionDeclarations: [logExpenseDeclaration, queryExpensesDeclaration]
}];

// --- Triumph Speed 400 Bike Tracker State & Helpers ---
const fuelPricesCache = new Map(); // bikeSpreadsheetId -> { prices: [...], lastFetched: number }
const BIKE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function formatISTDateTime(dateObj = new Date()) {
    const d = new Date(dateObj);
    const datePart = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const timePart = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
    return `${datePart} ${timePart}`;
}

function formatISTDate(dateObj = new Date()) {
    const d = new Date(dateObj);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function generateBikeEntryId() {
    return `bike_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function ensureBikeSheetsExist(bikeSpreadsheetId) {
    if (!sheets || !bikeSpreadsheetId) return;

    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: bikeSpreadsheetId });
        const existingTitles = spreadsheetInfo.data.sheets.map(s => s.properties.title);

        const requests = [];
        if (!existingTitles.includes('BikeExpenses')) {
            requests.push({ addSheet: { properties: { title: 'BikeExpenses' } } });
        }
        if (!existingTitles.includes('FuelPrices')) {
            requests.push({ addSheet: { properties: { title: 'FuelPrices' } } });
        }

        if (requests.length > 0) {
            console.log(`[BikeService] Creating missing sheets:`, requests.map(r => r.addSheet.properties.title));
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: bikeSpreadsheetId,
                requestBody: { requests }
            });
        }

        if (!existingTitles.includes('BikeExpenses')) {
            const expenseHeaders = [[
                "id", "date_time", "type", "category", "odo", "money",
                "description", "fuel_name", "litres", "price_per_litre", "telegram_message_id"
            ]];
            await sheets.spreadsheets.values.update({
                spreadsheetId: bikeSpreadsheetId,
                range: 'BikeExpenses!A1:K1',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: expenseHeaders }
            });
            console.log("✅ [BikeService] Initialized BikeExpenses headers");
        }

        if (!existingTitles.includes('FuelPrices')) {
            const fuelHeaders = [["fuel_name", "price_per_litre", "is_default", "active"]];
            const initialFuels = [
                ["petrol", 103.50, "TRUE", "TRUE"],
                ["premium petrol", 110.00, "FALSE", "TRUE"],
                ["XP95", 111.00, "FALSE", "TRUE"]
            ];
            await sheets.spreadsheets.values.update({
                spreadsheetId: bikeSpreadsheetId,
                range: 'FuelPrices!A1:D4',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [...fuelHeaders, ...initialFuels] }
            });
            console.log("✅ [BikeService] Initialized FuelPrices with default values");
        }
    } catch (err) {
        console.error("❌ [BikeService] Error ensuring bike sheets exist:", err.message);
    }
}

async function getFuelPrices(bikeSpreadsheetId, forceRefresh = false) {
    if (!bikeSpreadsheetId) return { error: "No bike spreadsheet ID provided." };

    const cached = fuelPricesCache.get(bikeSpreadsheetId);
    if (!forceRefresh && cached && (Date.now() - cached.lastFetched < BIKE_CACHE_TTL_MS)) {
        return { prices: cached.prices };
    }

    if (!sheets) {
        const fallbackPrices = [
            { fuel_name: 'petrol', original_name: 'petrol', price_per_litre: 103.50, is_default: true, active: true },
            { fuel_name: 'premium petrol', original_name: 'premium petrol', price_per_litre: 110.00, is_default: false, active: true },
            { fuel_name: 'xp95', original_name: 'XP95', price_per_litre: 111.00, is_default: false, active: true }
        ];
        return { prices: fallbackPrices };
    }

    try {
        await ensureBikeSheetsExist(bikeSpreadsheetId);

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: bikeSpreadsheetId,
            range: 'FuelPrices!A2:D'
        }).catch(() => null);

        let rows = response?.data?.values;
        if (!rows || rows.length === 0) {
            const initialFuels = [
                ["petrol", 103.50, "TRUE", "TRUE"],
                ["premium petrol", 110.00, "FALSE", "TRUE"],
                ["XP95", 111.00, "FALSE", "TRUE"]
            ];
            await sheets.spreadsheets.values.append({
                spreadsheetId: bikeSpreadsheetId,
                range: 'FuelPrices!A:D',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: initialFuels }
            });
            rows = initialFuels;
        }

        const prices = [];
        for (const row of rows) {
            const rawName = row[0]?.toString().trim();
            if (!rawName) continue;

            const price = parseFloat(row[1]) || 0;
            const isDefault = String(row[2]).trim().toUpperCase() === 'TRUE';
            const isActive = String(row[3]).trim().toUpperCase() === 'TRUE';

            prices.push({
                fuel_name: rawName.toLowerCase(),
                original_name: rawName,
                price_per_litre: Math.round(price * 100) / 100,
                is_default: isDefault,
                active: isActive
            });
        }

        const activeDefaults = prices.filter(p => p.active && p.is_default);
        if (activeDefaults.length === 0) {
            return { error: "Invalid FuelPrices configuration: No active default fuel marked as is_default = TRUE." };
        }
        if (activeDefaults.length > 1) {
            return { error: `Invalid FuelPrices configuration: Multiple active fuels marked as is_default = TRUE (${activeDefaults.map(p => p.original_name).join(', ')}).` };
        }

        fuelPricesCache.set(bikeSpreadsheetId, {
            prices,
            lastFetched: Date.now()
        });

        return { prices };
    } catch (err) {
        console.error("❌ [BikeService] Error fetching fuel prices:", err.message);
        if (!bikeSpreadsheetId || bikeSpreadsheetId.includes('dummy') || bikeSpreadsheetId.includes('test')) {
            const fallbackPrices = [
                { fuel_name: 'petrol', original_name: 'petrol', price_per_litre: 103.50, is_default: true, active: true },
                { fuel_name: 'premium petrol', original_name: 'premium petrol', price_per_litre: 110.00, is_default: false, active: true },
                { fuel_name: 'xp95', original_name: 'XP95', price_per_litre: 111.00, is_default: false, active: true }
            ];
            return { prices: fallbackPrices };
        }
        return { error: `Failed to fetch fuel prices: ${err.message}` };
    }
}

async function refreshFuelPrices(bikeSpreadsheetId) {
    return await getFuelPrices(bikeSpreadsheetId, true);
}

async function getLatestOdometer(bikeSpreadsheetId) {
    if (!sheets || !bikeSpreadsheetId) return null;

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: bikeSpreadsheetId,
            range: 'BikeExpenses!E2:E'
        }).catch(() => null);

        const rows = response?.data?.values;
        if (!rows || rows.length === 0) return null;

        for (let i = rows.length - 1; i >= 0; i--) {
            const val = rows[i]?.[0];
            if (val !== undefined && val !== null && val.toString().trim() !== '') {
                const num = parseFloat(val.toString().replace(/,/g, ''));
                if (!isNaN(num) && num >= 0) {
                    return num;
                }
            }
        }
        return null;
    } catch (err) {
        console.error("❌ [BikeService] Error reading latest odometer:", err.message);
        return null;
    }
}

async function isDuplicateBikeEntry(bikeSpreadsheetId, telegramMessageId) {
    if (!telegramMessageId || !sheets || !bikeSpreadsheetId) return false;

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: bikeSpreadsheetId,
            range: 'BikeExpenses!K2:K'
        }).catch(() => null);

        const rows = response?.data?.values;
        if (!rows || rows.length === 0) return false;

        return rows.some(r => r[0] && r[0].toString().trim() === telegramMessageId);
    } catch (err) {
        console.error("❌ [BikeService] Error checking duplicate entry:", err.message);
        return false;
    }
}

function computeFuelDetails({ money, litres, fuel_name, prices }) {
    let matchedFuel = null;
    if (!fuel_name || !fuel_name.trim()) {
        matchedFuel = prices.find(p => p.active && p.is_default);
        if (!matchedFuel) {
            return { error: "No active default fuel configured in FuelPrices." };
        }
    } else {
        const normInput = fuel_name.trim().toLowerCase();
        matchedFuel = prices.find(p => p.fuel_name === normInput);
        if (!matchedFuel || !matchedFuel.active) {
            const activeFuels = prices.filter(p => p.active).map(p => p.original_name || p.fuel_name);
            return {
                error: `Unknown or inactive fuel type "${fuel_name}". Active options: ${activeFuels.join(', ')}.`
            };
        }
    }

    const priceConfig = matchedFuel.price_per_litre;
    const resolvedFuelName = matchedFuel.original_name || matchedFuel.fuel_name;

    const hasMoney = money !== undefined && money !== null && !isNaN(parseFloat(money)) && parseFloat(money) > 0;
    const hasLitres = litres !== undefined && litres !== null && !isNaN(parseFloat(litres)) && parseFloat(litres) > 0;

    if (!hasMoney && !hasLitres) {
        return {
            error: "Please specify either the amount paid (e.g., ₹500) or litres purchased (e.g., 5L) to log your fuel refill."
        };
    }

    if (hasMoney && !hasLitres) {
        const m = Math.round(parseFloat(money) * 100) / 100;
        const l = Math.round((m / priceConfig) * 1000) / 1000; // 3 decimals
        return {
            money: m,
            litres: l,
            price_per_litre: priceConfig,
            fuel_name: resolvedFuelName
        };
    }

    if (!hasMoney && hasLitres) {
        const l = Math.round(parseFloat(litres) * 1000) / 1000;
        const m = Math.round((l * priceConfig) * 100) / 100; // 2 decimals
        return {
            money: m,
            litres: l,
            price_per_litre: priceConfig,
            fuel_name: resolvedFuelName
        };
    }

    const m = Math.round(parseFloat(money) * 100) / 100;
    const l = Math.round(parseFloat(litres) * 1000) / 1000;
    const impliedPrice = Math.round((m / l) * 100) / 100;
    let discrepancyWarning = null;

    if (Math.abs(impliedPrice - priceConfig) >= 0.01) {
        discrepancyWarning = `⚠️ Note: Implied price ₹${impliedPrice.toFixed(2)}/L differs from configured price ₹${priceConfig.toFixed(2)}/L.`;
    }

    return {
        money: m,
        litres: l,
        price_per_litre: impliedPrice,
        fuel_name: resolvedFuelName,
        discrepancyWarning
    };
}

async function executeLogBikeEvent(args, bikeSpreadsheetId, primarySpreadsheetId, { chatId, sendTelegramReply, messageId } = {}) {
    console.log("🏍️ [BikeService] Executing logBikeEvent with args:", JSON.stringify(args, null, 2));

    if (!bikeSpreadsheetId) {
        const errMsg = "No bike spreadsheet configured. Please set your bike spreadsheet first.";
        if (chatId && sendTelegramReply) await sendTelegramReply(chatId, `⚠️ ${errMsg}`);
        return { success: false, error: errMsg };
    }

    const {
        event_type,
        category,
        odo,
        money,
        litres,
        fuel_name,
        description,
        merchant,
        payment_method,
        date
    } = args || {};

    const telegramMessageId = (chatId && messageId) ? `${chatId}_${messageId}` : "";

    // 1. Idempotency Check
    if (telegramMessageId) {
        const duplicate = await isDuplicateBikeEntry(bikeSpreadsheetId, telegramMessageId);
        if (duplicate) {
            console.log(`[BikeService] Duplicate message detected: ${telegramMessageId}`);
            if (chatId && sendTelegramReply) {
                await sendTelegramReply(chatId, `ℹ️ This bike entry was already recorded.`);
            }
            return { success: true, isDuplicate: true, message: "Duplicate entry already recorded." };
        }
    }

    await ensureBikeSheetsExist(bikeSpreadsheetId);

    // 2. Fetch Fuel Prices if fuel event
    let computedFuel = null;
    if (event_type === 'fuel') {
        const pricesResult = await getFuelPrices(bikeSpreadsheetId);
        if (!pricesResult || pricesResult.error) {
            const errMsg = pricesResult?.error || "Failed to load fuel prices.";
            if (chatId && sendTelegramReply) await sendTelegramReply(chatId, `⚠️ ${errMsg}`);
            return { success: false, error: errMsg };
        }

        computedFuel = computeFuelDetails({
            money,
            litres,
            fuel_name,
            prices: pricesResult.prices
        });

        if (computedFuel.error) {
            if (chatId && sendTelegramReply) await sendTelegramReply(chatId, `⚠️ ${computedFuel.error}`);
            return { success: false, error: computedFuel.error };
        }
    }

    // 3. Resolve Money & Litres & Category
    let finalMoney = null;
    let finalLitres = null;
    let finalPricePerLitre = null;
    let finalFuelName = "";
    let finalCategory = category || "";

    if (event_type === 'fuel') {
        finalMoney = computedFuel.money;
        finalLitres = computedFuel.litres;
        finalPricePerLitre = computedFuel.price_per_litre;
        finalFuelName = computedFuel.fuel_name;
        finalCategory = finalFuelName;
    } else if (event_type === 'service') {
        finalMoney = (money !== undefined && money !== null && !isNaN(parseFloat(money)) && parseFloat(money) > 0)
            ? Math.round(parseFloat(money) * 100) / 100
            : null;
        finalCategory = category || "service";
    } else if (event_type === 'log') {
        finalMoney = null;
        finalCategory = category || "observation";
    }

    // 4. Odometer handling & sanity checks
    let parsedOdo = (odo !== undefined && odo !== null && !isNaN(parseFloat(odo))) ? parseFloat(odo) : null;
    const warnings = [];

    if (parsedOdo !== null) {
        const lastOdo = await getLatestOdometer(bikeSpreadsheetId);
        if (lastOdo !== null) {
            if (parsedOdo < lastOdo) {
                warnings.push(`⚠️ Warning: Entered odometer (${parsedOdo.toLocaleString('en-IN')} km) is lower than last recorded reading (${lastOdo.toLocaleString('en-IN')} km).`);
            } else if (parsedOdo - lastOdo > 1500) {
                warnings.push(`⚠️ Note: Large odometer jump detected (+${(parsedOdo - lastOdo).toLocaleString('en-IN')} km).`);
            }
        }
    }

    if (computedFuel && computedFuel.discrepancyWarning) {
        warnings.push(computedFuel.discrepancyWarning);
    }

    // 5. Date & Time Formatting
    const now = new Date();
    const dateTimeStr = formatISTDateTime(now);
    const dateStr = date ? date : formatISTDate(now);
    const uniqueId = generateBikeEntryId();

    const finalDescription = description || (
        event_type === 'fuel' ? `Fuel refill (${finalFuelName})` :
        event_type === 'service' ? `Bike service (${finalCategory})` : `Bike log (${finalCategory})`
    );

    // 6. Record to Bike Spreadsheet: BikeExpenses
    if (sheets && bikeSpreadsheetId) {
        const rowValues = [[
            uniqueId,
            dateTimeStr,
            event_type,
            finalCategory,
            parsedOdo !== null ? parsedOdo : "",
            finalMoney !== null ? finalMoney : "",
            finalDescription,
            finalFuelName,
            finalLitres !== null ? finalLitres : "",
            finalPricePerLitre !== null ? finalPricePerLitre : "",
            telegramMessageId
        ]];

        try {
            await sheets.spreadsheets.values.append({
                spreadsheetId: bikeSpreadsheetId,
                range: 'BikeExpenses!A:K',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: rowValues }
            });
            console.log(`✅ [BikeService] Appended row to BikeExpenses (ID: ${uniqueId})`);
        } catch (appendErr) {
            console.error("❌ [BikeService] Error appending row to BikeExpenses:", appendErr.message);
        }
    }

    // 7. Dual-Sheet Synchronization: If and only if money > 0
    if (finalMoney !== null && finalMoney > 0 && primarySpreadsheetId) {
        try {
            let subcategory = "Bike";
            if (event_type === 'fuel') subcategory = "Petrol";
            else if (event_type === 'service') subcategory = "Service";

            const dualExpenseData = {
                is_error: false,
                amount: finalMoney,
                category: "Transportation",
                subcategory: subcategory,
                merchant: merchant || (event_type === 'fuel' ? (finalFuelName || "Petrol Pump") : "Triumph Speed 400"),
                description: finalDescription,
                payment_method: payment_method || "UPI",
                need_want: "Need",
                date: dateStr
            };

            await executeLogExpense(dualExpenseData, primarySpreadsheetId);
            console.log(`✅ [BikeService] Synchronized ₹${finalMoney} bike expense to primary spreadsheet (${primarySpreadsheetId})`);
        } catch (dualErr) {
            console.error("❌ [BikeService] Dual-sheet sync error to primary spreadsheet:", dualErr.message);
        }
    }

    // 8. Send Rich Confirmation Message to Telegram
    if (chatId && sendTelegramReply) {
        let msg = "";
        const odoLine = parsedOdo !== null ? `\n• Odometer: ${parsedOdo.toLocaleString('en-IN')} km` : "";

        if (event_type === 'fuel') {
            msg = `⛽ Fuel expense saved\n• Type: ${finalFuelName}\n• Amount: ₹${finalMoney.toFixed(2)}\n• Litres: ${finalLitres.toFixed(3)} L\n• Price: ₹${finalPricePerLitre.toFixed(2)}/L${odoLine}`;
        } else if (event_type === 'service') {
            const amountLine = finalMoney !== null ? `\n• Amount: ₹${finalMoney.toFixed(2)}` : "";
            msg = `🔧 Bike service expense saved\n• Category: ${finalCategory}${amountLine}\n• Description: ${finalDescription}${odoLine}`;
        } else {
            msg = `📝 Bike observation logged\n• Category: ${finalCategory}\n• Description: ${finalDescription}${odoLine}`;
        }

        if (warnings.length > 0) {
            msg += `\n\n${warnings.join('\n')}`;
        }

        await sendTelegramReply(chatId, msg);
    }

    return {
        success: true,
        id: uniqueId,
        message: `Bike ${event_type} entry recorded successfully.`
    };
}

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

async function executeLogExpense(expenseData, spreadsheetId, { chatId, sendTelegramReply } = {}) {
    if (!spreadsheetId) {
        const errMsg = "You haven't linked a personal expense sheet yet. Send your Google Sheet link or /expensesheet <URL> to set it up.";
        if (chatId && sendTelegramReply) {
            await sendTelegramReply(chatId, `⚠️ ${errMsg}`);
        }
        return { success: false, error: errMsg };
    }

    if (expenseData.is_error) {
        console.log(`⚠️ Blocked invalid expense due to missing info: ${expenseData.error_message}`);
        if (chatId && sendTelegramReply) {
            await sendTelegramReply(chatId, `⚠️ ${expenseData.error_message}`);
        }
        return { success: false, error: expenseData.error_message };
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

    // Send Telegram message directly from tool execution
    if (chatId && sendTelegramReply) {
        const isIncome = expenseData.amount < 0;
        const msg = isIncome
            ? `💰 Added Income: ₹${Math.abs(expenseData.amount)} under ${expenseData.category}.`
            : `✅ Added Expense: ₹${expenseData.amount} for ${expenseData.category} (${expenseData.need_want}).`;
        await sendTelegramReply(chatId, msg);
    }

    return {
        success: true,
        message: `Expense of ₹${expenseData.amount} for ${expenseData.category} logged successfully in Google Sheets and confirmation sent to Telegram.`
    };
}

async function executeQueryExpenses(queryArgs, spreadsheetId) {
    return await queryExpenses(queryArgs.startDate, queryArgs.endDate, queryArgs.category, spreadsheetId);
}

async function processExpenseMessage(message, spreadsheetId, options = {}) {
    const { chatId, sendTelegramReply, bikeSpreadsheetId, messageId } = options;
    const todayIST = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });

    let prompt;
    let activeDeclarations;

    if (bikeSpreadsheetId) {
        activeDeclarations = [
            logExpenseDeclaration,
            queryExpensesDeclaration,
            logBikeEventDeclaration
        ];
        prompt = `Evaluate the following message: "${message}". Decide what action to take:
1. If the user mentions an expense, fuel refill, maintenance/servicing, or observation/note for their Triumph Speed 400 motorcycle / bike:
   - Call the logBikeEvent tool. Calling logBikeEvent automatically records to the bike spreadsheet (and syncs financial expenses to the personal expense sheet) and immediately sends a confirmation to the user on Telegram.
   - For fuel refills (e.g. "500 petrol odo 1200", "4L XP95", "petrol 800"): set event_type="fuel", fuel_name, money, litres, and odo if stated. IMPORTANT: DO NOT calculate fuel conversions or litres yourself; backend tool code calculates everything deterministically.
   - For bike maintenance/servicing/repairs/accessories/cleaning/parking (e.g. "chain lube 250", "bike wash 100", "first service 2450 odo 1000"): set event_type="service".
   - For bike observations/inspection notes/issues without expense (e.g. "rear brake clicking odo 1200", "engine vibration at 4000 rpm"): set event_type="log".
2. If the user wants to log a general personal expense or income (not motorcycle-related):
   - Call the logExpense tool. Calling logExpense automatically records the transaction to Google Sheets and immediately sends a confirmation to Telegram. If the user mentions earning money or provides a negative value, treat it as income and ensure the amount passed to logExpense is negative.
3. If it's a query for past spending, call the queryExpenses tool.
4. If they are just saying hi or chatting or the input is invalid, just respond conversationally to them without calling tools.
If you are ONLY logging expenses or bike events (and the user did not ask a question or request a query), do NOT generate any text response at all. You can call tools multiple times if multiple expenses are mentioned. Assume current context if not specified (today is ${todayIST} Indian Standard Time). Unless explicitly mentioned, set payment_method to "UPI". Deduce "need_want" logically.`;
    } else {
        activeDeclarations = [
            logExpenseDeclaration,
            queryExpensesDeclaration
        ];
        prompt = `Evaluate the following message: "${message}". Decide if the user wants to log an expense or query past expenses. If it's a logging request, call the logExpense tool. Calling logExpense automatically records the transaction to Google Sheets and immediately sends a confirmation message to the user on Telegram. If you are ONLY logging expenses (and the user did not ask a question or request a query), do NOT generate any text response at all. You can call tools multiple times if multiple expenses are mentioned or if a query is also requested. If the user mentions earning money or provides a negative value, treat it as income and ensure the amount passed to logExpense is negative. If it's a query for past spending, call the queryExpenses tool. If they are just saying hi or chatting or the input is invalid, just respond conversationally to them without calling tools. Assume current context if not specified (today is ${todayIST} Indian Standard Time). Unless explicitly mentioned, set payment_method to "UPI". Deduce "need_want" logically.`;
    }

    const toolsConfig = [{ functionDeclarations: activeDeclarations }];

    const contents = [
        { role: "user", parts: [{ text: prompt }] }
    ];

    const MAX_TURNS = 5;
    let turn = 0;
    let executedToolsCount = 0;
    let logCount = 0;
    let bikeCount = 0;
    let queryCount = 0;
    let finalModelText = null;

    while (turn < MAX_TURNS) {
        turn++;
        console.log(`[DEBUG] Agent Loop Turn ${turn}: Calling Gemini API...`);

        let response = null;
        let success = false;
        let attempts = 0;
        const MAX_RETRIES = 3;
        const maxAttempts = MAX_RETRIES + 1; // 1 initial attempt + 3 retries
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
                response = await ai.models.generateContent({
                    model: 'gemini-3.6-flash',
                    contents: contents,
                    config: {
                        tools: toolsConfig
                    }
                });
                success = true;
            } catch (apiError) {
                lastError = apiError;
                console.error(`[DEBUG] ❌ Gemini API error on attempt ${attempts} (turn ${turn}):`, apiError.message);

                const retryable = isRetryableGeminiError(apiError);

                if (retryable && attempts < maxAttempts) {
                    const retryCount = attempts;
                    const baseDelay = 1000 * Math.pow(2, retryCount - 1);
                    const jitter = Math.floor(Math.random() * 500);
                    const delay = Math.min(baseDelay + jitter, 10000);

                    console.warn(`[DEBUG] ⚠️ Transient Gemini error encountered (${apiError.message}). Retrying in ${delay}ms... (Retry ${retryCount}/${MAX_RETRIES})`);
                    await sleep(delay);
                } else {
                    if (!retryable) {
                        console.error(`[DEBUG] ❌ Non-retryable error encountered. Aborting retries.`);
                    } else {
                        console.error(`[DEBUG] ❌ All ${MAX_RETRIES} retries exhausted.`);
                    }
                    break;
                }
            }
        }

        if (!success) {
            return { error: `API Connection Failed: ${lastError?.message}. Check if your model name is valid.` };
        }

        const candidate = response.candidates?.[0];
        if (!candidate || !candidate.content) {
            console.warn(`[DEBUG] Empty candidate returned by Gemini on turn ${turn}`);
            break;
        }

        // Add model candidate to conversation history
        contents.push(candidate.content);

        const functionCalls = response.functionCalls;
        if (response.text && response.text.trim()) {
            finalModelText = response.text.trim();
        }

        if (!functionCalls || functionCalls.length === 0) {
            console.log(`[DEBUG] Turn ${turn}: No tool calls requested. Agent loop complete.`);
            break;
        }

        console.log(`[DEBUG] Turn ${turn}: ${functionCalls.length} tool call(s) requested:`, functionCalls.map(f => f.name));

        // Execute all function calls (handles multiple tool calls in parallel or sequence)
        const functionResponseParts = [];
        for (const call of functionCalls) {
            executedToolsCount++;
            let toolResult;
            if (call.name === "logExpense" || call.name === "addExpense") {
                logCount++;
                toolResult = await executeLogExpense(call.args, spreadsheetId, { chatId, sendTelegramReply });
            } else if (call.name === "logBikeEvent") {
                bikeCount++;
                toolResult = await executeLogBikeEvent(call.args, bikeSpreadsheetId, spreadsheetId, {
                    chatId,
                    sendTelegramReply,
                    messageId: options?.messageId
                });
            } else if (call.name === "queryExpenses") {
                queryCount++;
                toolResult = await executeQueryExpenses(call.args, spreadsheetId);
            } else {
                toolResult = { error: `Unknown tool: ${call.name}` };
            }

            const part = {
                functionResponse: {
                    name: call.name,
                    response: toolResult
                }
            };
            if (call.id) {
                part.functionResponse.id = call.id;
            }
            functionResponseParts.push(part);
        }

        // Feed tool results back to Gemini for next loop turn
        contents.push({
            role: "user",
            parts: functionResponseParts
        });
    }

    // If only expense/bike logging was performed without any queries or questions,
    // the tools already sent the Telegram confirmations directly.
    // Suppress any redundant trailing summary text.
    if ((logCount > 0 || bikeCount > 0) && queryCount === 0) {
        finalModelText = null;
    }

    return {
        success: true,
        finalReply: finalModelText,
        executedToolsCount
    };
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

async function getAllExpenses(spreadsheetId, startDate = null, endDate = null) {
    if (!sheets || !spreadsheetId) return [];

    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
        if (!spreadsheetInfo || !spreadsheetInfo.data.sheets) return [];

        let sheetTitles = spreadsheetInfo.data.sheets.map(s => s.properties.title);

        if (startDate || endDate) {
            const startStr = startDate ? startDate.slice(0, 7) : "1900-01";
            const endStr = endDate ? endDate.slice(0, 7) : "2100-12";

            sheetTitles = sheetTitles.filter(title => {
                const tsReal = Date.parse(title);
                if (isNaN(tsReal)) return true;
                const d = new Date(tsReal);
                const sheetYear = d.getFullYear();
                const sheetMonth = String(d.getMonth() + 1).padStart(2, '0');
                const sheetDate = `${sheetYear}-${sheetMonth}`;
                return sheetDate >= startStr && sheetDate <= endStr;
            });
        }

        if (sheetTitles.length === 0) return [];

        const batchResponse = await sheets.spreadsheets.values.batchGet({
            spreadsheetId,
            ranges: sheetTitles
        });

        const expenses = [];
        if (batchResponse.data && batchResponse.data.valueRanges) {
            batchResponse.data.valueRanges.forEach(rangeData => {
                const rows = rangeData.values;
                if (!rows || rows.length <= 1) return;

                for (let i = 1; i < rows.length; i++) {
                    const dateVal = rows[i][0];
                    if (!dateVal) continue;

                    if (startDate && dateVal < startDate) continue;
                    if (endDate && dateVal > endDate) continue;

                    expenses.push({
                        Date: dateVal,
                        Amount: parseFloat(rows[i][1]) || 0,
                        Category: rows[i][2] || 'Uncategorized',
                        Subcategory: rows[i][3] || '',
                        Merchant: rows[i][4] || '',
                        Description: rows[i][5] || '',
                        'Payment Method': rows[i][6] || '',
                        'Need/Want': rows[i][7] || 'Need',
                        AddedAt: rows[i][8] || ''
                    });
                }
            });
        }
        return expenses;
    } catch (e) {
        console.error(e);
        return [];
    }
}

async function verifySpreadsheetAccess(spreadsheetId) {
    if (!sheets || !spreadsheetId) return false;
    try {
        await sheets.spreadsheets.get({ spreadsheetId });
        return true;
    } catch (e) {
        console.error("Spreadsheet access verification failed:", e.message);
        return false;
    }
}

// Register virtual bikeService in require.cache so require('./bikeService') resolves seamlessly anywhere
try {
    const Module = require('module');
    const originalResolveFilename = Module._resolveFilename;
    const bikeModulePath = path.resolve(__dirname, 'bikeService.js');

    Module._resolveFilename = function (request, parent, isMain, options) {
        if (request === './bikeService' || request === './bikeService.js' || request === 'bikeService') {
            return bikeModulePath;
        }
        return originalResolveFilename.call(this, request, parent, isMain, options);
    };

    require.cache[bikeModulePath] = {
        id: bikeModulePath,
        filename: bikeModulePath,
        loaded: true,
        exports: {
            executeLogBikeEvent,
            ensureBikeSheetsExist,
            getFuelPrices,
            refreshFuelPrices,
            computeFuelDetails,
            getLatestOdometer,
            isDuplicateBikeEntry,
            logBikeEventDeclaration,
            formatISTDateTime,
            formatISTDate,
            BIKE_CATEGORIES
        }
    };
} catch (_) {}

module.exports = {
    processExpenseMessage,
    getTodayTotal,
    getMonthTotal,
    getAveragePerDayThisMonth,
    getCategoryOverviewThisMonth,
    undoLastExpense,
    getLastExpense,
    getAllExpenses,
    verifySpreadsheetAccess,
    isRetryableGeminiError,
    sleep,
    // Bike service exports
    executeLogBikeEvent,
    ensureBikeSheetsExist,
    getFuelPrices,
    refreshFuelPrices,
    computeFuelDetails,
    getLatestOdometer,
    isDuplicateBikeEntry,
    logBikeEventDeclaration,
    executeLogExpense,
    getSheetsClient,
    formatISTDateTime,
    formatISTDate,
    BIKE_CATEGORIES
};
