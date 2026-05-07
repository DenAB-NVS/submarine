/**
 * submarine Semantic Cache
 * ========================
 * Caches responses by semantic similarity of queries.
 * If a question is similar to one already answered (cosine > threshold) —
 * returns cached result instead of calling the LLM.
 *
 * Savings: 100% tokens on repeated/similar queries.
 *
 * Created: 2026-03-14
 */

import * as lancedb from '@lancedb/lancedb';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data', 'lancedb');
const OLLAMA_URL = 'http://localhost:11434';
const EMBED_MODEL = 'bge-m3';

// Cache settings
const MAX_DISTANCE = 250;    // L2 distance threshold — very strict (high similarity required)
const CACHE_TTL_MS = 21600000; // 6 hours // 1 hour TTL for cache entries
const MAX_CACHE_SIZE = 1000;

// ============================================================
// Embedding
// ============================================================

async function getEmbedding(text) {
  const truncated = text.length > 4000 ? text.substring(0, 4000) : text;
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: truncated })
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return Array.from(data.embedding);
}

// ============================================================
// Cache Table
// ============================================================

let _db = null;
async function getDb() {
  if (!_db) _db = await lancedb.connect(DB_PATH);
  return _db;
}

async function ensureCacheTable(db) {
  const tables = await db.tableNames();
  if (tables.includes('cache')) {
    return db.openTable('cache');
  }
  return db.createTable('cache', [{
    vector: Array(1024).fill(0),
    query: '__init__',
    response: '',
    model: '',
    timestamp: 0,
    hits: 0,
    active: false
  }]);
}

// ============================================================
// Core API
// ============================================================

/**
 * Check if a similar query exists in cache
 * @param {string} query - The user query
 * @returns {string|null} Cached response or null
 */
async function checkCache(query) {
  try {
    const vector = await getEmbedding(query);
    if (!vector) return null;

    const db = await getDb();
    const table = await ensureCacheTable(db);

    const results = await table.search(vector).limit(1).toArray();

    if (results.length === 0) return null;

    const best = results[0];
    const now = Date.now();

    // Check: active, distance threshold, TTL
    if (!best.active) return null;
    if (best._distance > MAX_DISTANCE) return null;
    if (now - best.timestamp > CACHE_TTL_MS) return null;
    if (best.query === '__init__') return null;

    return {
      response: best.response,
      model: best.model,
      distance: best._distance,
      age_seconds: Math.round((now - best.timestamp) / 1000),
      cached: true
    };
  } catch (e) {
    // Cache should never break the main flow
    console.warn(`Cache check error: ${e.message}`);
    return null;
  }
}

/**
 * Store a query-response pair in cache
 * @param {string} query - The user query
 * @param {string} response - The model response
 * @param {string} model - Model name used
 */
async function storeCache(query, response, model = 'unknown') {
  try {
    const vector = await getEmbedding(query);
    if (!vector) return;

    const db = await getDb();
    const table = await ensureCacheTable(db);

    await table.add([{
      vector,
      query,
      response: response.substring(0, 5000), // Cap response size
      model,
      timestamp: Date.now(),
      hits: 0,
      active: true
    }]);

    return { stored: true };
  } catch (e) {
    console.warn(`Cache store error: ${e.message}`);
    return { stored: false, error: e.message };
  }
}

/**
 * Get cache stats
 */
async function getCacheStats() {
  try {
    const db = await getDb();
    const table = await ensureCacheTable(db);
    const count = await table.countRows();
    return { entries: count, maxDistance: MAX_DISTANCE, ttlMs: CACHE_TTL_MS };
  } catch (e) {
    return { entries: 0, error: e.message };
  }
}

/**
 * Clear expired cache entries
 */
async function cleanCache() {
  // LanceDB doesn't support DELETE with conditions easily in JS SDK,
  // so for now we just report stats. Full cleanup would need table rebuild.
  const stats = await getCacheStats();
  console.log(`Cache: ${stats.entries} entries`);
  return stats;
}

// ============================================================
// CLI
// ============================================================

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'check': {
      const query = args.join(' ');
      if (!query) { console.log('Usage: semantic-cache.mjs check <query>'); break; }
      console.log(`Checking cache for: "${query}"`);
      const result = await checkCache(query);
      if (result) {
        console.log(`CACHE HIT (distance: ${result.distance.toFixed(1)}, age: ${result.age_seconds}s)`);
        console.log(`   Model: ${result.model}`);
        console.log(`   Response: ${result.response.substring(0, 200)}...`);
      } else {
        console.log('Cache miss');
      }
      break;
    }

    case 'store': {
      const [query, response, model] = args;
      if (!query || !response) { console.log('Usage: semantic-cache.mjs store <query> <response> [model]'); break; }
      const result = await storeCache(query, response, model);
      console.log('Stored:', result);
      break;
    }

    case 'stats': {
      const stats = await getCacheStats();
      console.log('Cache stats:', stats);
      break;
    }

    default:
      console.log(`
submarine Semantic Cache
========================
Usage:
  node semantic-cache.mjs check <query>
  node semantic-cache.mjs store <query> <response> [model]
  node semantic-cache.mjs stats
      `);
  }
}

export { checkCache, storeCache, getCacheStats, cleanCache };

// Only run as CLI, not when imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
