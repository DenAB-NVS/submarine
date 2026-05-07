#!/usr/bin/env node
/**
 * Context Crystal — operational context for submarine
 * ======================================================
 * Crystal v1 answered "what do I remember?" — duplicating SOUL.md and MEMORY.md.
 * Crystal v2 answers "what do I need to know RIGHT NOW?"
 *
 * Three blocks (no bootstrap duplication):
 * 1. "Now" — recent crons, last conversation, errors
 * 2. "Claude Code" — recent records from bridge v2.1
 * 3. "Decisions and lessons" — only fresh (48h), not from Soul
 *
 * No LLM. From data: submarine API + memory-engine.
 * Cron: every 6 hours (same).
 * Run: node submarine/core/crystal.mjs
 *
 * @author D. Ashford
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getConfig, getServerPort, getOllamaUrl, getOllamaModel, getApiKey, getWorkspacePath } from '../src/config.mjs';

const __filename = fileURLToPath(import.meta.url);
const WORKSPACE = getWorkspacePath();
const _cfg = getConfig();
const CRYSTAL_PATH = join(WORKSPACE, _cfg.adapterConfig?.crystalOutputPath || 'CONTEXT-CRYSTAL.md');
const SNAPSHOT_PATH = join(WORKSPACE, 'crystal-prev-snapshot.json');

const API_BASE = `http://127.0.0.1:${getServerPort()}/api/v1`;
const API_KEY = getApiKey();

function readSafe(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  } catch { return ''; }
}

function nowISO() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}

function hoursAgo(isoString) {
  try {
    return (Date.now() - new Date(isoString).getTime()) / 3600000;
  } catch { return 999; }
}

function stripMd(text) {
  if (!text) return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#_~`>*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  if (!text) return '';
  const clean = stripMd(text).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.substring(0, max) + '...' : clean;
}

function humanizeSource(sourceSession, topic) {
  if (topic && topic.length > 3) {
    const words = topic
      .replace(/[#*_~`>\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(w => w.length > 2)
      .slice(0, 3)
      .join(' ');
    if (words.length > 3) return words.slice(0, 30);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(sourceSession)) {
    return sourceSession.slice(0, 10);
  }
  return sourceSession || '?';
}

async function apiGet(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

let directSearch = null;
try {
  const mem = await import('../semantic-memory/memory-engine.mjs');
  directSearch = mem.searchMemories;
  console.log('[crystal-v2] Direct memory-engine import OK');
} catch(e) {
  console.log('[crystal-v2] Direct import failed, using API fallback');
}

async function search(query, limit = 5) {
  if (!directSearch) return [];
  try {
    const results = await directSearch(query, limit);
    return results.map(r => ({
      text: r.text || '',
      category: r.category || '?',
      layer: r.layer || '?',
      importance: r.importance || 0,
      timestamp: r.timestamp || '',
      score: r.weightedScore || r.score || 0
    }));
  } catch(e) {
    console.warn('[crystal-v2] search failed:', e.message);
    return [];
  }
}

function buildSoulEssence() {
  const lines = [];
  const soulPath = join(WORKSPACE, _cfg.adapterConfig?.soulPath || 'SOUL.md');
  const soul = readSafe(soulPath);
  if (!soul) {
    lines.push('Soul: file not found');
    return lines;
  }

  // Identity: text right after "## Who am I" (or first paragraph without # > ---)
  const identityMatch = soul.match(/## (?:Who am I)[^\n]*\n([^\n#>-].+)/);
  if (identityMatch) {
    lines.push(truncate(identityMatch[1].trim(), 200));
  } else {
    const paragraphs = soul.split(/\n{2,}/);
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('>') || trimmed.startsWith('---')) continue;
      lines.push(truncate(trimmed, 200));
      break;
    }
  }

  // Principles: lines with keywords
  const principleRe = /principle|value|rule|mission|law|purpose/i;
  const soulLines = soul.split('\n');
  for (const line of soulLines) {
    if (lines.length >= 10) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') && principleRe.test(trimmed)) {
      lines.push(truncate(trimmed, 150));
    }
  }

  // Laws: section ## Laws
  const lawsMatch = soul.match(/## Laws\n([\s\S]*?)(?=\n##|\n---|\Z)/);
  if (lawsMatch) {
    const lawLines = lawsMatch[1].split('\n').filter(l => l.trim().startsWith('- '));
    for (const l of lawLines) {
      if (lines.length >= 10) break;
      const text = truncate(l.trim(), 150);
      if (!lines.includes(text)) lines.push(text);
    }
  }

  // Mission: section ## Mission (if present)
  const missionMatch = soul.match(/## Mission\n([\s\S]*?)(?=\n##|\n---|\Z)/);
  if (missionMatch) {
    const mText = missionMatch[1].trim().split('\n')[0];
    if (mText && lines.length < 10) {
      lines.push(`Mission: ${truncate(mText, 150)}`);
    }
  }

  return lines.slice(0, 10);
}

async function buildFocusBlock() {
  const lines = [];
  const soulItems = []; // v1.0.0: items for Soul enrichment

  // A) Synapse top-3 (importance >= 6)
  try {
    const synapse = await import('../src/synapse.mjs');
    const active = await synapse.getActive();
    const hot = active.filter(t => t.importance >= 6).slice(0, 3);
    if (hot.length > 0) {
      lines.push('### Hot threads (Synapse)');
      for (const t of hot) {
        const ageHours = Math.round(hoursAgo(t.createdAt || t.lastMention));
        const ageStr = ageHours > 48 ? `${Math.round(ageHours / 24)}d` : `${ageHours}h`;
        lines.push(`- ⚡ [${t.importance}★] ${truncate(t.direction, 120)} (${ageStr})`);
        soulItems.push({ text: t.direction || t.topic, insertAfterIndex: lines.length - 1 });
      }
    }
  } catch (e) {
    lines.push(`- Synapse unavailable: ${e.message}`);
  }

  // B) Core decisions top-3 for 72h
  try {
    const url = API_BASE + '/memory/search?q=' + encodeURIComponent('decision lesson') + '&limit=10&layer=core';
    const res = await fetch(url, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(30000)
    });
    if (res.ok) {
      const data = await res.json();
      const records = (data.results || [])
        .filter(r => hoursAgo(r.timestamp) < 72)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 3);

      // Fallback: if 72h is empty — last 3 without filter
      const final = records.length > 0 ? records : (data.results || [])
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 3);

      if (final.length > 0) {
        const isFallback = records.length === 0;
        lines.push(`### Key decisions${isFallback ? ' ⚠️ (outside 72h window)' : ''}`);
        for (const r of final) {
          const ago = Math.round(hoursAgo(r.timestamp));
          const agoStr = ago > 48 ? `${Math.round(ago / 24)}d` : `${ago}h`;
          lines.push(`- (${agoStr} ago) ${truncate(r.text, 150)}`);
          soulItems.push({ text: r.text, insertAfterIndex: lines.length - 1 });
        }
      }
    }
  } catch (e) {
    lines.push(`- Core decisions fetch error: ${e.message}`);
  }

  return { lines, soulItems };
}

async function buildNowBlock() {
  const lines = [];

  const recentEpisodes = await search('last conversation topic discussion', 5);
  const cortexBase = recentEpisodes
    .filter(r => r.layer === 'cortex' || r.category === 'episode' || r.category === 'resilient_episode');

  // Cascading fallback: 48h -> 7 days -> last 5 without filter
  let cortexEpisodes = cortexBase.filter(r => hoursAgo(r.timestamp) < 48).slice(0, 3);
  let episodeFallback = '';
  if (cortexEpisodes.length === 0) {
    cortexEpisodes = cortexBase.filter(r => hoursAgo(r.timestamp) < 168).slice(0, 3);
    if (cortexEpisodes.length === 0) {
      cortexEpisodes = cortexBase.slice(0, 5);
      if (cortexEpisodes.length > 0) episodeFallback = ' ⚠️ (archived, no recent)';
    } else {
      episodeFallback = ' ⚠️ (7 days, none in 48h)';
    }
  }

  if (cortexEpisodes.length > 0) {
    lines.push(`### Recent conversations${episodeFallback}`);
    for (const ep of cortexEpisodes) {
      const ago = Math.round(hoursAgo(ep.timestamp));
      const agoStr = ago > 48 ? `${Math.round(ago / 24)}d` : `${ago}h`;
      lines.push(`- (${agoStr} ago) ${truncate(ep.text, 150)}`);
    }
  }

  const errors = await search('error problem broke not working', 5);
  const errBase = errors.filter(r => r.text.match(/error|broke|not work|timeout|fail/i));

  // Cascading fallback for errors
  let recentErrors = errBase.filter(r => hoursAgo(r.timestamp) < 48).slice(0, 3);
  let errorFallback = '';
  if (recentErrors.length === 0) {
    recentErrors = errBase.filter(r => hoursAgo(r.timestamp) < 168).slice(0, 3);
    if (recentErrors.length === 0) {
      recentErrors = errBase.slice(0, 5);
      if (recentErrors.length > 0) errorFallback = ' ⚠️ (archived)';
    } else {
      errorFallback = ' ⚠️ (7 days)';
    }
  }

  if (recentErrors.length > 0) {
    lines.push(`### Current issues${errorFallback}`);
    for (const err of recentErrors) {
      const ago = Math.round(hoursAgo(err.timestamp));
      const agoStr = ago > 48 ? `${Math.round(ago / 24)}d` : `${ago}h`;
      lines.push(`- (${agoStr} ago) ${truncate(err.text, 150)}`);
    }
  }

  let s = null;
  try { const { getLayerStats } = await import('../src/layers.mjs'); s = await getLayerStats(); } catch (e) { /* stats unavailable */ }
  if (s) {
    const total = s.total?.count ?? s.total ?? '?';
    const soul = s.soul?.count ?? s.soul ?? '?';
    const core = s.core?.count ?? s.core ?? '?';
    const cortex = s.cortex?.count ?? s.cortex ?? '?';
    const edges = s.causalEdges?.count ?? s.causalEdges ?? '';
    lines.push('### submarine');
    lines.push(`- Records: ${total} (Soul: ${soul}, Core: ${core}, Cortex: ${cortex})`);
    if (edges) lines.push(`- Causal graph: ${edges} edges`);
    lines.push(`- Status: ok`);
  }

  return lines;
}

