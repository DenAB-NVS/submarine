#!/usr/bin/env node
/**
 * Reindex memories table: 768-dim (nomic) → 1024-dim (BGE-M3)
 * Standalone script. Run from submarine/ dir.
 */

import * as lancedb from '@lancedb/lancedb';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'semantic-memory', 'data', 'lancedb');
const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'bge-m3';
const BATCH_SIZE = 15;

async function getEmbedding(text) {
  const truncated = text.length > 16000 ? text.substring(0, 16000) : text;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt: truncated })
      });
      if (!resp.ok) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 1500)); continue; }
        throw new Error(`Ollama ${resp.status}`);
      }
      const data = await resp.json();
      return Array.from(data.embedding);
    } catch (e) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 1500)); continue; }
      throw e;
    }
  }
}

async function main() {
  console.log(`Connecting to LanceDB at ${DB_PATH}`);
  const db = await lancedb.connect(DB_PATH);

  // 1. Read all records
  console.log('Reading all records from memories table...');
  const table = await db.openTable('memories');
  const allRows = await table.query().limit(5000).toArray();
  console.log(`Read ${allRows.length} records. Old vector dim: ${allRows[0]?.vector?.length}`);

  // 2. Re-embed in batches
  console.log(`Re-embedding with BGE-M3 (batch size ${BATCH_SIZE})...`);
  const newRows = [];
  for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
    const batch = allRows.slice(i, i + BATCH_SIZE);
    const embeddings = [];
    for (const row of batch) {
      const vec = await getEmbedding(row.text || '');
      embeddings.push(vec);
    }
    for (let j = 0; j < batch.length; j++) {
      const { vector, ...rest } = batch[j];
      newRows.push({ ...rest, vector: embeddings[j] });
    }
    const done = Math.min(i + BATCH_SIZE, allRows.length);
    if (done % 100 === 0 || done === allRows.length) {
      console.log(`  ${done}/${allRows.length} embedded`);
    }
  }

  // 3. Drop old table, create new one
  console.log('Dropping old memories table...');
  await db.dropTable('memories');

  console.log('Creating new memories table with 1024-dim vectors...');
  const newTable = await db.createTable('memories', newRows);
  const count = await newTable.countRows();
  const sample = await newTable.query().limit(1).toArray();
  const dim = sample[0]?.vector?.length;

  console.log(`\nDone! Records: ${count}, Vector dim: ${dim}`);
  if (dim !== 1024) console.error('WARNING: vector dim is not 1024!');
  if (count !== allRows.length) console.error(`WARNING: count mismatch (${count} vs ${allRows.length})`);

  // 4. Add Soul records
  console.log('\nAdding 2 Soul identity records...');
  const soulRecords = [
    {
      text: 'Temporal decay: memory relevance decreases exponentially over time. Half-life configurable per layer. Soul layer: long retention (identity facts). Cortex: medium (skills). Core: short (tasks). Temporal decay formula: weight = base * exp(-lambda * delta_t).',
      source: '{"origin":"soul-repair","date":"2026-04-02"}',
      category: 'identity',
      importance: 10,
      timestamp: new Date().toISOString(),
      active: true
    },
    {
      text: 'Hybrid search: combines dense vector similarity (cosine) with sparse lexical overlap (BM25). Final score: alpha * dense + (1-alpha) * sparse. Reranker applies cross-encoder on top-K candidates. Alpha default: 0.7. Reranker improves precision at the cost of latency.',
      source: '{"origin":"soul-repair","date":"2026-04-02"}',
      category: 'identity',
      importance: 10,
      timestamp: new Date().toISOString(),
      active: true
    }
  ];

  for (const rec of soulRecords) {
    rec.vector = await getEmbedding(rec.text);
  }
  await newTable.add(soulRecords);

  const finalCount = await newTable.countRows();
  console.log(`Soul records added. Final count: ${finalCount}`);
  console.log('Reindex complete.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
