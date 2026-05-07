/**
 * immune.mjs — submarine immune system
 * ========================================
 * Three layers of immunity for Soul:
 *   1. Protection     — semantic distance (fail-safe base)
 *   2. Recognition    — causal path to Soul (reinforcement)
 *   3. Anticipation   — Soul growth zone (reinforcement)
 *
 * Resilience principles:
 *   - Semantics = the only mandatory layer
 *   - Causality and growth = advisory (on error — neutral vote)
 *   - 15s timeout on the entire check
 *   - On any error — pass through to Core (do not lose the record)
 *   - Causal graph cache (do not re-read on every call)
 *   - Early exit: if semantics are obvious — skip the rest
 *   - Non-blocking: rejected records are rerouted, not deleted
 *
 * @module submarine/src/immune
 * @author D. Ashford
 */

import { searchMemories } from '../semantic-memory/memory-engine.mjs';
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from './config.mjs';

const __immune_dirname = dirname(fileURLToPath(import.meta.url));
const _paths = getConfig().paths || {};
const STATS_FILE = join(dirname(__immune_dirname), _paths.immuneStats || join('data', 'immune-stats.json'));
const STATS_DIR = dirname(STATS_FILE);

let causalModule = null;
let causalReady = false;
try {
  causalModule = await import('./causal.mjs');
  await causalModule.initGraph();
  causalReady = true;
} catch (e) { /* causal graph is optional */ }

// Causal graph cache (refreshed every 10 minutes)
let _cachedEdges = null;
let _cachedSoulNodeIds = null;
let _cachedGrowthTexts = null;
let _cacheTimestamp = 0;
// 10 min — graph changes only on sync/write, not on every request
// (embedding cache in memory-engine = 60s — different nature: vectors are fine-grained)
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getCachedGraph() {
  const now = Date.now();
  if (_cachedEdges && (now - _cacheTimestamp) < CACHE_TTL_MS) {
    return { edges: _cachedEdges, soulNodeIds: _cachedSoulNodeIds, growthTexts: _cachedGrowthTexts };
  }
  if (!causalReady) return null;
  try {
    const { edges } = await causalModule.initGraph();
    if (!edges || edges.length === 0) return null;
    const soulNodeIds = new Set();
    for (const edge of edges) {
      if (edge.layer === 'soul') { soulNodeIds.add(edge.sourceId); soulNodeIds.add(edge.targetId); }
    }
    const growthTexts = [];
    for (const nodeId of soulNodeIds) {
      try {
        for (const { edge } of await causalModule.getEffects(nodeId, 2)) {
          if (edge.layer !== 'soul') growthTexts.push(edge.targetText.toLowerCase());
        }
      } catch (e) {}
    }
    _cachedEdges = edges;
    _cachedSoulNodeIds = soulNodeIds;
    _cachedGrowthTexts = growthTexts;
    _cacheTimestamp = now;
    return { edges, soulNodeIds, growthTexts };
  } catch (e) { return null; }
}

const _ringsCfg = getConfig().rings || {};
const CONFIG = {
  soul: {
    semanticThreshold: _ringsCfg.soul?.threshold || 0.45,
    semanticAutoPass: 0.55,
    causalDepth: _ringsCfg.causality?.maxDepth || 3,
    neighborCount: _ringsCfg.knowledge?.maxResults || 5,
    minCausalStrength: 0.3,
  },
  core: {
    semanticThreshold: 0.20,
    neighborCount: _ringsCfg.knowledge?.maxResults || 5,
  },
};

const LAYER_CATEGORIES = {
  soul: ['identity'],
  core: ['fact', 'decision', 'lesson', 'technical', 'finance', 'infrastructure'],
  cortex: ['episode', 'resilient_episode']
};

const TIMEOUT_MS = 45000;

// Layer 1: PROTECTION — semantic proximity
async function layer1_semantic(text, layer, config) {
  try {
    const categories = LAYER_CATEGORIES[layer] || [];
    let neighbors = await searchMemories(text, config.neighborCount, 0.05, categories);
    if (neighbors.length === 0) {
      neighbors = await searchMemories(text, config.neighborCount, 0.05);
    }
    if (neighbors.length === 0) {
      return { pass: layer !== 'soul', score: 0, note: 'no neighbors' };
    }
    const topScore = neighbors[0]?.score || 0;
    return { pass: topScore >= config.semanticThreshold, score: topScore, note: topScore >= config.semanticThreshold ? 'OK' : 'too distant' };
  } catch (e) {
    return { pass: true, score: 0, note: 'error-passthrough' };
  }
}

