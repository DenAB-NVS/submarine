/**
 * Tests for synapse — synaptic bridge between sessions.
 *
 * Run: node submarine/test-synapse.mjs
 *
 * Requires running Ollama with nomic-embed-text.
 *
 * @module test-synapse
 */

import assert from 'node:assert';
import { extract, weave, resolve, archiveStale, getActive } from './src/synapse.mjs';

const testResults = { passed: 0, failed: 0, total: 0, duration: 0 };

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    console.log(`  ✅ ${name} (${duration}ms)`);
    testResults.passed++;
    testResults.total++;
    testResults.duration += duration;
  } catch (err) {
    const duration = Date.now() - start;
    console.log(`  ❌ ${name}: ${err.message} (${duration}ms)`);
    if (err.stack) console.log('      Stack:', err.stack.split('\n')[1]);
    testResults.failed++;
    testResults.total++;
    testResults.duration += duration;
  }
}

async function runTests() {
  console.log('🧪 Synapse tests\n');

  // --- extract ---

  await test('extract: empty text returns empty arrays', async () => {
    const result = await extract('', 'test');
    assert.deepStrictEqual(result, { created: [], resolved: [] });
  });

  await test('extract: short text < 10 characters', async () => {
    const result = await extract('Hello', 'test');
    assert.deepStrictEqual(result, { created: [], resolved: [] });
  });

  let createdThreadId = null;

  await test('extract: question creates an open thread', async () => {
    const result = await extract('How to best organize caching in the submarine?', 'topic_general');
    assert.ok(result.created.length > 0, 'At least one thread should be created');
    assert.strictEqual(result.created[0].status, 'open');
    assert.ok(result.created[0].id.startsWith('syn_'), 'ID should start with syn_');
    createdThreadId = result.created[0].id;
  });

  await test('extract: task creates a thread', async () => {
    const result = await extract('Need to add crystal.mjs to cron for auto-update', 'topic_dev');
    assert.ok(result.created.length > 0, 'Task should create a thread');
    assert.strictEqual(result.created[0].importance, 6);
  });

  // --- weave ---

  await test('weave: finds relevant threads', async () => {
    const threads = await weave('submarine caching', 5);
    assert.ok(Array.isArray(threads));
    // Should find at least one thread we created above
    assert.ok(threads.length > 0, 'Should find at least one thread');
    assert.ok(threads[0].score > 0, 'Score should be > 0');
    assert.ok(threads[0].context, 'Should have context');
  });

  await test('weave: empty query returns []', async () => {
    const threads = await weave('', 5);
    assert.deepStrictEqual(threads, []);
  });

  // --- getActive ---

  await test('getActive: returns open threads', async () => {
    const active = await getActive();
    assert.ok(Array.isArray(active));
    assert.ok(active.length > 0, 'Should have active threads');
    for (const t of active) {
      assert.ok(t.id, 'Thread should have id');
      assert.ok(t.topic, 'Thread should have topic');
    }
  });

  // --- resolve ---

  await test('resolve: closes a thread', async () => {
    if (!createdThreadId) {
      console.log('      Skipped: no thread to resolve');
      return;
    }
    const result = await resolve(createdThreadId, 'Decided to use Redis');
    assert.ok(result.success, 'Resolve should be successful');
    assert.strictEqual(result.threadId, createdThreadId);
  });

  await test('resolve: non-existent ID', async () => {
    const result = await resolve('syn_nonexistent_xxxx');
    assert.strictEqual(result.success, false);
  });

  // --- archiveStale ---

  await test('archiveStale: does not crash', async () => {
    const result = await archiveStale();
    assert.ok(typeof result.archived === 'number');
  });

  // --- extract with resolutions ---

  await test('extract: resolution can close a related thread', async () => {
    // First create a thread
    await extract('Need to set up auto-deploy to the server', 'topic_ops');
    // Then the resolution
    const result = await extract('Decided to set up auto-deploy via GitHub Actions', 'topic_ops');
    // May close it or not (depends on semantic similarity)
    assert.ok(Array.isArray(result.resolved));
  });

  // --- Summary ---
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Synapse tests: ${testResults.passed}/${testResults.total} passed (${testResults.duration}ms)`);
  if (testResults.failed > 0) {
    console.log(`❌ ${testResults.failed} tests failed`);
    process.exit(1);
  } else {
    console.log('✅ All synapse tests passed');
  }
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
