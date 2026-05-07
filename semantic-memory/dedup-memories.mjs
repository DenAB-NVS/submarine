/**
 * @author D. Ashford
 * Memory deduplication utility for submarine semantic memory.
 * Removes duplicate records from the memories table by text content.
 */

import * as lancedb from '@lancedb/lancedb';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as arrow from 'apache-arrow';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SUBMARINE_DATA_DIR || join(__dirname, 'data', 'lancedb');

async function dedup() {
  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable('memories');

  // Get all records as arrow table to preserve schema
  const arrowTable = await table.query().limit(10000).toArrow();
  const schema = arrowTable.schema;
  console.log('Total records:', arrowTable.numRows);

  // Convert to rows for dedup
  const all = await table.query().limit(10000).toArray();

  // Find unique by text, keep track of indices
  const seen = new Map();
  const keepIndices = [];

  for (let i = 0; i < all.length; i++) {
    const key = (all[i].text || '').trim();
    if (!seen.has(key) && key.length > 0) {
      seen.set(key, true);
      keepIndices.push(i);
    }
  }

  const dupes = all.length - keepIndices.length;
  console.log('Unique:', keepIndices.length);
  console.log('Duplicates to remove:', dupes);

  if (dupes > 0) {
    // Build new arrow table from unique rows using original schema
    const uniqueRows = keepIndices.map(i => {
      const row = all[i];
      // Convert vector to plain array
      const vec = row.vector;
      const plainVec = vec instanceof Float32Array ? Array.from(vec) :
                       Array.isArray(vec) ? vec.map(Number) :
                       vec?.toArray ? Array.from(vec.toArray()) : Array.from(vec);
      return {
        text: row.text,
        category: row.category || 'fact',
        source: row.source || 'unknown',
        importance: Number(row.importance) || 5,
        vector: plainVec,
        timestamp: Number(row.timestamp) || Date.now()
      };
    });

    await db.dropTable('memories');
    await db.createTable('memories', uniqueRows, { schema });
    console.log('Deduplication complete.');

    // Verify
    const newTable = await db.openTable('memories');
    const count = await newTable.query().limit(10000).toArray();
    console.log('Verified:', count.length, 'records');
  }
}

// Only run as CLI, not when imported
if (import.meta.url === `file://${process.argv[1]}`) {
  dedup().catch(e => console.error('Error:', e.message));
}
