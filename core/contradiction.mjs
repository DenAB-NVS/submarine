/**
 * Contradiction Detection — detecting contradictions during writes
 * Phase 1 Synapse+Crystal: free, using BGE-M3 embeddings.
 *
 * === Causal Edge Schema ===
 *
 * When a contradiction is detected, the calling code (sync.mjs, contradiction-scan.mjs)
 * creates an edge in the causal graph with REAL record IDs:
 *
 *   sourceId  = ID of the new record (winner)
 *   targetId  = ID of the superseded record (outdated)
 *   relation  = "supersedes"
 *   layer     = record layer (soul|core)
 *
 * Edge uniqueness is determined by the pair (sourceId, targetId).
 * A separate edge ID is generated automatically in causal.mjs (rel_*).
 * cosine score is passed via the similarity field in the detectContradictions() result.
 *
 * Phantom edges with contra_* IDs (in older versions) are marked with legacySourceId/legacyTargetId.
 *
 */

import { getConfig } from '../src/config.mjs';

const NEGATION_WORDS = [
  'not ', 'no', 'without', 'removed', 'deleted', 'disabled', 'abandoned',
  'replaced', 'instead of', 'no longer', 'stopped', 'cancelled', 'closed',
  'broke', 'obsolete', 'deprecated', 'turned off',
  'switched from', 'migrated from', 'moved from', 'superseded',
  'dropped'
];

const _contradictionCfg = getConfig().contradiction || {};
const SIMILARITY_THRESHOLD = _contradictionCfg.similarityThreshold || 0.72;
const GREY_ZONE_THRESHOLD = _contradictionCfg.greyZoneThreshold || 0.55;

function hasNegation(text) {
  const lower = text.toLowerCase();
  return NEGATION_WORDS.some(w => lower.includes(w));
}

function checkContradiction(newText, existingText, similarity) {
  if (similarity < GREY_ZONE_THRESHOLD) {
    return { isContradiction: false, confidence: 'none', reason: 'low_similarity' };
  }
  const newHasNeg = hasNegation(newText);
  const oldHasNeg = hasNegation(existingText);
  if (similarity >= SIMILARITY_THRESHOLD && newHasNeg && !oldHasNeg) {
    return { isContradiction: true, confidence: 'high', reason: `sim=${similarity.toFixed(3)}, new negates old` };
  }
  if (similarity >= SIMILARITY_THRESHOLD && !newHasNeg && oldHasNeg) {
    return { isContradiction: true, confidence: 'high', reason: `sim=${similarity.toFixed(3)}, new replaces negated old` };
  }
  if (similarity >= SIMILARITY_THRESHOLD && newHasNeg && oldHasNeg) {
    return { isContradiction: false, confidence: 'none', reason: 'both_negative' };
  }
  if (similarity >= GREY_ZONE_THRESHOLD && similarity < SIMILARITY_THRESHOLD && newHasNeg) {
    return { isContradiction: false, confidence: 'low', reason: `grey_zone: sim=${similarity.toFixed(3)}` };
  }
  return { isContradiction: false, confidence: 'none', reason: 'no_negation_pattern' };
}

async function detectContradictions(text, targetLayer, options = {}) {
  const { searchFn, supersedeFn, addCausalFn } = options;
  if (!searchFn) return { contradictions: [], superseded: 0 };
  const result = { contradictions: [], superseded: 0 };
  try {
    const similar = await searchFn(text, 10);
    if (!similar || similar.length === 0) return result;
    for (const existing of similar) {
      const existingText = existing.text || '';
      const similarity = existing.similarity || existing.score || 0;
      if ((existing.layer === 'soul' || existing.category === 'identity') && targetLayer !== 'soul') continue;
      const check = checkContradiction(text, existingText, similarity);
      if (check.isContradiction) {
        const existingId = existing.id || (existing.source ? JSON.parse(existing.source).id : null);
        result.contradictions.push({ existingText: existingText.substring(0, 200), existingId, similarity, confidence: check.confidence, reason: check.reason });
        if (check.confidence === 'high' && supersedeFn && existingId) {
          try {
            await supersedeFn(existingId);
            result.superseded++;
            if (addCausalFn) await addCausalFn(text.substring(0, 200), existingText.substring(0, 200), 'supersedes');
          } catch (e) { /* supersede is non-critical */ }
        }
      }
    }
  } catch (e) { console.warn('[contradiction] error:', (e.message || '').substring(0, 80)); }
  return result;
}

export { detectContradictions, checkContradiction, hasNegation };
