#!/usr/bin/env node
/**
 * Diagnose — live system check.
 * Not "loaded" but "executes and returns a result".
 */

const API = 'http://localhost:3100';
const KEY = process.env.SUBMARINE_API_KEY || '';
if (!KEY) {
  console.error('Set SUBMARINE_API_KEY first: export SUBMARINE_API_KEY=your-key');
  process.exit(1);
}
const headers = { 'X-API-Key': KEY };

async function check(name, fn) {
    try {
        const result = await fn();
        console.log(`✅ ${name}: ${result}`);
        return true;
    } catch (e) {
        console.log(`❌ ${name}: ${e.message}`);
        return false;
    }
}

async function fetchJson(url) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

console.log('🔍 submarine diagnose — live system check\n');

let ok = 0, fail = 0;

// 1. API alive
if (await check('API (port 3100)', async () => {
    const d = await fetchJson(`${API}/api/v1/health`);
    return d.status;
})) ok++; else fail++;

// 2. Ollama embeddings
if (await check('Ollama embeddings', async () => {
    const d = await fetchJson(`${API}/api/v1/health`);
    return d.checks.ollama;
})) ok++; else fail++;

// 3. LanceDB
if (await check('LanceDB', async () => {
    const d = await fetchJson(`${API}/api/v1/health`);
    return d.checks.lancedb;
})) ok++; else fail++;

// 4. Layer counts
if (await check('Layers (Soul/Core/Cortex)', async () => {
    const d = await fetchJson(`${API}/api/v1/health`);
    const l = d.checks.layers;
    return `Soul:${l.soul} Core:${l.core} Cortex:${l.cortex} Total:${l.total}`;
})) ok++; else fail++;

// 5. Modules loaded
if (await check('Modules loaded', async () => {
    const d = await fetchJson(`${API}/api/v1/health`);
    const m = d.checks.modules;
    const loaded = Object.entries(m).filter(([,v]) => v === 'loaded').map(([k]) => k);
    const missing = Object.entries(m).filter(([,v]) => v !== 'loaded').map(([k]) => k);
    if (missing.length > 0) throw new Error(`Missing: ${missing.join(', ')}`);
    return loaded.join(', ');
})) ok++; else fail++;

// 6. Simple search
if (await check('Simple search', async () => {
    const q = encodeURIComponent('identity depth');
    const d = await fetchJson(`${API}/api/v1/memory/search?q=${q}&limit=2&mode=simple`);
    if (!d.success) throw new Error('not success');
    return `${d.count} results`;
})) ok++; else fail++;

// 7. Deep search
if (await check('Deep search', async () => {
    const q = encodeURIComponent('why is the system stable');
    const d = await fetchJson(`${API}/api/v1/memory/search?q=${q}&limit=3&mode=deep`);
    if (!d.meta) throw new Error('no meta — deep search not running');
    return `${d.count} results, coupling=${d.meta.couplingScore.toFixed(3)}`;
})) ok++; else fail++;

// 8. Causal graph
if (await check('Causal graph', async () => {
    const { getGraphStats, initGraph } = await import('./src/causal.mjs');
    await initGraph();
    const stats = await getGraphStats();
    if (stats.totalEdges === 0) throw new Error('graph EMPTY');
    return `${stats.totalEdges} edges (causes:${stats.byRelation.causes}, enables:${stats.byRelation.enables})`;
})) ok++; else fail++;

console.log(`\n${'═'.repeat(50)}`);
console.log(`Result: ${ok} ✅ / ${fail} ❌ out of ${ok + fail}`);
if (fail === 0) {
    console.log('🟢 ALL SYSTEMS GO');
} else {
    console.log('🔴 ISSUES FOUND — see ❌ above');
}
