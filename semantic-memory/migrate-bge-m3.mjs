#!/usr/bin/env node
/**
 * Migration: nomic-embed-text (768-dim) -> bge-m3 (1024-dim)
 *
 * Reads ALL records from LanceDB backup, re-embeds with bge-m3,
 * recreates tables with 1024-dim vectors.
 */

import * as lancedb from '@lancedb/lancedb';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_PATH = join(__dirname, 'data', 'lancedb-backup-nomic');
const LIVE_PATH = join(__dirname, 'data', 'lancedb');
const OLLAMA_URL = 'http://localhost:11434';
const NEW_MODEL = 'bge-m3';
const NEW_DIM = 1024;

// -- Embedding via Ollama --
async function embed(text, retries = 3) {
  const truncated = text.length > 16000 ? text.substring(0, 16000) : text;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: NEW_MODEL, prompt: truncated })
      });
      if (!resp.ok) {
        if (attempt < retries) { await sleep(1000); continue; }
        throw new Error(`Ollama ${resp.status}: ${await resp.text().catch(() => '')}`);
      }
      const data = await resp.json();
      const vec = Array.from(data.embedding);
      if (vec.length !== NEW_DIM) {
        throw new Error(`Expected ${NEW_DIM}-dim, got ${vec.length}-dim`);
      }
      return vec;
    } catch (e) {
      if (attempt < retries) { await sleep(1000); continue; }
      throw e;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -- Table schemas (what fields besides vector to preserve) --
const TABLE_TEXT_FIELDS = {
  memories: { textField: 'text', extraFields: ['source', 'category', 'timestamp', 'importance', 'active'] },
  knowledge: { textField: 'text', extraFields: ['source_file', 'chunk_index', 'section', 'timestamp', 'active'] },
  decisions: { textField: 'text', extraFields: ['problem', 'chosen', 'alternatives', 'reasoning', 'pipeline_id', 'debate_rounds', 'timestamp', 'active'] },
  threads: { textField: 'text', extraFields: ['thread_id', 'role', 'timestamp', 'active'] },
  cache: { textField: 'text', extraFields: ['key', 'timestamp', 'active'] },
};

async function main() {
  const startTime = Date.now();
  console.log('BGE-M3 Migration (768-dim -> 1024-dim)');
  console.log('='.repeat(43) + '\n');

  // 1. Verify bge-m3 works
  console.log('> Testing bge-m3 embedding...');
  const testVec = await embed('test embedding migration');
  console.log(`  bge-m3 returns ${testVec.length}-dim vectors\n`);

  // 2. Read all records from backup
  console.log('> Reading records from backup...');
  const backupDb = await lancedb.connect(BACKUP_PATH);
  const backupTables = await backupDb.tableNames();
  console.log(`  Tables found: ${backupTables.join(', ')}`);

  const allData = {};
  let totalRecords = 0;

  for (const name of backupTables) {
    const schema = TABLE_TEXT_FIELDS[name];
    if (!schema) {
      console.log(`  Unknown table "${name}", skipping`);
      continue;
    }
    const table = await backupDb.openTable(name);
    const rows = await table.query().limit(100000).toArray();
    const filtered = rows.filter(r => r[schema.textField] !== '__init__' && r.active !== false);
    allData[name] = filtered;
    totalRecords += filtered.length;
    console.log(`  ${name}: ${filtered.length} active records (${rows.length} total incl. inactive)`);
  }
  console.log(`  TOTAL: ${totalRecords} records to re-embed\n`);

  // 3. Drop old tables and recreate with new dim
  console.log('> Recreating live tables with 1024-dim...');
  const liveDb = await lancedb.connect(LIVE_PATH);
  const liveTables = await liveDb.tableNames();
  for (const name of liveTables) {
    await liveDb.dropTable(name);
    console.log(`  Dropped ${name}`);
  }

  // 4. Re-embed and insert
  let processed = 0;
  const errors = [];

  for (const [tableName, records] of Object.entries(allData)) {
    if (records.length === 0) {
      console.log(`\n> ${tableName}: empty, creating with placeholder...`);
      const schema = TABLE_TEXT_FIELDS[tableName];
      const placeholder = { vector: Array(NEW_DIM).fill(0), [schema.textField]: '__init__', active: false };
      for (const f of schema.extraFields) {
        if (f === 'timestamp') placeholder[f] = new Date().toISOString();
        else if (f === 'importance' || f === 'chunk_index' || f === 'debate_rounds') placeholder[f] = 0;
        else if (f === 'active') placeholder[f] = false;
        else placeholder[f] = '';
      }
      await liveDb.createTable(tableName, [placeholder]);
      continue;
    }

    console.log(`\n> Migrating ${tableName}: ${records.length} records...`);
    const schema = TABLE_TEXT_FIELDS[tableName];
    const batchSize = 50;
    let tableCreated = false;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const newRecords = [];

      for (const row of batch) {
        const text = row[schema.textField] || '';
        if (!text || text === '__init__') continue;

        try {
          const vector = await embed(text);
          const newRow = { vector, [schema.textField]: text };
          for (const f of schema.extraFields) {
            newRow[f] = row[f] !== undefined ? row[f] : (f === 'active' ? true : '');
          }
          newRecords.push(newRow);
          processed++;
        } catch (e) {
          errors.push({ table: tableName, text: text.substring(0, 60), error: e.message });
          console.error(`  Error embedding: ${text.substring(0, 50)}... - ${e.message}`);
        }
      }

      if (newRecords.length > 0) {
        if (!tableCreated) {
          await liveDb.createTable(tableName, newRecords);
          tableCreated = true;
        } else {
          const t = await liveDb.openTable(tableName);
          await t.add(newRecords);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (processed / (Date.now() - startTime) * 1000).toFixed(1);
      console.log(`  ${tableName}: ${Math.min(i + batchSize, records.length)}/${records.length} - total ${processed}/${totalRecords} (${rate} rec/s, ${elapsed}s)`);
    }
  }

  // 5. Summary
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\nMigration Complete');
  console.log('='.repeat(43));
  console.log(`  Records migrated: ${processed}/${totalRecords}`);
  console.log(`  Errors: ${errors.length}`);
  console.log(`  Time: ${totalTime}s`);
  console.log(`  Rate: ${(processed / (totalTime)).toFixed(1)} rec/s`);
  if (errors.length > 0) {
    console.log('\n  Failed records:');
    for (const e of errors) {
      console.log(`    ${e.table}: ${e.text}... - ${e.error}`);
    }
  }
  console.log('');

  // 6. Verify
  console.log('> Verifying new tables...');
  const verifyDb = await lancedb.connect(LIVE_PATH);
  const verifyTables = await verifyDb.tableNames();
  for (const name of verifyTables) {
    const t = await verifyDb.openTable(name);
    const count = await t.countRows();
    console.log(`  ${name}: ${count} rows`);
  }
  console.log('\nMigration finished. Run: node semantic-memory/memory-engine.mjs stats');
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