// Layer 2: RECOGNITION — causal path to Soul
async function layer2_causal(text, config) {
  const graph = await getCachedGraph();
  if (!graph) return { pass: false, score: 0, available: false, note: 'graph unavailable' };
  try {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.length === 0) return { pass: false, score: 0, available: true, note: 'no words' };
    const matchedNodeIds = new Set();
    for (const edge of graph.edges) {
      if (matchedNodeIds.size > 20) break;
      if (words.some(w => edge.sourceText.toLowerCase().includes(w) || edge.targetText.toLowerCase().includes(w))) {
        matchedNodeIds.add(edge.sourceId);
        matchedNodeIds.add(edge.targetId);
      }
    }
    if (matchedNodeIds.size === 0) return { pass: false, score: 0, available: true, note: 'no matches' };
    let maxStrength = 0;
    let checked = 0;
    for (const nodeId of matchedNodeIds) {
      if (checked++ >= 10) break;
      try {
        for (const { edge, chainStrength } of await causalModule.getCauses(nodeId, config.causalDepth)) {
          if (edge.layer === 'soul' && chainStrength > maxStrength) maxStrength = chainStrength;
        }
        if (maxStrength >= config.minCausalStrength) break;
        for (const { edge, chainStrength } of await causalModule.getEffects(nodeId, config.causalDepth)) {
          if (edge.layer === 'soul' && chainStrength > maxStrength) maxStrength = chainStrength;
        }
        if (maxStrength >= config.minCausalStrength) break;
      } catch (e) {}
    }
    const pass = maxStrength >= config.minCausalStrength;
    return { pass, score: maxStrength, available: true, note: pass ? 'path to Soul' : 'no path' };
  } catch (e) {
    return { pass: false, score: 0, available: false, note: 'error' };
  }
}

// Layer 3: ANTICIPATION — Soul growth zone
async function layer3_growth(text) {
  const graph = await getCachedGraph();
  if (!graph || graph.growthTexts.length === 0) {
    return { pass: false, score: 0, available: false, note: 'growth zone empty' };
  }
  try {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.length === 0) return { pass: false, score: 0, available: true, note: 'no words' };
    const hits = graph.growthTexts.filter(gt => words.some(w => gt.includes(w))).length;
    return { pass: hits > 0, score: hits, available: true, note: hits > 0 ? hits + ' match(es)' : 'miss' };
  } catch (e) {
    return { pass: false, score: 0, available: false, note: 'error' };
  }
}

// MAIN EXPORT
export async function immune(text, targetLayer) {
  if (targetLayer === 'cortex') {
    return { allowed: true, layer: 'cortex', reason: 'free entry', scores: {} };
  }
  if (!text || typeof text !== 'string' || text.trim().length < 5) {
    return { allowed: true, layer: targetLayer, reason: 'short text, pass-through', scores: {} };
  }
  try {
    return await Promise.race([
      _evaluate(text, targetLayer),
      new Promise((_, reject) => setTimeout(() => reject(new Error('immune timeout 15s')), TIMEOUT_MS))
    ]);
  } catch (e) {
    const fallback = targetLayer === 'soul' ? 'core' : 'cortex';
    const reason = 'timeout -> ' + fallback;
    console.warn('[immune] ' + e.message + ' -> fallback ' + fallback);
    recordImmuneEvent(targetLayer, fallback, true, reason);
    return { allowed: true, layer: fallback, reason, scores: {} };
  }
}

