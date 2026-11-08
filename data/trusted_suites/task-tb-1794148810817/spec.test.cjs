
const assert = require('assert');
const path = require('path');
const { TokenBucket } = require(path.resolve(process.cwd(), 'src/tokenBucket.js'));

const targetCrit = process.argv[2];

// Test Criterion 1: Elapsed time refill
if (!targetCrit || targetCrit === 'crit-tb-1') {
  const tb = new TokenBucket(10, 5); // 5 tokens/sec
  tb.tokens = 0;
  tb.lastRefill = Date.now() - 1000; // 1 second ago
  tb.refill();
  assert.ok(tb.tokens >= 4.9 && tb.tokens <= 5.1, 'Must replenish approximately 5 tokens after 1 second (got: ' + tb.tokens + ')');
}

// Test Criterion 2: Max capacity clamp
if (!targetCrit || targetCrit === 'crit-tb-2') {
  const tb = new TokenBucket(10, 10);
  tb.tokens = 5;
  tb.lastRefill = Date.now() - 5000; // 5 seconds ago -> would generate 50 tokens
  tb.refill();
  assert.strictEqual(tb.tokens, 10, 'Tokens must be capped at maximum capacity of 10');
}

// Test Criterion 3: Consume and reject
if (!targetCrit || targetCrit === 'crit-tb-3') {
  const tb = new TokenBucket(5, 1);
  tb.tokens = 3;
  tb.lastRefill = Date.now();
  const c1 = tb.consume(2);
  assert.strictEqual(c1, true, 'Consume 2 must succeed when 3 tokens available');
  const c2 = tb.consume(2);
  assert.strictEqual(c2, false, 'Consume 2 must fail when only 1 token available');
}

console.log('PASS: Criterion ' + (targetCrit || 'all') + ' verified successfully.');
process.exit(0);
