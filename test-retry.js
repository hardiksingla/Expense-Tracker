const assert = require('assert');
const { isRetryableGeminiError, sleep } = require('./expenseService');

console.log('--- Test 1: Error detection for 503 and transient errors ---');

// The exact error message reported by the user
const userError = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}');
assert.strictEqual(isRetryableGeminiError(userError), true, 'User 503 error string should be detected as retryable');

// Status code error
const status503Error = { status: 503, message: 'Service Unavailable' };
assert.strictEqual(isRetryableGeminiError(status503Error), true, 'Status 503 should be retryable');

// 429 Rate Limit
const status429Error = { status: 429, message: 'Resource exhausted: quota exceeded' };
assert.strictEqual(isRetryableGeminiError(status429Error), true, 'Status 429 should be retryable');

// 500 Internal error
const status500Error = { status: 500, message: 'Internal server error' };
assert.strictEqual(isRetryableGeminiError(status500Error), true, 'Status 500 should be retryable');

// Non-retryable 400 Bad Request
const status400Error = { status: 400, message: 'Invalid argument: bad parameter' };
assert.strictEqual(isRetryableGeminiError(status400Error), false, 'Status 400 should NOT be retryable');

// Non-retryable general error
const genericError = new Error('Some random client validation error');
assert.strictEqual(isRetryableGeminiError(genericError), false, 'Generic client error should NOT be retryable');

console.log('✅ Test 1 Passed: All error classification assertions succeeded.');

console.log('\n--- Test 2: Simulating retry loop behavior on 503 errors ---');

async function simulateGeminiCall({ failCount = 0, errorType = '503', maxRetries = 3 }) {
    let attempts = 0;
    const maxAttempts = maxRetries + 1;
    let lastError = null;
    let success = false;
    let result = null;
    const delays = [];

    while (!success && attempts < maxAttempts) {
        attempts++;
        try {
            if (attempts <= failCount) {
                if (errorType === '503') {
                    throw new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}');
                } else if (errorType === '400') {
                    const err = new Error('Invalid request argument');
                    err.status = 400;
                    throw err;
                }
            }
            // Succeeded
            result = { type: 'log', data: { amount: 100, category: 'Food & Dining' } };
            success = true;
        } catch (apiError) {
            lastError = apiError;
            const retryable = isRetryableGeminiError(apiError);

            if (retryable && attempts < maxAttempts) {
                const retryCount = attempts;
                const baseDelay = 100 * Math.pow(2, retryCount - 1); // scale down for fast test execution
                delays.push({ retry: retryCount, delay: baseDelay });
                await sleep(10); // fast sleep for test
            } else {
                break;
            }
        }
    }

    if (!success) {
        return { error: `API Connection Failed: ${lastError?.message}. Check if your model name is valid.`, attempts, delays };
    }
    return { result, attempts, delays };
}

(async () => {
    // Scenario A: Fails twice with 503, then succeeds on 3rd attempt
    console.log('Testing Scenario A: Fails twice with 503, then succeeds...');
    const resA = await simulateGeminiCall({ failCount: 2, errorType: '503' });
    assert.strictEqual(resA.attempts, 3, 'Should take exactly 3 attempts');
    assert.strictEqual(resA.delays.length, 2, 'Should have logged 2 retry delays');
    assert.ok(resA.result, 'Should succeed on attempt 3');
    console.log('✅ Scenario A Passed: Succeeded after 2 retries.');

    // Scenario B: Fails continuously with 503
    console.log('Testing Scenario B: Fails continuously with 503...');
    const resB = await simulateGeminiCall({ failCount: 10, errorType: '503', maxRetries: 3 });
    assert.strictEqual(resB.attempts, 4, 'Should execute 1 initial + 3 retries = 4 total attempts');
    assert.strictEqual(resB.delays.length, 3, 'Should have backed off 3 times');
    assert.ok(resB.error.includes('API Connection Failed'), 'Should return API Connection Failed error');
    assert.ok(resB.error.includes('This model is currently experiencing high demand'), 'Should include 503 error message');
    console.log('✅ Scenario B Passed: Retried 3 times with backoff before returning error.');

    // Scenario C: Non-retryable 400 error
    console.log('Testing Scenario C: Non-retryable 400 error...');
    const resC = await simulateGeminiCall({ failCount: 1, errorType: '400', maxRetries: 3 });
    assert.strictEqual(resC.attempts, 1, 'Should fail immediately on attempt 1 without retry');
    assert.strictEqual(resC.delays.length, 0, 'No retries should be attempted');
    console.log('✅ Scenario C Passed: Non-retryable error aborted immediately.');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
})();