async function _evaluate(text, targetLayer) {
  const config = CONFIG[targetLayer];
  if (!config) return { allowed: true, layer: targetLayer, reason: 'no config', scores: {} };

  const s1 = await layer1_semantic(text, targetLayer, config);

  if (targetLayer === 'core') {
    if (s1.pass) return _result(true, 'core', 'semantics: ' + s1.note, { s1 }, 'core');
    if (causalReady) {
      const s2 = await layer2_causal(text, config);
      if (s2.pass) return _result(true, 'core', 'causality: ' + s2.note, { s1, s2 }, 'core');
    }
    return _result(false, 'cortex', 'Core rejected: ' + s1.note, { s1 }, 'core');
  }

  // Soul: early exit on obvious semantics
  if (s1.score >= config.semanticAutoPass) {
    return _result(true, 'soul', 'auto-pass (semantics ' + s1.score.toFixed(3) + ')', { s1 }, 'soul');
  }

  const s2 = await layer2_causal(text, config);
  const s3 = await layer3_growth(text);

  const voters = [
    { name: 'semantics', pass: s1.pass, available: true },
    { name: 'causality', pass: s2.pass, available: s2.available },
    { name: 'growth', pass: s3.pass, available: s3.available },
  ];

  const active = voters.filter(v => v.available);
  const yes = active.filter(v => v.pass).length;
  const allowed = yes > active.length / 2;

  const tags = voters.map(v => {
    if (!v.available) return '\u25CB ' + v.name;
    return (v.pass ? '\u2713' : '\u2717') + ' ' + v.name;
  });

  const reason = (allowed ? 'ACCEPTED' : 'REJECTED') + ' [' + yes + '/' + active.length + '] ' + tags.join(' | ');
  return _result(allowed, allowed ? 'soul' : 'core', reason, { s1, s2, s3 }, 'soul');
}

// reason classification for statistics
function classifyReason(reason, allowed) {
  if (reason.includes('forgetting')) return 'forgettingProtected';
  if (reason.includes('timeout')) return 'timeout';
  if (reason.includes('auto-pass')) return 'semanticAutoPass';
  if (reason.includes('semantics:') && allowed) return 'semanticThreshold';
  if (reason.includes('causality:') && allowed) return 'causalDepth';
  if (reason.includes('ttl') || reason.includes('TTL')) return 'ttlExpired';
  if (reason.includes('REJECTED') || reason.includes('rejected')) return 'soulProtection';
  if (reason.includes('fallback') || reason.includes('error')) return 'fallbackCore';
  return 'fallbackCore';
}

// record immune event in submarine/data/immune-stats.json
// Fire-and-forget, try-catch, atomic write (temp + rename)
function recordImmuneEvent(targetLayer, resultLayer, allowed, reason) {
  try {
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    let stats;
    try {
      stats = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    } catch {
      stats = {
        counters: { total: 0, accepted: 0, rejected: 0, advisory: 0 },
        byReason: { semanticAutoPass: 0, semanticThreshold: 0, causalDepth: 0, ttlExpired: 0, timeout: 0, fallbackCore: 0, soulProtection: 0, forgettingProtected: 0 },
        byLayer: { Soul: { accepted: 0, rejected: 0 }, Core: { accepted: 0, rejected: 0 }, Cortex: { accepted: 0, rejected: 0 } },
        recentEvents: [],
        lastUpdated: null
      };
    }
    stats.counters.total++;
    if (allowed) stats.counters.accepted++;
    else stats.counters.rejected++;
    // advisory: record passed, but layer was downgraded
    if (allowed && targetLayer !== resultLayer) stats.counters.advisory++;

    const reasonKey = classifyReason(reason, allowed);
    if (stats.byReason[reasonKey] !== undefined) stats.byReason[reasonKey]++;

    const layerKey = targetLayer.charAt(0).toUpperCase() + targetLayer.slice(1);
    if (stats.byLayer[layerKey]) {
      if (allowed) stats.byLayer[layerKey].accepted++;
      else stats.byLayer[layerKey].rejected++;
    }

    stats.recentEvents.unshift({
      ts: new Date().toISOString(),
      target: targetLayer,
      result: resultLayer,
      ok: allowed,
      reason: reason.substring(0, 150)
    });
    if (stats.recentEvents.length > 200) stats.recentEvents.length = 200;
    stats.lastUpdated = new Date().toISOString();

    const tmpFile = STATS_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(stats, null, 2));
    renameSync(tmpFile, STATS_FILE);
  } catch { /* fire-and-forget — do not break the pipeline */ }
}

function _result(allowed, layer, reason, scores, targetLayer) {
  console.log('[immune] ' + layer.toUpperCase() + ': ' + reason);
  if (targetLayer) recordImmuneEvent(targetLayer, layer, allowed, reason);
  return { allowed, layer, reason, scores };
}

export default immune;
