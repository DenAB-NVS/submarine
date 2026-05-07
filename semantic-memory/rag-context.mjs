#!/usr/bin/env node
/**
 * submarine RAG Context Injection — CLI wrapper
 * ==============================================
 * Delegates to core/rag.mjs (getRAGContext) — unified facade
 * with thermal filter and causal chains.
 *
 * Usage:
 *   node rag-context.mjs "your query text"
 *   node rag-context.mjs --text "your query text"
 *
 * Output: JSON with relevant context from semantic memory
 *
 * Created: 2026-03-14
 * Refactored: 2026-03-31
 */

import { getRAGContext } from '../core/rag.mjs';

// ============================================================
// CLI: takes query as argv, outputs JSON
// ============================================================

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--text');
  const query = args.join(' ');
  const textMode = process.argv.includes('--text');

  if (!query) {
    console.log('Usage: node rag-context.mjs "your query here"');
    console.log('Returns JSON with relevant context from semantic memory.');
    process.exit(0);
  }

  const context = await getRAGContext(query, {
    useFourPass: true,
    useThermalFilter: true
  });

  if (textMode) {
    if (context.cached) {
      console.log(`[CACHE HIT] ${context.cached.response}`);
    } else if (context.contextText) {
      console.log(context.contextText);
    } else {
      console.log('[No relevant context found]');
    }
  } else {
    console.log(JSON.stringify({
      cached: context.cached ? true : false,
      memoriesCount: context.memories.length,
      knowledgeCount: context.knowledge.length,
      memories: context.memories.map(m => ({
        text: m.text,
        category: m.category,
        score: (m.weightedScore || m.score)?.toFixed(3)
      })),
      knowledge: context.knowledge.map(k => ({
        text: (k.text || '').substring(0, 150),
        section: k.section || k.source_file || 'unknown',
        similarity: k.similarity?.toFixed(3)
      })),
      contextText: context.contextText,
      searchMode: context.searchMeta ? 'fourPass' : 'standard',
      couplingScore: context.searchMeta?.couplingScore ?? null
    }, null, 2));
  }
}

export { getRAGContext };

// Only run as CLI, not when imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
