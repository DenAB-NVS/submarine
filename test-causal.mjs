/**
 * Automated tests for submarine causal graph.
 * Run: node submarine/test-causal.mjs
 * @module test-causal
 */

import assert from 'node:assert';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    initGraph,
    addRelation,
    getEffects,
    getCauses,
    rootCause,
    updateStrength,
    getEdgeStats,
    getGraphStats,
    saveGraph
} from './src/causal.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAPH_FILE = join(__dirname, 'data', 'causal-graph.json');
const JOURNAL_FILE = join(__dirname, 'RELATIONS-JOURNAL.md');

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

/**
 * Cleans up test files before each test
 */
async function cleanupTestFiles() {
    try {
        await fs.unlink(GRAPH_FILE);
    } catch (e) {}
    try {
        await fs.unlink(JOURNAL_FILE);
    } catch (e) {}
    // Ensure data directory exists
    await fs.mkdir(join(__dirname, 'data'), { recursive: true });
}

// Test data
const SOURCE_SOUL_ID = 'test_soul_1';
const SOURCE_SOUL_TEXT = 'test entity — reference content';
const TARGET_CORE_1_ID = 'test_core_1';
const TARGET_CORE_1_TEXT = 'Three-layer memory built';
const TARGET_CORE_2_ID = 'test_core_2';
const TARGET_CORE_2_TEXT = '11/11 tests passed';

