require('dotenv').config();
const assert = require('assert');
const { processExpenseMessage } = require('./expenseService');

async function runTests() {
    console.log("=== Running Multi-Tool Agent Loop Tests ===");

    // Mock Telegram reply collector
    const sentTelegramMessages = [];
    const mockSendTelegramReply = async (chatId, text) => {
        sentTelegramMessages.push({ chatId, text });
        console.log(`[MockTelegram] Sent to ${chatId}: "${text}"`);
    };

    const mockChatId = 12345678;
    const testSpreadsheetId = process.env.Hardiksingla07_SPREADSHEET_ID;

    // Test 1: Chat message without tool calls
    console.log("\n--- Test 1: Conversational Chat (0 tools, text output) ---");
    sentTelegramMessages.length = 0;
    const chatResult = await processExpenseMessage("Hi there, how are you?", testSpreadsheetId, {
        chatId: mockChatId,
        sendTelegramReply: mockSendTelegramReply
    });

    assert.strictEqual(chatResult.success, true, "Chat should return success: true");
    assert.ok(chatResult.finalReply, "Chat should return a finalReply text");
    assert.strictEqual(chatResult.executedToolsCount, 0, "Executed tools should be 0");
    console.log("✅ Test 1 Passed: Final reply received without tool executions.");

    // Test 2: Single expense logging (verifies tool executes, sends TG message directly, handles zero/non-zero LLM text)
    console.log("\n--- Test 2: Single Expense Logging (Direct TG message & sheet logging) ---");
    sentTelegramMessages.length = 0;
    const logResult = await processExpenseMessage("15 test_snack_verif", testSpreadsheetId, {
        chatId: mockChatId,
        sendTelegramReply: mockSendTelegramReply
    });

    assert.strictEqual(logResult.success, true, "Logging should succeed");
    assert.ok(logResult.executedToolsCount >= 1, "Should have executed at least 1 tool");
    assert.strictEqual(logResult.finalReply, null, "finalReply must be null when only logging expenses to prevent duplicate summary text");
    assert.ok(sentTelegramMessages.length >= 1, "Should have sent at least 1 Telegram message from tool execution");
    const tgMsg = sentTelegramMessages[0].text;
    assert.ok(tgMsg.includes("15") && tgMsg.includes("Added Expense"), `Telegram message should confirm expense: ${tgMsg}`);
    console.log("✅ Test 2 Passed: Expense logged, Telegram confirmation dispatched directly from tool, trailing message eliminated.");

    // Test 3: Multiple expenses in one message (tests parallel tool calling)
    console.log("\n--- Test 3: Multiple Expenses in One Message (Parallel/Multi-Tool Loop) ---");
    sentTelegramMessages.length = 0;
    const multiResult = await processExpenseMessage("spent 25 on tea and 45 on samosa", testSpreadsheetId, {
        chatId: mockChatId,
        sendTelegramReply: mockSendTelegramReply
    });

    assert.strictEqual(multiResult.success, true, "Multi expense should succeed");
    assert.ok(multiResult.executedToolsCount >= 2, `Should have executed at least 2 tools, got: ${multiResult.executedToolsCount}`);
    assert.strictEqual(multiResult.finalReply, null, "finalReply must be null for multiple expense logging to prevent duplicate summary text");
    assert.ok(sentTelegramMessages.length >= 2, `Should have sent at least 2 Telegram confirmations, got: ${sentTelegramMessages.length}`);
    console.log("✅ Test 3 Passed: Successfully executed multiple tool calls across the loop with no trailing summary.");

    // Test 4: Query expenses (model executes tool, gets tool response, produces text output)
    console.log("\n--- Test 4: Query Expenses (Tool execution followed by text output) ---");
    sentTelegramMessages.length = 0;
    const queryResult = await processExpenseMessage("how much did I spend today?", testSpreadsheetId, {
        chatId: mockChatId,
        sendTelegramReply: mockSendTelegramReply
    });

    assert.strictEqual(queryResult.success, true, "Query should succeed");
    assert.ok(queryResult.executedToolsCount >= 1, "Should execute queryExpenses tool");
    assert.ok(queryResult.finalReply, "Should formulate a final reply based on query result");
    console.log("✅ Test 4 Passed: Query tool executed and final model response formulated.");

    console.log("\n🎉 ALL MULTI-TOOL AGENT LOOP TESTS PASSED SUCCESSFULLY! 🎉\n");
}

runTests().catch(err => {
    console.error("❌ Test failed:", err);
    process.exit(1);
});
