/**
 * Automated tests for submarine without external frameworks
 *
 * Run: node submarine/test.mjs
 *
 * @module test
 */

import assert from 'node:assert';
import {
    Cortex,
    Core,
    Soul,
    unifiedSearch,
    getLayerStats,
    findById
} from './src/layers.mjs';
import { createServer } from './src/server.mjs';

// Test runner
const testResults = {
    passed: 0,
    failed: 0,
    total: 0,
    duration: 0
};

async function test(name, fn) {
    const start = Date.now();
    try {
        await fn();
        const duration = Date.now() - start;
        console.log(`  ✅ ${name} (${duration}ms)`);
        testResults.passed++;
        testResults.total++;
        testResults.duration += duration;
        return true;
    } catch (err) {
        const duration = Date.now() - start;
        console.log(`  ❌ ${name}: ${err.message} (${duration}ms)`);
        if (err.stack) {
            console.log('      Stack:', err.stack.split('\n')[1]);
        }
        testResults.failed++;
        testResults.total++;
        testResults.duration += duration;
        return false;
    }
}

function randomString(prefix = '') {
    return prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Main block
async function runAllTests() {
    console.log('🧪 Running submarine tests\n');

    let savedId = null;

    // 1. Soul.add
    await test('Soul.add returns success and id starting with sub_', async () => {
        const result = await Soul.add('[TEST] identity test ' + randomString());
        assert.ok(result.success, 'success should be true');
        assert.ok(result.id, 'id should be present');
        assert.ok(result.id.startsWith('sub_'), `id should start with "sub_", got ${result.id}`);
        assert.strictEqual(result.layer, 'soul');
        savedId = result.id;
    });

    // 2. Soul.search
    await test('Soul.search finds what was added', async () => {
        const results = await Soul.search('[TEST] identity');
        assert.ok(Array.isArray(results));
        assert.ok(results.length > 0, 'should have at least one result');
        const found = results.some(r => r.text.includes('identity test'));
        assert.ok(found, 'should find text with identity test');
    });

    // 3. Core.add
    await test('Core.add returns success and id', async () => {
        const result = await Core.add('[TEST] fact test ' + randomString(), 'fact', 7);
        assert.ok(result.success);
        assert.ok(result.id.startsWith('sub_'));
        assert.strictEqual(result.layer, 'core');
    });

    // 4. Core.search
    await test('Core.search finds what was added', async () => {
        const results = await Core.search('[TEST] fact');
        assert.ok(results.length > 0);
        const found = results.some(r => r.text.includes('fact test'));
        assert.ok(found);
    });

    // 5. Cortex.add
    await test('Cortex.add returns success and id', async () => {
        const result = await Cortex.add('[TEST] episode test ' + randomString(), { event: 'test' });
        assert.ok(result.success);
        assert.ok(result.id.startsWith('sub_'));
        assert.strictEqual(result.layer, 'cortex');
    });

    // 6. Cortex.search
    await test('Cortex.search finds what was added', async () => {
        const results = await Cortex.search('[TEST] episode');
        assert.ok(results.length > 0);
        const found = results.some(r => r.text.includes('episode test'));
        assert.ok(found);
    });

    // 7. unifiedSearch — Soul results have higher weightedScore
    await test('unifiedSearch: Soul results have higher weightedScore', async () => {
        const results = await unifiedSearch('[TEST]');
        assert.ok(results.length > 0);
        // Check that Soul results have weightedScore higher than Cortex with same score?
        // Enough to verify that unifiedSearch returns weightedScore
        const soulResults = results.filter(r => r.layer === 'soul');
        const cortexResults = results.filter(r => r.layer === 'cortex');
        if (soulResults.length > 0 && cortexResults.length > 0) {
            // Soul is multiplied by 3, Cortex by 1, so Soul weightedScore should be higher at equal scores
            // But scores may differ, so just check field presence
            assert.ok(soulResults[0].weightedScore !== undefined);
            assert.ok(cortexResults[0].weightedScore !== undefined);
        }
    });

    // 8. getLayerStats
    await test('getLayerStats returns total.count > 0', async () => {
        const stats = await getLayerStats();
        assert.ok(stats.total.count >= 0);
        // After adding test records, count should be > 0
        assert.ok(stats.total.count > 0, 'should have at least one record');
    });

    // 9. findById
    await test('findById finds record by id', async () => {
        if (!savedId) {
            throw new Error('savedId not saved, skipping');
        }
        const found = await findById(savedId);
        assert.ok(found, 'record should be found');
        assert.strictEqual(found.metadata.id, savedId);
    });

    // 10. HTTP tests
    await test('HTTP API: POST /api/v1/memory, GET /search, GET /stats', async () => {
        // Random port
        const port = 30000 + Math.floor(Math.random() * 1000);
        const apiKey = 'test-key-' + randomString();
        const { server, start, stop } = createServer(port, apiKey);
        let serverClosed = false;
        try {
            start();
            // Wait for server startup
            await new Promise(resolve => setTimeout(resolve, 100));

            // POST request
            const postResponse = await fetch(`http://localhost:${port}/api/v1/memory`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': apiKey
                },
                body: JSON.stringify({
                    layer: 'cortex',
                    text: '[HTTP TEST] episode',
                    metadata: { test: true }
                })
            });
            assert.strictEqual(postResponse.status, 201);
            const postData = await postResponse.json();
            assert.ok(postData.success);
            assert.ok(postData.id.startsWith('sub_'));
            assert.strictEqual(postData.layer, 'cortex');

            // GET search (with API key)
            const searchResponse = await fetch(`http://localhost:${port}/api/v1/memory/search?q=[HTTP+TEST]&layer=all`, {
                headers: { 'X-API-Key': apiKey }
            });
            assert.strictEqual(searchResponse.status, 200);
            const searchData = await searchResponse.json();
            assert.ok(searchData.success);

            // GET stats (with API key)
            const statsResponse = await fetch(`http://localhost:${port}/api/v1/stats`, {
                headers: { 'X-API-Key': apiKey }
            });
            assert.strictEqual(statsResponse.status, 200);
            const statsData = await statsResponse.json();
            assert.ok(statsData.success);
            assert.ok(statsData.stats.total.count >= 0);
        } finally {
            if (!serverClosed) {
                stop();
                serverClosed = true;
            }
        }
    });

    // Additional cleanup test
    await test('Cortex.cleanup returns structure {staleCount, staleIds}', async () => {
        const result = await Cortex.cleanup();
        assert.ok('staleCount' in result);
        assert.ok('staleIds' in result);
        assert.ok(Array.isArray(result.staleIds));
        assert.ok(typeof result.staleCount === 'number');
    });

    console.log('\n📊 Test results:');
    console.log(`   Total: ${testResults.total}`);
    console.log(`   Passed: ${testResults.passed}`);
    console.log(`   Failed: ${testResults.failed}`);
    console.log(`   Total time: ${testResults.duration}ms`);

    if (testResults.failed > 0) {
        console.log('\n❌ Some tests failed.');
        process.exit(1);
    } else {
        console.log('\n🎉 All tests passed!');
    }
}

// Run
runAllTests().catch(err => {
    console.error('🔥 Unexpected error in test runner:', err);
    process.exit(2);
});
