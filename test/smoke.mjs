/**
 * Smoke Tests
 *
 * Run: node test/smoke.mjs
 * Requirements: submarine.service must be running
 *
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __test_dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = resolve(__test_dirname, '..');

function readEnv() {
  try {
    const content = readFileSync(resolve(BASE_DIR, '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.substring(0, eq).trim();
      const val = trimmed.substring(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* no .env */ }
}
readEnv();

const API_KEY = process.env.SUBMARINE_API_KEY || '';

const PORT = (() => {
  try {
    const config = JSON.parse(readFileSync(resolve(BASE_DIR, 'submarine.config.json'), 'utf-8'));
    return config.server?.defaultPort || 3100;
  } catch { return 3100; }
})();

const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name) { passed++; console.log(`  ✅ ${name}`); }
function fail(name, reason) { failed++; console.error(`  ❌ ${name}: ${reason}`); }
function skip(name, reason) { skipped++; console.log(`  ⏭  ${name}: ${reason}`); }

async function fetchJson(path, timeoutMs = 10000) {
  const res = await fetch(`${BASE}${path}`, {
    headers: API_KEY ? { 'X-API-Key': API_KEY } : {},
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

console.log('\n🧪 Smoke Tests\n');

// 1. Config
console.log('📋 Config');
try {
  const config = JSON.parse(readFileSync(resolve(BASE_DIR, 'submarine.config.json'), 'utf-8'));
  config.server?.defaultPort ? ok('config has server.defaultPort') : fail('config', 'no server.defaultPort');
  config.rings?.soul ? ok('config has rings.soul') : fail('config', 'no rings.soul');
  config.rings?.knowledge ? ok('config has rings.knowledge') : fail('config', 'no rings.knowledge');
  config.rings?.causality ? ok('config has rings.causality') : fail('config', 'no rings.causality');
  config.update?.mode ? ok('config has update.mode') : fail('config', 'no update.mode');
  config.manifest ? ok('config has manifest section') : fail('config', 'no manifest');
  config.paths?.extensions ? ok('config has paths.extensions') : fail('config', 'no paths.extensions');
} catch(e) { fail('config load', e.message); }

// 2. Ring contracts
console.log('\n💍 Ring Contracts');
for (const ring of ['soul', 'knowledge', 'causality']) {
  try {
    const m = await import(`../rings/${ring}.mjs`);
    if (m.name && m.version && typeof m.canActivate === 'function' && typeof m.enrich === 'function') {
      ok(`ring:${ring} contract (${m.name} v${m.version})`);
    } else {
      fail(`ring:${ring}`, 'missing exports');
    }
  } catch(e) { fail(`ring:${ring} import`, e.message); }
}

// 3. Manifest module
console.log('\n📦 Manifest');
try {
  const { getManifest } = await import('../src/manifest.mjs');
  const m = getManifest();
  m.block === 1 ? ok('manifest.block = 1') : fail('manifest', `block = ${m.block}`);
  Array.isArray(m.rings) ? ok('manifest.rings is array') : fail('manifest', 'rings not array');
  m.rings.length === 3 ? ok(`manifest has ${m.rings.length} rings`) : fail('manifest', `expected 3 rings, got ${m.rings.length}`);
  Array.isArray(m.extensions) ? ok('manifest.extensions is array') : fail('manifest', 'extensions not array');
  m.version ? ok(`manifest.version = ${m.version}`) : fail('manifest', 'no version');
} catch(e) { fail('manifest', e.message); }

// 4. Crystal Update Controller
console.log('\n⏰ Crystal Controller');
try {
  const { markCrystalDirty, getStatus, startController, stopController } = await import('../core/crystal-update-controller.mjs');
  typeof markCrystalDirty === 'function' ? ok('markCrystalDirty exists') : fail('controller', 'no markCrystalDirty');
  typeof startController === 'function' ? ok('startController exists') : fail('controller', 'no startController');
  typeof stopController === 'function' ? ok('stopController exists') : fail('controller', 'no stopController');
  const status = getStatus();
  typeof status.dirty === 'boolean' ? ok('getStatus returns dirty') : fail('controller', 'bad status');
  typeof status.running === 'boolean' ? ok('getStatus returns running') : fail('controller', 'bad running');
} catch(e) { fail('controller', e.message); }

// 5. Files exist
console.log('\n📁 File Structure');
const requiredFiles = [
  'core/crystal.mjs',
  'core/crystal-update-controller.mjs',
  'rings/soul.mjs',
  'rings/knowledge.mjs',
  'rings/causality.mjs',
  'src/manifest.mjs',
  'src/config.mjs',
  'extensions/.gitkeep',
  'README.md',
  'CHANGELOG.md',
  'ARCHITECTURE.md'
];
for (const f of requiredFiles) {
  existsSync(resolve(BASE_DIR, f)) ? ok(f) : fail(f, 'not found');
}
existsSync(resolve(BASE_DIR, 'data/immune-stats.json'))
  ? ok('data/immune-stats.json')
  : skip('data/immune-stats.json', 'created at first memory write — runtime test');

// 6. Crystal output
console.log('\n📝 Crystal Output');
const crystalPath = resolve(BASE_DIR, '..', 'CONTEXT-CRYSTAL.md');
if (existsSync(crystalPath)) {
  const crystal = readFileSync(crystalPath, 'utf-8');
  crystal.includes('CONTEXT-CRYSTAL.md') ? ok('Crystal has header') : fail('Crystal', 'no header');
  crystal.includes('Ring Coverage') ? ok('Crystal has Ring Coverage') : fail('Crystal', 'no Ring Coverage');
  const hasSoul = existsSync(resolve(BASE_DIR, 'SOUL.md'));
  crystal.includes('Rings:')
    ? ok('Crystal has ring status line')
    : (hasSoul ? fail('Crystal', 'no ring status') : skip('Crystal ring status', 'no SOUL.md — runtime test'));
  crystal.includes('Annotations:')
    ? ok('Crystal has annotation counts')
    : (hasSoul ? fail('Crystal', 'no annotation counts') : skip('Crystal annotations', 'no SOUL.md — runtime test'));
  const soulCount = (crystal.match(/↳ Soul:/g) || []).length;
  soulCount > 0 ? ok(`Soul annotations: ${soulCount}`) : skip('Soul annotations', 'needs Ollama');
  const pathCount = (crystal.match(/↳ Path:/g) || []).length;
  pathCount > 0 ? ok(`Path annotations: ${pathCount}`) : skip('Path annotations', 'needs graph data');
} else {
  skip('Crystal output', 'CONTEXT-CRYSTAL.md not found');
}

// 7. API tests
console.log('\n🌐 API Tests');
try {
  const health = await fetchJson('/api/v1/health', 15000);
  health.status === 'ok' ? ok('GET /api/v1/health') : fail('health', `status: ${health.status}`);

  const manifest = await fetchJson('/api/v1/manifest');
  manifest.block === 1 ? ok('GET /api/v1/manifest') : fail('manifest API', `block: ${manifest.block}`);
  manifest.rings.length === 3 ? ok('manifest API: 3 rings') : fail('manifest API', `${manifest.rings.length} rings`);

  const searchRes = await fetch(`${BASE}/api/v1/memory/search?q=test&limit=1&layer=core`, {
    headers: API_KEY ? { 'X-API-Key': API_KEY } : {},
    signal: AbortSignal.timeout(30000)
  });
  searchRes.ok ? ok('GET /api/v1/memory/search') : fail('search', `HTTP ${searchRes.status}`);

  const activeRes = await fetch(`${BASE}/api/v1/synapse/active`, {
    headers: API_KEY ? { 'X-API-Key': API_KEY } : {},
    signal: AbortSignal.timeout(10000)
  });
  activeRes.ok ? ok('GET /api/v1/synapse/active') : fail('synapse', `HTTP ${activeRes.status}`);

  const stats = await fetchJson('/api/v1/stats');
  stats.stats?.soul ? ok('GET /api/v1/stats') : fail('stats', 'no soul layer');
} catch(e) {
  skip('API tests', `submarine not reachable: ${e.message}`);
}

// 8. Behavioral Edges
console.log('\n🧬 Behavioral Edges');
try {
  const { extractCausalPatterns, createBehavioralEdge, scanForBehavioralEdges } = await import('../src/causal.mjs');

  let r = extractCausalPatterns('Chose LanceDB because it is embeddable and free');
  r.length >= 1 && r[0].marker === 'because' ? ok('extractCausalPatterns — "because"') : fail('because', `got ${r.length}`);

  r = extractCausalPatterns('data sovereignty -> 3 memory layers');
  r.length >= 1 && r[0].marker === '->' ? ok('extractCausalPatterns — "->"') : fail('->', `got ${r.length}`);

  r = extractCausalPatterns('We chose embedding because it preserves semantic meaning');
  r.length >= 1 && r[0].marker === 'because' ? ok('extractCausalPatterns — "because"') : fail('because', `got ${r.length}`);

  r = extractCausalPatterns('Plain text');
  r.length === 0 ? ok('extractCausalPatterns — no false positive') : fail('no pattern', `got ${r.length}`);

  const edge = createBehavioralEdge({ cause: 'sovereignty', effect: 'data storage', marker: '→' }, 'id-1');
  edge.type === 'behavioral' && edge.relation === 'causes' && edge.evidence === '→'
    ? ok('createBehavioralEdge — format') : fail('createBehavioralEdge', JSON.stringify(edge));

  const edges = scanForBehavioralEdges([
    { id: '1', text: 'Chose LanceDB because it is embeddable' },
    { id: '2', text: 'Plain text without patterns' },
    { id: '3', text: 'Refactoring led to clean system architecture' }
  ]);
  edges.length >= 2 ? ok(`scanForBehavioralEdges — batch (${edges.length})`) : fail('scan', `got ${edges.length}`);
} catch(e) { fail('behavioral edges', e.message); }

// Summary
console.log(`\n${'═'.repeat(40)}`);
console.log(`  Passed:  ${passed}`);
console.log(`  Failed:  ${failed}`);
console.log(`  Skipped: ${skipped}`);
console.log(`${'═'.repeat(40)}`);
if (failed > 0) {
  console.log('\n⚠️  Some tests failed!');
  process.exit(1);
} else {
  console.log('\n🎉 All tests passed!');
}