async function buildClaudeCodeBlock() {
  const lines = [];

  // Use HTTP API with layer=core for more precise search
  let bridgeRecords = [];
  try {
    const url = API_BASE + '/memory/search?q=' + encodeURIComponent('Claude Code') + '&limit=10&layer=core';
    const res = await fetch(url, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(30000)
    });
    if (res.ok) {
      const data = await res.json();
      bridgeRecords = (data.results || [])
        .filter(r => (r.text || '').includes('[Claude Code]'))
        .filter(r => hoursAgo(r.timestamp) < 72)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 5)
        .map(r => ({
          text: r.text || '',
          category: r.category || '?',
          timestamp: r.timestamp || ''
        }));
    }
  } catch(e) {
    console.warn('[crystal-v2] Claude Code HTTP search failed:', e.message);
  }

  if (bridgeRecords.length > 0) {
    for (const rec of bridgeRecords) {
      const ago = Math.round(hoursAgo(rec.timestamp));
      const cat = rec.category !== '?' ? ` [${rec.category}]` : '';
      lines.push(`- (${ago}h ago)${cat} ${truncate(rec.text, 200)}`);
    }
  } else {
    lines.push('- No recent records from Claude Code (last 72h)');
  }

  return lines;
}

function buildImmuneStatsBlock() {
  const lines = [];
  const statsPath = join(WORKSPACE, 'submarine', _cfg.paths?.immuneStats || join('data', 'immune-stats.json'));
  try {
    if (!existsSync(statsPath)) {
      lines.push('- Immune: no data (system running, statistics accumulating)');
      return lines;
    }
    const raw = readFileSync(statsPath, 'utf-8').trim();
    if (!raw) {
      lines.push('- Immune: no data (system running, statistics accumulating)');
      return lines;
    }
    const stats = JSON.parse(raw);
    const c = stats.counters || {};
    lines.push(`- Total: ${c.total || 0} (accepted: ${c.accepted || 0}, rejected: ${c.rejected || 0}, advisory: ${c.advisory || 0})`);

    if (stats.byLayer) {
      const parts = [];
      for (const [layer, data] of Object.entries(stats.byLayer)) {
        if (data.accepted || data.rejected) {
          parts.push(`${layer}: ${data.accepted || 0}\u2713/${data.rejected || 0}\u2717`);
        }
      }
      if (parts.length > 0) lines.push(`- By layers: ${parts.join(', ')}`);
    }

    if (stats.byReason) {
      const active = Object.entries(stats.byReason).filter(([, v]) => v > 0);
      if (active.length > 0) {
        lines.push(`- By reasons: ${active.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
      }
    }

    if (stats.lastUpdated) {
      const ago = Math.round(hoursAgo(stats.lastUpdated));
      lines.push(`- Last update: ${ago}h ago`);
    }
  } catch {
    lines.push('*Error reading immune-stats*');
  }
  return lines;
}

async function buildFreshInsightsBlock() {
  const lines = [];
  const seen = new Set();
  const soulItems = []; // v1.0.0: items for Soul enrichment

  const decisions = await search('decision decided chose switched', 5);
  const decBase = decisions
    .filter(r => r.layer !== 'soul')
    .filter(r => r.category === 'decision' || r.text.match(/decided|resolved|chose|switched/i));

  // Cascading fallback: 48h -> 7 days -> last 5
  let freshDecisions = decBase.filter(r => hoursAgo(r.timestamp) < 48).slice(0, 3);
  let decFallback = '';
  if (freshDecisions.length === 0) {
    freshDecisions = decBase.filter(r => hoursAgo(r.timestamp) < 168).slice(0, 3);
    if (freshDecisions.length === 0) {
      freshDecisions = decBase.slice(0, 5);
      if (freshDecisions.length > 0) decFallback = ' ⚠️ (archived)';
    } else {
      decFallback = ' ⚠️ (7 days)';
    }
  }

  if (freshDecisions.length > 0) {
    lines.push(`### Decisions${decFallback || ' (48h)'}`);
    for (const d of freshDecisions) {
      const key = truncate(d.text, 80);
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(`- ${truncate(d.text, 200)}`);
        soulItems.push({ text: d.text, insertAfterIndex: lines.length - 1 });
      }
    }
  }

  const lessons = await search('lesson conclusion error learned remember', 5);
  const lesBase = lessons
    .filter(r => r.layer !== 'soul')
    .filter(r => r.category === 'lesson' || r.text.match(/lesson|conclusion|remember|error/i));

  // Cascading fallback: 48h -> 7 days -> last 5
  let freshLessons = lesBase.filter(r => hoursAgo(r.timestamp) < 48).slice(0, 3);
  let lesFallback = '';
  if (freshLessons.length === 0) {
    freshLessons = lesBase.filter(r => hoursAgo(r.timestamp) < 168).slice(0, 3);
    if (freshLessons.length === 0) {
      freshLessons = lesBase.slice(0, 5);
      if (freshLessons.length > 0) lesFallback = ' ⚠️ (archived)';
    } else {
      lesFallback = ' ⚠️ (7 days)';
    }
  }

  if (freshLessons.length > 0) {
    lines.push(`### Lessons${lesFallback || ' (48h)'}`);
    for (const l of freshLessons) {
      const key = truncate(l.text, 80);
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(`- ${truncate(l.text, 200)}`);
        soulItems.push({ text: l.text, insertAfterIndex: lines.length - 1 });
      }
    }
  }

  return { lines, soulItems };
}

// v1.0.0 — Synapse threads in Crystal bootstrap (full, with archiveStale)
async function buildSynapseBlock() {
  const lines = [];
  try {
    const synapse = await import('../src/synapse.mjs');

    // Archive stale threads before generation
    await synapse.archiveStale();

    const active = await synapse.getActive();
    if (active.length === 0) {
      lines.push('- No active threads');
      return lines;
    }

    // Grouping: hot (importance >= 6) separately, others separately
    const hot = active.filter(t => t.importance >= 6);
    const normal = active.filter(t => t.importance < 6);

    lines.push(`- Active threads: ${active.length} (⚡${hot.length} hot)`);

    if (hot.length > 0) {
      lines.push('### ⚡ Hot (importance >= 6)');
      for (const t of hot) {
        const ageHours = Math.round(hoursAgo(t.createdAt || t.lastMention));
        const ageStr = ageHours > 48 ? `${Math.round(ageHours / 24)}d` : `${ageHours}h`;
        const src = humanizeSource(t.sourceSession, t.topic);
        lines.push(`- ⚡ [${t.importance}★] ${truncate(t.direction, 120)} (${ageStr}, ${src})`);
      }
    }

    if (normal.length > 0) {
      lines.push('### Other threads');
      for (const t of normal) {
        const ageHours = Math.round(hoursAgo(t.createdAt || t.lastMention));
        const ageStr = ageHours > 48 ? `${Math.round(ageHours / 24)}d` : `${ageHours}h`;
        const src = humanizeSource(t.sourceSession, t.topic);
        lines.push(`- [${t.importance}★] ${truncate(t.direction, 120)} (${ageStr}, ${src})`);
      }
    }

    // Recently closed (72h)
    try {
      const resolvedAll = await synapse.getThreads('resolved', 100);
      const since72h = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
      const recentResolved = resolvedAll
        .filter(t => (t.lastMention || t.createdAt) > since72h)
        .slice(0, 5);

      if (recentResolved.length > 0) {
        lines.push('### Recently closed (72h)');
        for (const t of recentResolved) {
          const ageHours = Math.round(hoursAgo(t.lastMention || t.createdAt));
          const ageStr = ageHours > 48 ? `${Math.round(ageHours / 24)}d` : `${ageHours}h`;
          const src = humanizeSource(t.sourceSession, t.topic);
          lines.push(`- [resolved] ${truncate(t.direction, 120)} (${ageStr}, ${src})`);
        }
      }
    } catch(e) { /* ok — resolved threads non-critical */ }

    // Totals: open/resolved/archived
    const all = await synapse.getThreads('all', 1000);
    const open = all.filter(t => t.status === 'open').length;
    const resolved = all.filter(t => t.status === 'resolved').length;
    const archived = all.filter(t => t.status === 'archived').length;
    lines.push(`- Total: ${open} open, ${resolved} closed, ${archived} archived`);
  } catch (e) {
    lines.push(`- Synapse unavailable: ${e.message}`);
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════
// v1.0.0 — Crystal Delta (snapshot for comparison)
// ═══════════════════════════════════════════════════════════

function saveCrystalSnapshot(metrics) {
  try {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(metrics, null, 2));
  } catch(e) { /* fire-and-forget */ }
}

function loadPrevSnapshot() {
  try {
    const raw = readFileSync(SNAPSHOT_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch(e) { return null; }
}

function buildDeltaLine(prev, current) {
  if (!prev) return '> Δ: first generation, no previous data';

  const parts = [];
  const diff = (key, label) => {
    const d = (current[key] || 0) - (prev[key] || 0);
    if (d !== 0) parts.push(`${label} ${d > 0 ? '+' : ''}${d}`);
  };

  diff('openThreads', 'threads');
  diff('resolvedThreads', 'resolved');
  diff('coreCount', 'Core');
  diff('cortexCount', 'Cortex');
  diff('causalEdges', 'edges');

  if (parts.length === 0) return '> Δ: no changes since last generation';
  return '> Δ since last generation: ' + parts.join(', ');
}

// ═══════════════════════════════════════════════════════════
// Pipeline: collect → enrich → extend → format → write
// Phase 0: architectural layering without changing output
// ═══════════════════════════════════════════════════════════

async function collectArtifacts() {
  const prevSnapshot = loadPrevSnapshot();

  const [focusResult, nowResult, ccResult, synapseResult, insightsResult] =
    await Promise.allSettled([
      buildFocusBlock(),
      buildNowBlock(),
      buildClaudeCodeBlock(),
      buildSynapseBlock(),
      buildFreshInsightsBlock()
    ]);

  const unwrapWithSoul = (result) =>
    result.status === 'fulfilled'
      ? result.value
      : { lines: [], soulItems: [], error: result.reason?.message || String(result.reason) };

  const unwrapLines = (result) =>
    result.status === 'fulfilled'
      ? { lines: result.value }
      : { lines: [], error: result.reason?.message || String(result.reason) };

  let soulEssence;
  try { soulEssence = { lines: buildSoulEssence() }; }
  catch (e) { soulEssence = { lines: [], error: e.message }; }

  let immune;
  try { immune = { lines: buildImmuneStatsBlock() }; }
  catch (e) { immune = { lines: [], error: e.message }; }

  return {
    soulEssence,
    focus: unwrapWithSoul(focusResult),
    now: unwrapLines(nowResult),
    claudeCode: unwrapLines(ccResult),
    immune,
    synapse: unwrapLines(synapseResult),
    insights: unwrapWithSoul(insightsResult),
    meta: {
      timestamp: new Date(),
      prevSnapshot,
      soulResonanceStatus: 'OFF'
    }
  };
}

async function buildRingContext() {
  const cfg = getConfig();
  let ollamaAvailable = false;
  try {
    const check = await fetch(`${getOllamaUrl()}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: getOllamaModel(), input: 'test' }),
      signal: AbortSignal.timeout(5000)
    });
    ollamaAvailable = check.ok;
  } catch(e) { /* Ollama unavailable */ }

  const soulPath = join(WORKSPACE, cfg.adapterConfig?.soulPath || 'SOUL.md');

  let serverAvailable = false;
  try {
    const healthCheck = await fetch(`http://127.0.0.1:${getServerPort()}/api/v1/health`, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(15000)
    });
    serverAvailable = healthCheck.ok;
  } catch(e) { /* Server unavailable */ }

  return {
    ollamaAvailable,
    soulMdExists: existsSync(soulPath),
    serverAvailable
  };
}

async function enrichWithRings(artifacts) {
  const config = getConfig();
  const context = await buildRingContext();
  artifacts.rings = { applied: [] };

  try {
    const soulRing = await import('../rings/soul.mjs');
    if (soulRing.canActivate(config, context)) {
      await soulRing.enrich(artifacts, config, context);
      artifacts.rings.applied.push(soulRing.name);
    }
  } catch(e) {
    console.warn(`[crystal] Ring 'soul' failed: ${e.message}`);
  }

  artifacts.meta.soulResonanceStatus = artifacts.rings.applied.includes('soul') ? 'ON' : 'OFF';

  // Ring 2: Knowledge
  try {
    const knowledgeRing = await import('../rings/knowledge.mjs');
    if (knowledgeRing.canActivate(config, context)) {
      await knowledgeRing.enrich(artifacts, config, context);
      artifacts.rings.applied.push(knowledgeRing.name);
    }
  } catch(e) {
    console.warn(`[crystal] Ring 'knowledge' failed: ${e.message}`);
  }

  // Ring 3: Causality
  try {
    const causalityRing = await import('../rings/causality.mjs');
    if (causalityRing.canActivate(config, context)) {
      await causalityRing.enrich(artifacts, config, context);
      artifacts.rings.applied.push(causalityRing.name);
    }
  } catch(e) {
    console.warn(`[crystal] Ring 'causality' failed: ${e.message}`);
  }

  // Ring metrics
  const allLines = [
    ...(artifacts.focus?.lines || []),
    ...(artifacts.insights?.lines || [])
  ];

  const soulCount = allLines.filter(l => l.includes('↳ Soul:')).length;
  const knowledgeCount = allLines.filter(l => l.includes('↳ Knowledge:')).length;
  const causalityCount = allLines.filter(l => l.includes('↳ Path:')).length;

  artifacts.rings.counts = {
    soul: soulCount,
    knowledge: knowledgeCount,
    causality: causalityCount,
    total: soulCount + knowledgeCount + causalityCount
  };

  const activeWithAnnotations = [
    soulCount > 0,
    knowledgeCount > 0,
    causalityCount > 0
  ].filter(Boolean).length;
  artifacts.rings.coverage = Math.round((activeWithAnnotations / 3) * 100);

  artifacts.rings.status = {
    soul: artifacts.rings.applied.includes('soul'),
    knowledge: artifacts.rings.applied.includes('knowledge'),
    causality: artifacts.rings.applied.includes('causality')
  };

  return artifacts;
}

async function runExtensions(artifacts) {
  const config = getConfig();
  try {
    const { getManifest } = await import('../src/manifest.mjs');
    const manifest = getManifest();

    if (manifest.extensions.length > 0) {
      const extensionsDir = config.paths?.extensions || 'extensions';
      for (const extName of manifest.extensions) {
        try {
          const ext = await import(`../${extensionsDir}/${extName}.mjs`);
          if (typeof ext.canActivate === 'function' && !ext.canActivate(config, { rings: artifacts.rings, manifest })) {
            console.log(`[crystal] Extension '${extName}' deactivated`);
            continue;
          }
          if (typeof ext.enrich === 'function') {
            await ext.enrich(artifacts, config, {
              rings: artifacts.rings,
              manifest
            });
            artifacts.rings.applied.push(`ext:${ext.name || extName}`);
            console.log(`[crystal] Extension '${ext.name || extName}' applied`);
          }
        } catch(e) {
          console.warn(`[crystal] Extension '${extName}' failed: ${e.message}`);
        }
      }
    }
  } catch(e) {
    // manifest unavailable — extensions don't load
  }
  return artifacts;
}

function formatCrystal(artifacts) {
  const sections = [];
  const now = artifacts.meta.timestamp;
  const ts = now.toISOString();
  const mskHours = (now.getUTCHours() + 3) % 24;
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(mskHours).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} MSK`;
  const rings = artifacts.rings || {};
  const rStatus = rings.status || {};
  const rCounts = rings.counts || {};

  sections.push('# CONTEXT-CRYSTAL.md — Operational context for submarine');
  sections.push(`> Generated: ${ts} | Crystal — v1.0.0 | Soul-resonance: ${artifacts.meta.soulResonanceStatus}`);
  sections.push(`> Updated: ${dateStr} · cron every 6h · if >12h ago — Crystal is stale`);
  sections.push(`> Rings: Soul ${rStatus.soul ? '✅' : '—'} | Knowledge ${rStatus.knowledge ? '✅' : '—'} | Path ${rStatus.causality ? '✅' : '—'}`);
  sections.push(`> Annotations: Soul ${rCounts.soul || 0} | Knowledge ${rCounts.knowledge || 0} | Path ${rCounts.causality || 0} | Coverage: ${rings.coverage || 0}%`);
  const deltaIdx = sections.length;
  sections.push('');
  sections.push('');

  sections.push('## Essence (Soul Essence)');
  if (artifacts.soulEssence.error) {
    sections.push(`- Soul Essence block error: ${artifacts.soulEssence.error}`);
  } else if (artifacts.soulEssence.lines.length > 0) {
    sections.push(...artifacts.soulEssence.lines);
  } else {
    sections.push('- Soul Essence: no data');
  }
  sections.push('');

  sections.push('## Current focus');
  if (artifacts.focus.error) {
    sections.push(`- Focus block error: ${artifacts.focus.error}`);
  } else if (artifacts.focus.lines.length > 0) {
    sections.push(...artifacts.focus.lines);
  } else {
    sections.push('- No hot threads or fresh decisions');
  }
  sections.push('');

  sections.push('## Operational picture');
  if (artifacts.now.error) {
    sections.push(`- Operational picture block error: ${artifacts.now.error}`);
  } else if (artifacts.now.lines.length > 0) {
    sections.push(...artifacts.now.lines);
  } else {
    sections.push('- No fresh data (submarine may be unavailable)');
  }
  sections.push('');

  sections.push('## Health');
  if (artifacts.immune.error) {
    sections.push(`- Health block error: ${artifacts.immune.error}`);
  } else {
    sections.push(...artifacts.immune.lines);
  }
  sections.push(`- Rings: Soul ${rCounts.soul || 0} | Knowledge ${rCounts.knowledge || 0} | Path ${rCounts.causality || 0}`);
  sections.push(`- Ring Coverage: ${rings.coverage || 0}%`);
  sections.push('');

  sections.push('## Live threads (Synapse)');
  if (artifacts.synapse.error) {
    sections.push(`- Synapse: ${artifacts.synapse.error}`);
  } else {
    sections.push(...artifacts.synapse.lines);
  }
  sections.push('');

  sections.push('## Fresh insights');
  if (artifacts.insights.error) {
    sections.push(`- Insights block error: ${artifacts.insights.error}`);
  } else if (artifacts.insights.lines.length > 0) {
    sections.push(...artifacts.insights.lines);
  } else {
    sections.push('- No fresh decisions or lessons');
  }

  return { sections, deltaIdx };
}

async function generateCrystal() {
  console.log('[crystal-block1] Generating operational crystal...');

  const artifacts = await collectArtifacts();
  await enrichWithRings(artifacts);
  await runExtensions(artifacts);
  const { sections, deltaIdx } = formatCrystal(artifacts);

  let currentMetrics = { timestamp: new Date().toISOString() };
  try {
    const synapse = await import('../src/synapse.mjs');
    const allThreads = await synapse.getThreads('all', 1000);
    currentMetrics.openThreads = allThreads.filter(t => t.status === 'open').length;
    currentMetrics.resolvedThreads = allThreads.filter(t => t.status === 'resolved').length;
    currentMetrics.archivedThreads = allThreads.filter(t => t.status === 'archived').length;
  } catch(e) { /* ok */ }
  try {
    const { getLayerStats } = await import('../src/layers.mjs');
    const s = await getLayerStats();
    if (s) {
      currentMetrics.soulCount = s.soul?.count ?? s.soul ?? 0;
      currentMetrics.coreCount = s.core?.count ?? s.core ?? 0;
      currentMetrics.cortexCount = s.cortex?.count ?? s.cortex ?? 0;
      currentMetrics.causalEdges = s.causalEdges?.count ?? s.causalEdges ?? 0;
    }
  } catch(e) { /* ok */ }
  currentMetrics.crystalLines = sections.join('\n').split('\n').length;

  sections[deltaIdx] = buildDeltaLine(artifacts.meta.prevSnapshot, currentMetrics);

  const crystal = sections.join('\n');

  writeFileSync(CRYSTAL_PATH, crystal, 'utf-8');
  saveCrystalSnapshot(currentMetrics);
  console.log(`[crystal-block1] Written: ${CRYSTAL_PATH} (${crystal.length} bytes, ${crystal.split('\n').length} lines)`);
  console.log('[crystal-block1] Done.');
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  generateCrystal().catch(err => {
    console.error('[crystal-v2] FATAL:', err.message);
    process.exit(1);
  });
}

export { generateCrystal, collectArtifacts, formatCrystal };
