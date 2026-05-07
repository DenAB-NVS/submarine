/**
 * Ring 1 — Soul Resonance
 *
 * Closes: Identity <-> Context
 * Compass: Artifact -> Ollama BGE-M3 embed -> cosine with SOUL.md -> annotation ↳ Soul:
 *
 * Ring contract:
 *   name, version, canActivate(config, context), enrich(artifacts, config, context)
 *
 * Moved from crystal.mjs. No LLM — embeddings only.
 *
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig, getOllamaUrl, getOllamaModel, getWorkspacePath } from '../src/config.mjs';

export const name = 'soul';
export const version = '1.0.0';

// ─── Utilities (local copies, no dependency on crystal.mjs) ───

function readSafe(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  } catch { return ''; }
}

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
    .trim();
  return clean.length > max ? clean.substring(0, max) + '...' : clean;
}

// ─── Cache and internal functions (moved from crystal.mjs) ───

let _soulEmbeddings = null;

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

async function embedText(text) {
  try {
    const resp = await fetch(`${getOllamaUrl()}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: getOllamaModel(), input: text }),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.embeddings?.[0] || data.embedding || null;
  } catch(e) {
    return null;
  }
}

async function embedSoulStatements() {
  if (_soulEmbeddings) return _soulEmbeddings;

  const cfg = getConfig();
  const soulPath = join(getWorkspacePath(), cfg.adapterConfig?.soulPath || 'SOUL.md');
  const soul = readSafe(soulPath);
  if (!soul) {
    _soulEmbeddings = [];
    return _soulEmbeddings;
  }

  const statements = [];
  for (const line of soul.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') && trimmed.length < 30) continue;
    if (trimmed === '---' || trimmed === '***') continue;
    if (trimmed.length < 15) continue;

    let clean = trimmed
      .replace(/^#+\s*/, '')
      .replace(/^[-*]\s*/, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .trim();

    if (clean.length >= 15) statements.push(clean);
  }

  console.log(`[ring:soul] SOUL.md: ${statements.length} statements, starting embed...`);

  const results = [];
  for (const text of statements) {
    const vector = await embedText(text);
    if (vector) {
      results.push({ text, vector });
    }
  }

  console.log(`[ring:soul] SOUL.md: ${results.length}/${statements.length} embedded OK`);
  _soulEmbeddings = results;
  return _soulEmbeddings;
}

async function findSoulResonance(query, threshold) {
  if (!query || query.length < 10) return null;

  try {
    const soulEmbeds = await embedSoulStatements();
    if (soulEmbeds.length === 0) return null;

    const queryVector = await embedText(query);
    if (!queryVector) return null;

    let bestScore = -1;
    let bestText = null;

    for (const { text, vector } of soulEmbeds) {
      const score = cosineSim(queryVector, vector);
      if (score > bestScore) {
        bestScore = score;
        bestText = text;
      }
    }

    if (bestScore >= threshold && bestText) {
      console.log(`[ring:soul] Resonance: "${query.slice(0, 40)}..." → ${bestScore.toFixed(3)} → "${bestText.slice(0, 50)}..."`);
      return truncate(bestText, 120);
    }

    return null;
  } catch(e) {
    console.log(`[ring:soul] Resonance error: ${e.message}`);
    return null;
  }
}

async function enrichWithSoul(lines, items, threshold) {
  if (items.length === 0) return;
  const insertions = [];
  for (const item of items.slice(0, 10)) {
    const resonance = await findSoulResonance(item.text, threshold);
    if (resonance) {
      insertions.push({ index: item.insertAfterIndex, resonance });
    }
  }
  insertions.sort((a, b) => b.index - a.index);
  for (const r of insertions) {
    lines.splice(r.index + 1, 0, `  ↳ Soul: ${r.resonance}`);
  }
  if (insertions.length > 0) {
    console.log(`[ring:soul] Soul resonance: ${insertions.length} annotations`);
  }
}

// ─── Ring contract ───

export function canActivate(config, context) {
  const ringCfg = config.rings?.soul;
  if (ringCfg && ringCfg.enabled === false) {
    console.log('[ring:soul] Disabled in config');
    return false;
  }
  if (!context.ollamaAvailable) {
    console.log('[ring:soul] Ollama unavailable, deactivating');
    return false;
  }
  if (!context.soulMdExists) {
    console.log('[ring:soul] SOUL.md not found, deactivating');
    return false;
  }
  console.log('[ring:soul] Activated (Ollama OK, SOUL.md found)');
  return true;
}

export async function enrich(artifacts, config, context) {
  const threshold = config.rings?.soul?.threshold
    || config.crystal?.soulResonanceThreshold
    || 0.45;

  if (artifacts.focus?.soulItems?.length > 0) {
    await enrichWithSoul(artifacts.focus.lines, artifacts.focus.soulItems, threshold);
  }
  if (artifacts.insights?.soulItems?.length > 0) {
    await enrichWithSoul(artifacts.insights.lines, artifacts.insights.soulItems, threshold);
  }
}
