/**
 * submarine Semantic Memory Engine
 * ================================
 * LanceDB + bge-m3 (Ollama) = semantic memory
 *
 * Architecture:
 *   - Embedding: bge-m3 via Ollama (1024-dim, local, free)
 *   - Storage: LanceDB (embedded, zero infrastructure, ARM64 compatible)
 *   - Tables: memories (facts), knowledge (documents), decisions (architectural decisions)
 *
 * Created: 2026-03-14
 * Migrated to bge-m3: 2026-04-02
 */

import * as lancedb from '@lancedb/lancedb';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../src/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data', 'lancedb');
const OLLAMA_URL = 'http://localhost:11434';
const EMBED_MODEL = 'bge-m3';
const EMBED_DIM = 1024;
const RERANKER_URL = 'http://127.0.0.1:3200';

// ============================================================
// LRU Cache for embeddings (TTL 60s, max 50 entries)
// 60s = optimum: Ollama is local (~200ms/embed), but fresh records must be visible quickly
// (immune graph cache = 10min — different nature: graph is static between syncs)
// ============================================================

const _embeddingCache = new Map();
const EMBED_CACHE_TTL = 60_000;
const EMBED_CACHE_MAX = 50;

function _cacheKey(text) {
  return text.length > 200 ? text.substring(0, 200) + '|' + text.length : text;
}

function _evictExpired() {
  const now = Date.now();
  for (const [key, entry] of _embeddingCache) {
    if (now - entry.ts > EMBED_CACHE_TTL) _embeddingCache.delete(key);
  }
  // If still over max, evict oldest
  if (_embeddingCache.size > EMBED_CACHE_MAX) {
    const oldest = _embeddingCache.keys().next().value;
    _embeddingCache.delete(oldest);
  }
}

// Sparse query weights cache (same query → same weights)
const _sparseQueryCache = new Map();
const SPARSE_CACHE_TTL = 60_000;

// ============================================================
// Embeddings via Ollama
// ============================================================

async function getEmbedding(text, retries = 2) {
  const key = _cacheKey(text);
  const cached = _embeddingCache.get(key);
  if (cached && (Date.now() - cached.ts < EMBED_CACHE_TTL)) {
    return cached.vec;
  }
  // Truncate very long texts to stay within model context
  const truncated = text.length > 16000 ? text.substring(0, 16000) : text;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: truncated })
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        if (attempt < retries) {
          console.warn(`  ⚠ Ollama ${resp.status}, retry ${attempt + 1}...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`Ollama error ${resp.status}: ${body.substring(0, 100)}`);
      }
      const data = await resp.json();
      const vec = Array.from(data.embedding);
      _evictExpired();
      _embeddingCache.set(key, { vec, ts: Date.now() });
      return vec;
    } catch (e) {
      if (attempt < retries) {
        console.warn(`  ⚠ ${e.message}, retry ${attempt + 1}...`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
}

async function getEmbeddings(texts) {
  const results = [];
  for (const text of texts) {
    results.push(await getEmbedding(text));
  }
  return results;
}

// ============================================================
// Reranking via BGE Reranker Daemon
// ============================================================

async function rerank(query, documents, topN = 5) {
  if (process.env.SKIP_RERANK === '1') return null;
  try {
    const resp = await fetch(`${RERANKER_URL}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, documents, top_n: topN }),
      signal: AbortSignal.timeout(10000) // 10s: ARM64 CPU, 20 docs ~5s
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.results; // [{index, score}] sorted by score desc
  } catch (_) {
    console.warn('[memory-engine] reranker unavailable, using raw scores');
    return null; // graceful fallback
  }
}

// ============================================================
// Sparse Lexical Weights via BGE-M3 Daemon (hybrid retrieval)
// ============================================================

