/**
 * Forgetting mechanism tests
 *
 * Run: node submarine/test-forgetting.mjs
 *
 * @module test-forgetting
 */

import assert from 'node:assert';
import {
    decayFactor,
    effectiveImportance,
    getLayerByCategory,
    isSuperseded,
    isArchived,
    applyForgettingFilters,
    getDecayFactor
} from './src/forgetting.mjs';

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
        testResults.failed++;
        testResults.total++;
        testResults.duration += duration;
    }
}

async function runTests() {
    console.log('🧪 Forgetting mechanism tests\n');

    // ============================================================
    // 1. DECAY
    // ============================================================

    await test('decayFactor: Soul always 1.0 (no decay)', () => {
        assert.strictEqual(decayFactor('soul', 0), 1.0);
        assert.strictEqual(decayFactor('soul', 100), 1.0);
        assert.strictEqual(decayFactor('soul', 10000), 1.0);
    });

    await test('decayFactor: Core — half-life 60 days', () => {
        const at0 = decayFactor('core', 0);
        const at60 = decayFactor('core', 60);
        const at120 = decayFactor('core', 120);

        assert.strictEqual(at0, 1.0);
        // At 60 days — ~0.5
        assert.ok(Math.abs(at60 - 0.5) < 0.01, `at60=${at60}, expected ~0.5`);
        // At 120 days — ~0.25
        assert.ok(Math.abs(at120 - 0.25) < 0.01, `at120=${at120}, expected ~0.25`);
    });

    await test('decayFactor: Cortex — stale after 7 days', () => {
        const at0 = decayFactor('cortex', 0);
        const at3 = decayFactor('cortex', 3.5);
        const at8 = decayFactor('cortex', 8);

        assert.strictEqual(at0, 1.0);
        // At midpoint — linear decay
        assert.ok(at3 > 0.4 && at3 < 0.6, `at3.5=${at3}`);
        // After 7 days — 0.1
        assert.strictEqual(at8, 0.1);
    });

    await test('decayFactor: Cortex resilient — no decay', () => {
        assert.strictEqual(decayFactor('cortex', 100, { resilient: true }), 1.0);
    });

    await test('decayFactor: negative age -> 0 days', () => {
        assert.strictEqual(decayFactor('core', -5), 1.0);
    });

    await test('getLayerByCategory: correctly determines layers', () => {
        assert.strictEqual(getLayerByCategory('identity'), 'soul');
        assert.strictEqual(getLayerByCategory('fact'), 'core');
        assert.strictEqual(getLayerByCategory('decision'), 'core');
        assert.strictEqual(getLayerByCategory('lesson'), 'core');
        assert.strictEqual(getLayerByCategory('episode'), 'cortex');
        assert.strictEqual(getLayerByCategory('resilient_episode'), 'cortex');
        assert.strictEqual(getLayerByCategory('unknown_cat'), 'unknown');
    });

    await test('effectiveImportance: Soul preserves full importance', () => {
        const record = {
            importance: 10,
            category: 'identity',
            timestamp: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
        };
        assert.strictEqual(effectiveImportance(record), 10);
    });

    await test('effectiveImportance: Core decreases over time', () => {
        const now = new Date().toISOString();
        const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

        const fresh = effectiveImportance({ importance: 10, category: 'fact', timestamp: now });
        const aged = effectiveImportance({ importance: 10, category: 'fact', timestamp: old });

        assert.ok(fresh > aged, `fresh=${fresh} should be > aged=${aged}`);
        assert.ok(Math.abs(aged - 5) < 0.5, `aged ~5 at half-life, got ${aged}`);
    });

    // ============================================================
    // 2. SUPERSEDE
    // ============================================================

    await test('isSuperseded: recognizes superseded records', () => {
        assert.strictEqual(isSuperseded({ source: '{"id":"a","supersededBy":"b"}' }), true);
        assert.strictEqual(isSuperseded({ source: '{"id":"a"}' }), false);
        assert.strictEqual(isSuperseded({ source: '' }), false);
        assert.strictEqual(isSuperseded({ source: 'plain text' }), false);
    });

    // ============================================================
    // 3. ARCHIVE
    // ============================================================

    await test('isArchived: recognizes archived records', () => {
        assert.strictEqual(isArchived({ source: '{"id":"a","archived":true}' }), true);
        assert.strictEqual(isArchived({ source: '{"id":"a"}' }), false);
        assert.strictEqual(isArchived({ source: '' }), false);
    });

    // ============================================================
    // 4. FILTERS
    // ============================================================

    await test('applyForgettingFilters: filters out superseded and archived', () => {
        const results = [
            { text: 'active', source: '{"id":"1"}' },
            { text: 'superseded', source: '{"id":"2","supersededBy":"3"}' },
            { text: 'archived', source: '{"id":"4","archived":true}' },
            { text: 'also active', source: '{"id":"5"}' }
        ];

        const filtered = applyForgettingFilters(results);
        assert.strictEqual(filtered.length, 2);
        assert.strictEqual(filtered[0].text, 'active');
        assert.strictEqual(filtered[1].text, 'also active');
    });

    await test('applyForgettingFilters: includeArchived returns archived', () => {
        const results = [
            { text: 'active', source: '{"id":"1"}' },
            { text: 'archived', source: '{"id":"2","archived":true}' }
        ];

        const filtered = applyForgettingFilters(results, { includeArchived: true });
        assert.strictEqual(filtered.length, 2);
    });

    await test('applyForgettingFilters: includeSuperseded returns superseded', () => {
        const results = [
            { text: 'active', source: '{"id":"1"}' },
            { text: 'old', source: '{"id":"2","supersededBy":"3"}' }
        ];

        const filtered = applyForgettingFilters(results, { includeSuperseded: true });
        assert.strictEqual(filtered.length, 2);
    });

    await test('getDecayFactor: correct for different categories', () => {
        const soulRecord = { category: 'identity', timestamp: new Date(Date.now() - 365 * 86400000).toISOString() };
        const coreRecord = { category: 'fact', timestamp: new Date().toISOString() };
        const cortexOld = { category: 'episode', timestamp: new Date(Date.now() - 14 * 86400000).toISOString() };

        assert.strictEqual(getDecayFactor(soulRecord), 1.0);
        assert.strictEqual(getDecayFactor(coreRecord), 1.0);
        assert.strictEqual(getDecayFactor(cortexOld), 0.1);
    });

    // ============================================================
    // Results
    // ============================================================

    console.log('\n📊 Forgetting test results:');
    console.log(`   Total: ${testResults.total}`);
    console.log(`   Passed: ${testResults.passed}`);
    console.log(`   Failed: ${testResults.failed}`);
    console.log(`   Total time: ${testResults.duration}ms`);

    if (testResults.failed > 0) {
        console.log('\n❌ Some tests failed.');
        process.exit(1);
    } else {
        console.log('\n🎉 All forgetting tests passed!');
    }
}

runTests().catch(err => {
    console.error('🔥 Unexpected error in test runner:', err);
    process.exit(2);
});
