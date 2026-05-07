/**
 * submarine RAG module — unified facade for semantic memory.
 * Replaces rag-context.mjs for all external consumers.
 *
 * @module submarine/rag
 * @author D. Ashford
 */

import { unifiedSearch, deepSearch } from '../src/layers.mjs';
import { searchKnowledge } from '../semantic-memory/memory-engine.mjs';
import { fileURLToPath } from 'url';

// Cluster filter (optional)
let clusterModule = null;
try {
  clusterModule = await import('../src/cluster.mjs');
} catch (e) {}

// Attempt to connect cache (optional)
let checkCache = null;
let storeCache = null;
try {
  const cache = await import('../semantic-memory/semantic-cache.mjs');
  checkCache = cache.checkCache;
  storeCache = cache.storeCache;
} catch (e) {}

// Synaptic bridge
let synapseModule = null;
try {
  synapseModule = await import('../src/synapse.mjs');
} catch (e) {
  console.warn('rag: synapse import failed, continuing without threads', e.message);
}

// Causal graph (optional)
let causalModule = null;
try {
  causalModule = await import('../src/causal.mjs');
  await causalModule.initGraph();
} catch (e) {}


/**
 * Retrieves relevant context from three-layer memory and knowledge base.
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @param {number} [options.memoryLimit=12] - Number of results from memory
 * @param {number} [options.knowledgeLimit=2] - Number of results from knowledge
 * @param {boolean} [options.checkCacheFirst=true] - Check cache first
 * @param {boolean} [options.useFourPass=false] - Use deep search
 * @param {boolean} [options.useClusterFilter=false] - Apply cluster filter
 * @returns {Promise<Object>} Object with context
 */