async function runAllTests() {
    console.log('🧪 Running causal graph tests\n');

    let edgeId1 = null;
    let edgeId2 = null;

    // 1. Graph initialization
    await test('initGraph — creates graph from scratch', async () => {
        await cleanupTestFiles();
        const { edges, nodes } = await initGraph();
        assert.ok(Array.isArray(edges));
        assert.ok(nodes instanceof Map);
        assert.strictEqual(edges.length, 0);
        assert.strictEqual(nodes.size, 0);
        // File should exist
        const exists = await fs.access(GRAPH_FILE).then(() => true).catch(() => false);
        assert.ok(exists, 'Graph file should be created');
    });

    // 2. addRelation — creates edge, returns id
    await test('addRelation — creates edge, returns id', async () => {
        const result = await addRelation(
            SOURCE_SOUL_ID,
            SOURCE_SOUL_TEXT,
            TARGET_CORE_1_ID,
            TARGET_CORE_1_TEXT,
            'causes',
            'soul',
            1
        );
        assert.ok(result.id);
        assert.ok(result.id.startsWith('rel_'));
        assert.strictEqual(result.sourceText, SOURCE_SOUL_TEXT);
        assert.strictEqual(result.targetText, TARGET_CORE_1_TEXT);
        assert.strictEqual(result.relation, 'causes');
        edgeId1 = result.id;
        // Verify that graph contains one edge
        const { edges } = await initGraph();
        assert.strictEqual(edges.length, 1);
        const edge = edges[0];
        assert.strictEqual(edge.id, edgeId1);
        assert.strictEqual(edge.layer, 'soul');
        assert.strictEqual(edge.rung, 1);
        assert.strictEqual(edge.alpha, 1);
        assert.strictEqual(edge.beta, 1);
    });

    // 3. getEffects(depth=1) — finds direct effect
    await test('getEffects(depth=1) — finds direct effect', async () => {
        const effects = await getEffects(SOURCE_SOUL_ID, 1);
        assert.strictEqual(effects.length, 1);
        const effect = effects[0];
        assert.strictEqual(effect.edge.id, edgeId1);
        assert.strictEqual(effect.depth, 1);
        assert.ok(effect.chainStrength > 0 && effect.chainStrength <= 1);
        // Verify that targetId matches
        assert.strictEqual(effect.edge.targetId, TARGET_CORE_1_ID);
    });

    // 4. addRelation second edge (chain)
    await test('addRelation second edge (chain)', async () => {
        const result = await addRelation(
            TARGET_CORE_1_ID,
            TARGET_CORE_1_TEXT,
            TARGET_CORE_2_ID,
            TARGET_CORE_2_TEXT,
            'causes',
            'core',
            2
        );
        assert.ok(result.id);
        edgeId2 = result.id;
        const { edges } = await initGraph();
        assert.strictEqual(edges.length, 2);
    });

    // 5. getEffects(depth=2) — finds chain
    await test('getEffects(depth=2) — finds chain', async () => {
        const effects = await getEffects(SOURCE_SOUL_ID, 2);
        // Should be two effects: direct (depth=1) and through chain (depth=2)
        assert.strictEqual(effects.length, 2);
        const depth1 = effects.find(e => e.depth === 1);
        const depth2 = effects.find(e => e.depth === 2);
        assert.ok(depth1);
        assert.ok(depth2);
        assert.strictEqual(depth1.edge.id, edgeId1);
        assert.strictEqual(depth2.edge.id, edgeId2);
        // chainStrength should decrease with depth
        assert.ok(depth2.chainStrength < depth1.chainStrength);
    });

    // 6. getCauses — finds cause
    await test('getCauses — finds cause', async () => {
        const causes = await getCauses(TARGET_CORE_2_ID, 1);
        assert.strictEqual(causes.length, 1);
        const cause = causes[0];
        assert.strictEqual(cause.edge.id, edgeId2);
        assert.strictEqual(cause.edge.sourceId, TARGET_CORE_1_ID);
        assert.strictEqual(cause.edge.targetId, TARGET_CORE_2_ID);
    });

    // 7. rootCause — reaches the root (Soul)
    await test('rootCause — reaches the root (Soul)', async () => {
        const { rootEdge, path, depth } = await rootCause(TARGET_CORE_2_ID, 5);
        assert.ok(rootEdge);
        assert.strictEqual(rootEdge.layer, 'soul');
        assert.strictEqual(rootEdge.id, edgeId1);
        assert.strictEqual(path.length, 2); // both edges in the chain
        assert.strictEqual(depth, 2);
    });

    // 8. updateStrength(confirmed=true) — alpha grows
    await test('updateStrength(confirmed=true) — alpha grows', async () => {
        const edgeBefore = (await initGraph()).edges.find(e => e.id === edgeId1);
        assert.strictEqual(edgeBefore.alpha, 1);
        assert.strictEqual(edgeBefore.beta, 1);
        await updateStrength(edgeId1, true);
        const edgeAfter = (await initGraph()).edges.find(e => e.id === edgeId1);
        assert.strictEqual(edgeAfter.alpha, 2);
        assert.strictEqual(edgeAfter.beta, 1);
    });

    // 9. updateStrength(confirmed=false) — beta grows
    await test('updateStrength(confirmed=false) — beta grows', async () => {
        await updateStrength(edgeId2, false);
        const edge = (await initGraph()).edges.find(e => e.id === edgeId2);
        assert.strictEqual(edge.alpha, 1);
        assert.strictEqual(edge.beta, 2);
    });

    // 10. getEdgeStats — correct strength/confidence
    await test('getEdgeStats — correct strength/confidence', async () => {
        const edge = (await initGraph()).edges.find(e => e.id === edgeId1);
        const stats = getEdgeStats(edge);
        // alpha=2, beta=1 => total=3, strength=2/3≈0.6667, confidence=1-1/3≈0.6667
        assert.ok(Math.abs(stats.strength - 2/3) < 0.001);
        assert.ok(Math.abs(stats.confidence - (1 - 1/3)) < 0.001);
        assert.ok(stats.uncertainty >= 0);
        // Check for second edge: alpha=1, beta=2
        const edge2 = (await initGraph()).edges.find(e => e.id === edgeId2);
        const stats2 = getEdgeStats(edge2);
        assert.ok(Math.abs(stats2.strength - 1/3) < 0.001);
        assert.ok(Math.abs(stats2.confidence - (1 - 1/3)) < 0.001);
    });

    // 11. getGraphStats — statistics
    await test('getGraphStats — statistics', async () => {
        const stats = await getGraphStats();
        assert.strictEqual(stats.totalEdges, 2);
        assert.strictEqual(stats.byLayer.soul, 1);
        assert.strictEqual(stats.byLayer.core, 1);
        assert.strictEqual(stats.byLayer.cortex, 0);
        assert.strictEqual(stats.byRelation.causes, 2);
        assert.strictEqual(stats.byRelation.enables, 0);
        assert.strictEqual(stats.byRelation.prevents, 0);
        assert.strictEqual(stats.byRelation.correlates, 0);
        assert.ok(stats.avgStrength > 0);
        assert.ok(stats.avgConfidence > 0);
    });

    // 12. RELATIONS-JOURNAL.md — entry appeared
    await test('RELATIONS-JOURNAL.md — entry appeared', async () => {
        const journalExists = await fs.access(JOURNAL_FILE).then(() => true).catch(() => false);
        assert.ok(journalExists, 'JOURNAL file should exist');
        const content = await fs.readFile(JOURNAL_FILE, 'utf8');
        assert.ok(content.includes('# RELATIONS-JOURNAL.md — permanent log of causal relations') || content.includes('rel_'));
        // Verify presence of our entries
        assert.ok(content.includes(SOURCE_SOUL_TEXT));
        assert.ok(content.includes(TARGET_CORE_1_TEXT));
        assert.ok(content.includes(TARGET_CORE_2_TEXT));
    });

    console.log('\n📊 Causal graph test results:');
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
