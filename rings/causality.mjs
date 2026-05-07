/**
 * Ring 3 — Causality (Origin)
 *
 * Closes: Snapshot <-> History
 * Compass: Decision -> causal-graph.json -> traverse edges relation=causes upward -> chain -> ↳ Path:
 *
 * Ring contract:
 *   name, version, canActivate(config, context), enrich(artifacts, config, context)
 *
 * Graph: 681 edges, fields sourceText/targetText/relation/sourceId/targetId.
 * Many edges incomplete (null IDs) — search by text.
 * Cost: $0. JSON reading + text search.
 *
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig, getSubmarinePath } from '../src/config.mjs';

export const name = 'causality';
export const version = '1.0.0';

// ─── Graph cache ───

let _cachedEdges = null;
let _cacheTime = 0;
const CACHE_TTL = 60000;

function loadGraph() {
  const now = Date.now();
  if (_cachedEdges && (now - _cacheTime) < CACHE_TTL) return _cachedEdges;

  const cfg = getConfig();
  const graphPath = join(getSubmarinePath(), cfg.paths?.causalGraph || 'data/causal-graph.json');
  if (!existsSync(graphPath)) return [];

  try {
    const raw = JSON.parse(readFileSync(graphPath, 'utf-8'));
    _cachedEdges = Array.isArray(raw) ? raw : (raw.edges || []);
    _cacheTime = now;
    return _cachedEdges;
  } catch(e) {
    console.warn(`[ring:causality] Graph load error: ${e.message}`);
    return [];
  }
}

// ─── Text matching ───

function normalize(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#_~`>*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—]\s+/, '')
    .trim()
    .toLowerCase();
}

function textSimilar(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb || na.length < 10 || nb.length < 10) return false;
  const short = na.length < nb.length ? na : nb;
  const long = na.length < nb.length ? nb : na;
  return long.includes(short.substring(0, Math.min(35, short.length)));
}

// ─── Finding causal chain by text ───

function findCausalChain(decisionText, edges, maxDepth) {
  const chain = [];
  let currentText = decisionText;
  let hasBehavioral = false;
  const visited = new Set();

  for (let depth = 0; depth < maxDepth; depth++) {
    const normCurrent = normalize(currentText);
    if (visited.has(normCurrent)) break;
    visited.add(normCurrent);

    const matching = edges.filter(e =>
      e.relation === 'causes' &&
      e.sourceText &&
      e.targetText &&
      textSimilar(e.targetText, currentText)
    );

    if (matching.length === 0) break;

    // Behavioral edges first, then by alpha/beta strength
    matching.sort((a, b) => {
      if (a.type === 'behavioral' && b.type !== 'behavioral') return -1;
      if (b.type === 'behavioral' && a.type !== 'behavioral') return 1;
      const sa = (a.alpha || 1) / ((a.alpha || 1) + (a.beta || 1));
      const sb = (b.alpha || 1) / ((b.alpha || 1) + (b.beta || 1));
      return sb - sa;
    });

    const causeEdge = matching[0];
    if (causeEdge.type === 'behavioral') hasBehavioral = true;

    chain.unshift(truncateChainItem(causeEdge.sourceText));
    currentText = causeEdge.sourceText;
  }

  if (hasBehavioral && chain.length > 0) {
    console.log(`[ring:causality] Behavioral chain found for: ${decisionText.slice(0, 50)}`);
  }

  return chain;
}

function truncateChainItem(text) {
  if (!text) return '?';
  const clean = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#_~`>*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—]\s+/, '')
    .trim();
  return clean.length > 50 ? clean.substring(0, 49) + '…' : clean;
}

// ─── Enrichment ───

function enrichSection(lines, soulItems, edges, maxDepth, maxAnnotations) {
  if (!soulItems || soulItems.length === 0) return 0;

  const insertions = [];
  let count = 0;

  for (const item of soulItems) {
    if (count >= maxAnnotations) break;

    const chain = findCausalChain(item.text, edges, maxDepth);
    if (chain.length === 0) continue;

    // Find the actual line position (indices may have shifted from other rings)
    let lineIndex = -1;
    const normItem = normalize(item.text);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('- ')) continue;
      const lineText = lines[i]
        .replace(/^- ⚡ \[\d+★\] /, '')
        .replace(/^- \(\d+[dh] ago\) /, '')
        .replace(/^- /, '')
        .trim();
      if (normalize(lineText).substring(0, 30) === normItem.substring(0, 30)) {
        lineIndex = i;
        break;
      }
    }
    if (lineIndex < 0) continue;

    const pathStr = chain.join(' → ');
    insertions.push({ index: lineIndex, pathStr });
    count++;
  }

  // Insert bottom-up to preserve indices
  insertions.sort((a, b) => b.index - a.index);
  for (const ins of insertions) {
    let targetIndex = ins.index + 1;
    while (
      targetIndex < lines.length &&
      lines[targetIndex]?.trimStart().startsWith('↳')
    ) {
      targetIndex++;
    }
    lines.splice(targetIndex, 0, `  ↳ Path: ${ins.pathStr}`);
  }

  return count;
}

// ─── Ring contract ───

export function canActivate(config, context) {
  const ringCfg = config.rings?.causality;
  if (ringCfg && ringCfg.enabled === false) {
    console.log('[ring:causality] Disabled in config');
    return false;
  }

  const edges = loadGraph();
  if (edges.length < 5) {
    console.log(`[ring:causality] Graph too small (${edges.length} edges), deactivating`);
    return false;
  }

  const causesCount = edges.filter(e => e.relation === 'causes').length;
  console.log(`[ring:causality] Activated (${edges.length} edges, ${causesCount} causes)`);
  return true;
}

export async function enrich(artifacts, config, context) {
  const maxDepth = config.rings?.causality?.maxDepth || 3;
  const edges = loadGraph();
  const causesEdges = edges.filter(e => e.relation === 'causes' && e.sourceText && e.targetText);

  let totalAnnotations = 0;

  if (artifacts.focus?.soulItems?.length > 0) {
    totalAnnotations += enrichSection(
      artifacts.focus.lines, artifacts.focus.soulItems,
      causesEdges, maxDepth, 3
    );
  }

  if (artifacts.insights?.soulItems?.length > 0) {
    totalAnnotations += enrichSection(
      artifacts.insights.lines, artifacts.insights.soulItems,
      causesEdges, maxDepth, 3
    );
  }

  if (totalAnnotations > 0) {
    console.log(`[ring:causality] ${totalAnnotations} causal chain annotations`);
  }
}