export async function getRAGContext(query, options = {}) {
  const {
    memoryLimit = 12,
    knowledgeLimit = 2,
    checkCacheFirst = true,
    useFourPass = false,
    useClusterFilter = false
  } = options;

  const result = {
    query,
    cached: null,
    memories: [],
    knowledge: [],
    contextText: ''
  };

  // 1. Check cache (if available and enabled)
  if (checkCacheFirst && checkCache) {
    try {
      const cached = await checkCache(query);
      if (cached) {
        result.cached = cached;
        return result;
      }
    } catch (err) {
      // Don't break the flow due to cache error
      console.warn('[rag] Cache check failed:', err.message);
    }
  }

  // 2. Search across three-layer memory
  let memoryResults = [];
  let searchMeta = null;
  try {
    if (useFourPass) {
      // Deep search: Soul -> Core (enriched) -> Coupling -> Cortex -> Surfacing
      const deepResult = await deepSearch(query, { totalLimit: memoryLimit });
      memoryResults = deepResult.results;
      searchMeta = deepResult.meta;
    } else {
      memoryResults = await unifiedSearch(query, memoryLimit);
    }

    // Cluster filter: select dense cluster (if enabled and module available)
    if (useClusterFilter && clusterModule && memoryResults.length > 1) {
      try {
        memoryResults = await clusterModule.clusterFilter(memoryResults);
      } catch (clusterErr) {
        console.warn('[rag] Cluster filter failed, using unfiltered:', clusterErr.message);
      }
    }
  } catch (err) {
    // Fallback: if search failed, import searchMemories directly
    console.warn('[rag] Search failed, falling back to searchMemories:', err.message);
    try {
      const { searchMemories } = await import('../semantic-memory/memory-engine.mjs');
      const raw = await searchMemories(query, memoryLimit);
      memoryResults = raw.map(r => ({
        ...r,
        layer: inferLayerFromCategory(r.category),
        weightedScore: r.score
      }));
    } catch (fallbackErr) {
      console.error('[rag] Fallback also failed:', fallbackErr.message);
    }
  }

  result.memories = memoryResults;

  // 3. Search knowledge base
  try {
    const knowledgeResults = await searchKnowledge(query, knowledgeLimit);
    result.knowledge = knowledgeResults;
  } catch (err) {
    console.warn('[rag] searchKnowledge failed:', err.message);
  }

  // 4. Build text context for prompt
  const parts = [];

  if (memoryResults.length > 0) {
    parts.push('## Memory (three-layer):');
    for (const mem of memoryResults) {
      const layerTag = mem.layer ? `[${mem.layer.toUpperCase()}]` : '[UNKNOWN]';
      const score = mem.weightedScore !== undefined ? mem.weightedScore : mem.score;
      parts.push(`- ${layerTag} ${mem.text} (score: ${score?.toFixed(2) ?? '?'})`);
    }

    // Causal chains for top results (if graph available)
    if (causalModule) {
      try {
        const causalParts = [];
        for (const mem of memoryResults.slice(0, 3)) {
          // Look up by sourceText in metadata
          const meta = mem.metadata || {};
          const memId = meta.id;
          if (!memId) continue;
          
          const causes = await causalModule.getCauses(memId, 2);
          const effects = await causalModule.getEffects(memId, 2);
          
          if (causes.length > 0 || effects.length > 0) {
            const chains = [];
            for (const c of causes) {
              chains.push(`← "${c.edge.sourceText}" (${c.edge.relation}, strength:${causalModule.getEdgeStats(c.edge).strength.toFixed(2)})`);
            }
            for (const e of effects) {
              chains.push(`→ "${e.edge.targetText}" (${e.edge.relation}, strength:${causalModule.getEdgeStats(e.edge).strength.toFixed(2)})`);
            }
            if (chains.length > 0) {
              causalParts.push(`  Causal: ${chains.join(' | ')}`);
            }
          }
        }
        if (causalParts.length > 0) {
          parts.push('## Causal chains:');
          parts.push(...causalParts);
        }
      } catch (e) {
        // causal graph is non-critical
      }
    }
  }

  // Live threads (synapse)
  if (synapseModule) {
    try {
      const threads = await synapseModule.weave(query, 3);
      if (threads.length > 0) {
        parts.push('## Live threads (synapse):');
        for (const t of threads) {
          const date = t.lastMention ? new Date(t.lastMention).toLocaleDateString('ru-RU') : '?';
          parts.push(`- [THREAD ${t.sourceSession}] ${t.direction} (lastMention: ${date})`);
        }
      }
    } catch (e) {
      // synapse is non-critical
    }
  }

  if (result.knowledge.length > 0) {
    parts.push('## Relevant knowledge:');
    for (const know of result.knowledge) {
      const source = know.section || know.source_file || 'unknown';
      parts.push(`- ${know.text} (from: ${source})`);
    }
  }

  // Search metadata (deep search mode)
  if (searchMeta) {
    parts.push(`## Search meta: ${searchMeta.passes}-pass, coupling=${searchMeta.couplingScore?.toFixed(3) ?? '?'}, soul=${searchMeta.soulCount}, core=${searchMeta.coreCount}, cortex=${searchMeta.cortexCount}`);
  }

  result.contextText = parts.join('\n');
  result.searchMeta = searchMeta;


  // Store in semantic cache
  if (storeCache && result.contextText && result.memories.length > 0) {
    try { await storeCache(query, result.contextText); } catch(e) { /* non-fatal */ }
  }

  return result;
}

/**
 * Infers layer from record category (for fallback mode)
 * @param {string} category - Category from memory-engine
 * @returns {string} 'soul', 'core', 'cortex' or 'unknown'
 */
function inferLayerFromCategory(category) {
  if (category === 'identity') return 'soul';
  if (category === 'episode') return 'cortex';
  if (['fact', 'decision', 'lesson', 'technical', 'finance', 'infrastructure'].includes(category)) {
    return 'core';
  }
  return 'unknown';
}

// ============================================================
// CLI mode for execSync from plugin
// ============================================================

if (process.argv.length > 2 && process.argv[1] === fileURLToPath(import.meta.url)) {
  const query = process.argv.slice(2).join(' ');
  const ctx = await getRAGContext(query, {
    useFourPass: true,
    useClusterFilter: true
  });
  console.log(JSON.stringify({
    cached: !!ctx.cached,
    memoriesCount: ctx.memories.length,
    knowledgeCount: ctx.knowledge.length,
    contextText: ctx.contextText,
    searchMode: ctx.searchMeta ? 'deep' : 'standard',
    couplingScore: ctx.searchMeta?.couplingScore ?? null
  }, null, 2));
}