async function getSparseWeights(texts) {
  try {
    const resp = await fetch(`${RERANKER_URL}/sparse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(10000) // 10s: ARM64 CPU, sparse for 20 docs
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.weights; // [{token: weight, ...}, ...]
  } catch (_) {
    return null; // graceful fallback — dense-only
  }
}

/**
 * Compute sparse similarity between two lexical weight maps.
 * Uses dot-product of shared tokens (BM25-like sparse matching).
 */
function sparseSimilarity(queryWeights, docWeights) {
  if (!queryWeights || !docWeights) return 0;
  let dotProduct = 0;
  let queryNorm = 0;
  for (const [token, qw] of Object.entries(queryWeights)) {
    queryNorm += qw * qw;
    if (token in docWeights) {
      dotProduct += qw * docWeights[token];
    }
  }
  let docNorm = 0;
  for (const dw of Object.values(docWeights)) {
    docNorm += dw * dw;
  }
  const denom = Math.sqrt(queryNorm) * Math.sqrt(docNorm);
  return denom > 0 ? dotProduct / denom : 0;
}

/**
 * Compute sparse scores for a query against multiple candidate texts.
 * Returns array of sparse similarity scores (0-1) aligned with candidates.
 */
async function computeSparseScores(query, candidateTexts) {
  // Check cache for query sparse weights
  const now = Date.now();
  const cachedQW = _sparseQueryCache.get(query);
  let queryWeights;

  if (cachedQW && (now - cachedQW.ts < SPARSE_CACHE_TTL)) {
    // Only compute sparse for candidates, reuse cached query weights
    queryWeights = cachedQW.weights;
    const candidateWeights = await getSparseWeights(candidateTexts);
    if (!candidateWeights) return null;
    const scores = [];
    for (const docWeights of candidateWeights) {
      scores.push(sparseSimilarity(queryWeights, docWeights));
    }
    return scores;
  }

  // No cache — compute all together
  const allTexts = [query, ...candidateTexts];
  const weights = await getSparseWeights(allTexts);
  if (!weights || weights.length < 2) return null;

  queryWeights = weights[0];
  // Cache query weights for reuse
  _sparseQueryCache.set(query, { weights: queryWeights, ts: now });
  // Evict stale entries
  for (const [k, v] of _sparseQueryCache) {
    if (now - v.ts > SPARSE_CACHE_TTL) _sparseQueryCache.delete(k);
  }

  const scores = [];
  for (let i = 1; i < weights.length; i++) {
    scores.push(sparseSimilarity(queryWeights, weights[i]));
  }
  return scores;
}

// ============================================================
// Database Connection
// ============================================================

let _db = null;

async function getDb() {
  if (!_db) {
    _db = await lancedb.connect(DB_PATH);
  }
  return _db;
}

// ============================================================
// Table: memories — extracted facts and insights
// ============================================================

async function ensureMemoriesTable(db) {
  const tables = await db.tableNames();
  if (tables.includes('memories')) {
    return db.openTable('memories');
  }

  // Create with initial dummy record (LanceDB requires schema)
  const table = await db.createTable('memories', [{
    vector: Array(EMBED_DIM).fill(0),
    text: '__init__',
    source: 'system',
    category: 'init',
    timestamp: new Date().toISOString(),
    importance: 0,
    active: false
  }]);

  return table;
}

/**
 * Add a memory fact
 * @param {string} text - The fact/memory text
 * @param {string} source - Where it came from (e.g., 'conversation', 'file', 'insight')
 * @param {string} category - Category (e.g., 'preference', 'fact', 'decision', 'lesson')
 * @param {number} importance - 1-10 scale
 */
async function addMemory(text, source = 'manual', category = 'fact', importance = 5) {
  const db = await getDb();
  const table = await ensureMemoriesTable(db);

  // Dedup: check if exact text already exists
  try {
    const existing = await table.query().limit(5000).toArray();
    if (existing.some(r => (r.text || '').trim() === text.trim())) {
      return { success: true, text: text.substring(0, 80) + '...', skipped: true };
    }
  } catch (_) { /* empty table, proceed */ }

  const vector = await getEmbedding(text);

  await table.add([{
    vector,
    text,
    source,
    category,
    timestamp: new Date().toISOString(),
    importance,
    active: true
  }]);

  return { success: true, text: text.substring(0, 80) + '...' };
}

/**
 * Search memories by semantic similarity
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @param {number} minScore - Minimum similarity (0-1)
 * @returns {Array} Matching memories
 */
async function searchMemories(query, limit = 5, minScore = 0.3, categoryFilter = null, options = {}) {
  const db = await getDb();
  const table = await ensureMemoriesTable(db);
  const vector = await getEmbedding(query);

  let searchQuery = table.search(vector);

  // Pre-filter by category IN LanceDB query (critical for layer-specific searches)
  // Without this, Soul/Core/Cortex searches compete against ALL 2000+ records
  // and temporal decay kills older Soul entries before they reach category filtering
  if (categoryFilter) {
    if (Array.isArray(categoryFilter)) {
      const conditions = categoryFilter.map(c => `category = '${c}'`).join(' OR ');
      searchQuery = searchQuery.where(`(${conditions})`);
    } else {
      searchQuery = searchQuery.where(`category = '${categoryFilter}'`);
    }
  }

  const rawResults = await searchQuery
    .limit(20) // over-fetch for reranking
    .toArray();

  // LanceDB returns L2 distance. Lower = more similar.
  // For bge-m3 (1024-dim, unnormalized, norm ~26), typical L2 distances:
  //   < 400 = very similar, 400-600 = related, 600-800 = tangential, > 800 = unrelated
  const maxDistance = getConfig().search?.maxDistance ?? 800;
  const now = Date.now();

  // Temporal decay: gamma^(age_in_hours)
  // 0.999 = slow decay (facts persist for weeks)
  // 0.995 = medium (days)
  // 0.99  = fast (hours)
  const GAMMA = 0.998; // ~30 day half-life

  const scored = rawResults
    .filter(r => r.active !== false && r.text !== '__init__')
    .filter(r => (r._distance || Infinity) < maxDistance)
    .map(r => {
      // For unnormalized BGE-M3 (norm ~26), scale factor = 1200
      const baseSimilarity = Math.max(0, 1 - (r._distance || 0) / 1200);

      // Apply temporal decay
      let ageHours = 0;
      if (r.timestamp) {
        const ts = new Date(r.timestamp).getTime();
        if (!isNaN(ts)) ageHours = Math.max(0, (now - ts) / 3600000);
      }
      const recency = Math.pow(GAMMA, ageHours);

      // Boost by importance (1-10 → 0.5-1.5 multiplier)
      const importanceBoost = 0.5 + (r.importance || 5) / 10;

      // Final score combines semantic similarity, recency, and importance
      const score = baseSimilarity * recency * importanceBoost;

      return {
        text: r.text,
        source: r.source,
        category: r.category,
        importance: r.importance,
        timestamp: r.timestamp,
        distance: r._distance,
        similarity: baseSimilarity,
        recency: recency,
        score: score
      };
    })
    .sort((a, b) => b.score - a.score); // Re-rank by composite score

  if (!options.skipRerank) {
    // Hybrid scoring: sparse lexical weights
    const candidateTexts = scored.map(r => r.text);
    const sparseScores = await computeSparseScores(query, candidateTexts);
    if (sparseScores) {
      for (let i = 0; i < scored.length; i++) {
        const denseScore = scored[i].score;
        const sparseScore = sparseScores[i] || 0;
        scored[i].sparseScore = sparseScore;
        // Blend: 70% dense (with recency/importance), 30% sparse
        scored[i].score = 0.7 * denseScore + 0.3 * sparseScore;
      }
      scored.sort((a, b) => b.score - a.score);
    }

    // Neural reranking via BGE reranker (final precision pass)
    const docs = scored.map(r => r.text);
    const reranked = await rerank(query, docs, limit);
    if (reranked) {
      return reranked.map(r => ({ ...scored[r.index], rerankerScore: r.score }));
    }
  }
  return scored.slice(0, limit);
}

// ============================================================
// Table: knowledge — documents and reference material
// ============================================================

async function ensureKnowledgeTable(db) {
  const tables = await db.tableNames();
  if (tables.includes('knowledge')) {
    return db.openTable('knowledge');
  }

  const table = await db.createTable('knowledge', [{
    vector: Array(EMBED_DIM).fill(0),
    text: '__init__',
    source_file: 'system',
    chunk_index: 0,
    section: '',
    timestamp: new Date().toISOString(),
    active: false
  }]);

  return table;
}

/**
 * Chunk text into overlapping segments
 */
function chunkText(text, chunkSize = 400, overlap = 50) {
  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap from end of previous chunk
      const words = current.split(/\s+/);
      const overlapWords = words.slice(-Math.ceil(overlap / 5));
      current = overlapWords.join(' ') + ' ' + sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/**
 * Index a document into knowledge base
 * @param {string} filePath - Path to the file
 * @param {string} section - Section/category name
 */
async function indexDocument(filePath, section = '') {
  const db = await getDb();
  const table = await ensureKnowledgeTable(db);
  const text = readFileSync(filePath, 'utf-8');
  const chunks = chunkText(text);

  console.log(`Indexing ${filePath}: ${chunks.length} chunks`);

  const records = [];
  let skipped = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const vector = await getEmbedding(chunks[i]);
      records.push({
        vector,
        text: chunks[i],
        source_file: filePath,
        chunk_index: i,
        section: section || filePath.split('/').pop(),
        timestamp: new Date().toISOString(),
        active: true
      });
    } catch (e) {
      console.warn(`  ⚠ Skipping chunk ${i}: ${e.message}`);
      skipped++;
    }

    // Progress
    if ((i + 1) % 10 === 0) {
      console.log(`  ${i + 1}/${chunks.length} chunks embedded`);
    }
  }
  if (skipped) console.warn(`  ⚠ Skipped ${skipped} chunks`);

  await table.add(records);
  console.log(`Indexed ${records.length} chunks from ${filePath}`);
  return { chunks: records.length, file: filePath };
}

/**
 * Search knowledge base
 */
async function searchKnowledge(query, limit = 5) {
  const db = await getDb();
  const table = await ensureKnowledgeTable(db);
  const vector = await getEmbedding(query);

  const rawResults = await table.search(vector)
    .limit(20)
    .toArray();

  const filtered = rawResults
    .filter(r => r.active !== false && r.text !== '__init__')
    .map(r => ({
      text: r.text,
      source_file: r.source_file,
      section: r.section,
      chunk_index: r.chunk_index,
      similarity: Math.max(0, 1 - (r._distance || 0) / 1200)
    }));

  // Hybrid scoring: sparse lexical weights
  const candidateTexts = filtered.map(r => r.text);
  const sparseScores = await computeSparseScores(query, candidateTexts);
  if (sparseScores) {
    for (let i = 0; i < filtered.length; i++) {
      const denseScore = filtered[i].similarity;
      const sparseScore = sparseScores[i] || 0;
      filtered[i].sparseScore = sparseScore;
      filtered[i].similarity = 0.7 * denseScore + 0.3 * sparseScore;
    }
    filtered.sort((a, b) => b.similarity - a.similarity);
  }

  // Neural reranking (final precision pass)
  const docs = filtered.map(r => r.text);
  const reranked = await rerank(query, docs, limit);
  if (reranked) {
    return reranked.map(r => ({ ...filtered[r.index], rerankerScore: r.score }));
  }
  return filtered.slice(0, limit);
}

// ============================================================
// Table: decisions — architectural decisions from debate
// ============================================================

async function ensureDecisionsTable(db) {
  const tables = await db.tableNames();
  if (tables.includes('decisions')) {
    return db.openTable('decisions');
  }

  const table = await db.createTable('decisions', [{
    vector: Array(EMBED_DIM).fill(0),
    text: '__init__',
    problem: '',
    chosen: '',
    alternatives: '',
    reasoning: '',
    pipeline_id: '',
    debate_rounds: 0,
    timestamp: new Date().toISOString(),
    active: false
  }]);

  return table;
}

/**
 * Save an architectural decision from debate
 * @param {object} decision - Decision record
 * @param {string} decision.problem - What problem was being solved
 * @param {string} decision.chosen - Chosen solution
 * @param {string} decision.alternatives - What alternatives were considered
 * @param {string} decision.reasoning - Why this was chosen
 * @param {string} decision.pipeline_id - Which pipeline produced this
 * @param {number} decision.debate_rounds - How many debate rounds
 */
async function addDecision(decision) {
  const db = await getDb();
  const table = await ensureDecisionsTable(db);

  // Embed the problem + chosen solution for search
  const searchText = `${decision.problem} ${decision.chosen} ${decision.reasoning}`;
  const vector = await getEmbedding(searchText);

  await table.add([{
    vector,
    text: searchText,
    problem: decision.problem || '',
    chosen: decision.chosen || '',
    alternatives: decision.alternatives || '',
    reasoning: decision.reasoning || '',
    pipeline_id: decision.pipeline_id || '',
    debate_rounds: decision.debate_rounds || 0,
    timestamp: new Date().toISOString(),
    active: true
  }]);

  return { success: true, problem: decision.problem.substring(0, 80) };
}

/**
 * Find similar past decisions for debate context
 * @param {string} problem - Current problem description
 * @param {number} limit - Max results
 * @returns {Array} Similar past decisions
 */
async function searchDecisions(problem, limit = 3) {
  const db = await getDb();
  const table = await ensureDecisionsTable(db);
  const vector = await getEmbedding(problem);

  const rawResults = await table.search(vector)
    .limit(20)
    .toArray();

  const filtered = rawResults
    .filter(r => r.active !== false && r.text !== '__init__')
    .map(r => ({
      text: r.text,
      problem: r.problem,
      chosen: r.chosen,
      alternatives: r.alternatives,
      reasoning: r.reasoning,
      pipeline_id: r.pipeline_id,
      debate_rounds: r.debate_rounds,
      timestamp: r.timestamp,
      similarity: Math.max(0, 1 - (r._distance || 0) / 1200)
    }));

  // Hybrid scoring: sparse lexical weights
  const candidateTexts = filtered.map(r => r.text || r.problem);
  const sparseScores = await computeSparseScores(problem, candidateTexts);
  if (sparseScores) {
    for (let i = 0; i < filtered.length; i++) {
      const denseScore = filtered[i].similarity;
      const sparseScore = sparseScores[i] || 0;
      filtered[i].sparseScore = sparseScore;
      filtered[i].similarity = 0.7 * denseScore + 0.3 * sparseScore;
    }
    filtered.sort((a, b) => b.similarity - a.similarity);
  }

  // Neural reranking (final precision pass)
  const docs = filtered.map(r => r.text || r.problem);
  const reranked = await rerank(problem, docs, limit);
  if (reranked) {
    return reranked.map(r => ({ ...filtered[r.index], rerankerScore: r.score }));
  }
  return filtered.slice(0, limit);
}

// ============================================================
// Stats
// ============================================================

async function getStats() {
  const db = await getDb();
  const tables = await db.tableNames();
  const stats = { tables: {} };

  for (const name of tables) {
    const table = await db.openTable(name);
    const count = await table.countRows();
    stats.tables[name] = { rows: count };
  }

  return stats;
}

// ============================================================
// CLI Interface
// ============================================================

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'add': {
      const [text, source, category, importance] = args;
      const result = await addMemory(text, source, category, Number(importance) || 5);
      console.log('Added:', result);
      break;
    }

    case 'search': {
      const [query, limit] = args;
      const results = await searchMemories(query, Number(limit) || 5);
      console.log(`\nSearch: "${query}"\n`);
      for (const r of results) {
        const recencyStr = r.recency < 0.99 ? ` decay:${r.recency.toFixed(2)}` : '';
        console.log(`  [${r.score.toFixed(3)}] ${r.category}: ${r.text.substring(0, 100)}`);
        console.log(`         sim:${r.similarity.toFixed(2)} imp:${r.importance}${recencyStr} | ${r.source}\n`);
      }
      if (results.length === 0) console.log('  No results found.');
      break;
    }

    case 'search-knowledge': {
      const [query, limit] = args;
      const results = await searchKnowledge(query, Number(limit) || 5);
      console.log(`\nKnowledge search: "${query}"\n`);
      for (const r of results) {
        console.log(`  [${r.similarity.toFixed(3)}] ${r.section}: ${r.text.substring(0, 120)}...`);
        console.log(`         file: ${r.source_file}\n`);
      }
      if (results.length === 0) console.log('  No results found.');
      break;
    }

    case 'add-decision': {
      const [problem, chosen, alternatives, reasoning, pipelineId, rounds] = args;
      const result = await addDecision({
        problem, chosen, alternatives, reasoning,
        pipeline_id: pipelineId || '', debate_rounds: Number(rounds) || 0
      });
      console.log('Decision saved:', result);
      break;
    }

    case 'search-decisions': {
      const [query, limit] = args;
      const results = await searchDecisions(query, Number(limit) || 3);
      console.log(`\nSimilar decisions: "${query}"\n`);
      for (const r of results) {
        console.log(`  [${r.similarity.toFixed(3)}] Problem: ${r.problem}`);
        console.log(`         Chosen: ${r.chosen}`);
        console.log(`         Why: ${r.reasoning.substring(0, 100)}`);
        console.log(`         Rounds: ${r.debate_rounds} | Pipeline: ${r.pipeline_id}\n`);
      }
      if (results.length === 0) console.log('  No past decisions found.');
      break;
    }

    case 'index': {
      const [filePath, section] = args;
      const result = await indexDocument(filePath, section);
      console.log('Indexed:', result);
      break;
    }

    case 'stats': {
      const stats = await getStats();
      console.log('\nSemantic Memory Stats:\n');
      for (const [name, info] of Object.entries(stats.tables)) {
        console.log(`  ${name}: ${info.rows} records`);
      }
      break;
    }

    default:
      console.log(`
submarine Semantic Memory Engine
================================
Usage:
  node memory-engine.mjs add <text> [source] [category] [importance]
  node memory-engine.mjs search <query> [limit]
  node memory-engine.mjs search-knowledge <query> [limit]
  node memory-engine.mjs add-decision <problem> <chosen> <alternatives> <reasoning> [pipeline_id] [rounds]
  node memory-engine.mjs search-decisions <query> [limit]
  node memory-engine.mjs index <file-path> [section]
  node memory-engine.mjs stats
      `);
  }
}

// Exports for programmatic use
export {
  addMemory,
  searchMemories,
  searchKnowledge,
  addDecision,
  searchDecisions,
  indexDocument,
  getEmbedding,
  getStats,
  chunkText,
  getDb
};

// Only run as CLI, not when imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
