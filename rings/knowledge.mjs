/**
 * Ring 2 — Knowledge
 *
 * Closes: Threads <-> Knowledge
 * Takes a hot thread / decision, searches Core layer in LanceDB for records by topic,
 * adds annotation ↳ Knowledge: AFTER any existing ↳ Soul:
 *
 * Ring contract:
 *   name, version, canActivate(config, context), enrich(artifacts, config, context)
 *
 * Search: HTTP API /api/v1/memory/search?layer=core (not directSearch).
 * $0 — works through local submarine API.
 *
 */

import { getConfig, getServerPort, getApiKey } from '../src/config.mjs';

export const name = 'knowledge';
export const version = '1.0.0';

// ─── Utilities (local copies, isolated from crystal.mjs) ───

function truncate(text, max) {
  if (!text) return '';
  const clean = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#_~`>*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\n/g, ' ')
    .trim()
    .replace(/^[-–—]\s+/, '');
  return clean.length > max ? clean.substring(0, max) + '...' : clean;
}

// ─── Core search via HTTP API ───

async function searchCore(query, limit) {
  try {
    const url = `http://127.0.0.1:${getServerPort()}/api/v1/memory/search`
      + `?q=${encodeURIComponent(query)}&limit=${limit}&layer=core`;
    const resp = await fetch(url, {
      headers: { 'X-API-Key': getApiKey() },
      signal: AbortSignal.timeout(60000)
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).map(r => ({
      text: r.text || '',
      category: r.category || '?',
      score: r.weightedScore || r.score || 0,
      timestamp: r.timestamp || ''
    }));
  } catch(e) {
    console.log(`[ring:knowledge] Search error: ${e.message}`);
    return [];
  }
}

// ─── Enriching lines with knowledge from Core ───

async function enrichWithKnowledge(lines, minScore, maxResults, maxPerSection) {
  // Phase 1: collect all queries
  const queries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('- ')) continue;
    if (line.trimStart().startsWith('↳')) continue;

    let queryText = line
      .replace(/^- ⚡ \[\d+★\] /, '')
      .replace(/^- \(\d+[dh] ago\) /, '')
      .replace(/^- /, '')
      .replace(/ \(\d+[dh]\)$/, '')
      .trim();

    if (queryText.length < 10) continue;
    queries.push({ lineIndex: i, queryText });
  }

  if (queries.length === 0) return;

  // Phase 2: parallel search (all queries simultaneously)
  const searchResults = await Promise.allSettled(
    queries.map(q =>
      searchCore(q.queryText, maxResults + 2).then(results => ({ ...q, results }))
    )
  );

  // Phase 3: collect insertions
  const insertions = [];
  let count = 0;

  for (const result of searchResults) {
    if (count >= maxPerSection) break;
    if (result.status !== 'fulfilled') continue;
    const { lineIndex, queryText, results } = result.value;

    const relevant = results.filter(r =>
      r.score >= minScore &&
      ['decision', 'lesson', 'fact', 'technical'].includes(r.category)
    );
    if (relevant.length === 0) continue;

    // Find the first non-self-referential result
    const normQuery = queryText.substring(0, 40).toLowerCase();
    let annotation = null;
    for (const r of relevant) {
      const candidate = truncate(r.text, 120);
      if (!candidate || candidate.length < 5) continue;
      const normCand = candidate.substring(0, 40).toLowerCase();
      if (normQuery === normCand || normCand.startsWith(normQuery) || normQuery.startsWith(normCand)) continue;
      annotation = candidate;
      break;
    }
    if (!annotation) continue;

    let insertAt = lineIndex + 1;
    while (insertAt < lines.length && lines[insertAt].trimStart().startsWith('↳')) {
      insertAt++;
    }

    insertions.push({ index: insertAt, annotation });
    count++;
  }

  // Reverse insertion order to preserve indices
  insertions.sort((a, b) => b.index - a.index);
  for (const ins of insertions) {
    lines.splice(ins.index, 0, `  ↳ Knowledge: ${ins.annotation}`);
  }

  if (insertions.length > 0) {
    console.log(`[ring:knowledge] ${insertions.length} annotations`);
  }
}

// ─── Ring contract ───

export function canActivate(config, context) {
  const ringCfg = config.rings?.knowledge;
  if (ringCfg && ringCfg.enabled === false) {
    console.log('[ring:knowledge] Disabled in config');
    return false;
  }
  if (!context.serverAvailable) {
    console.log('[ring:knowledge] submarine API unavailable, deactivating');
    return false;
  }
  console.log('[ring:knowledge] Activated (API OK)');
  return true;
}

export async function enrich(artifacts, config, context) {
  const minScore = config.rings?.knowledge?.minScore || 0.5;
  const maxResults = config.rings?.knowledge?.maxResults || 3;
  const maxPerSection = config.crystal?.maxEnrichmentsPerSection || 3;

  if (artifacts.focus?.lines?.length > 0) {
    await enrichWithKnowledge(artifacts.focus.lines, minScore, maxResults, maxPerSection);
  }
  if (artifacts.insights?.lines?.length > 0) {
    await enrichWithKnowledge(artifacts.insights.lines, minScore, maxResults, maxPerSection);
  }
}
