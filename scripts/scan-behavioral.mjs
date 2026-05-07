#!/usr/bin/env node
/**
 * One-time scan of all records in LanceDB
 * to extract behavioral edges.
 *
 * Run: node scripts/scan-behavioral.mjs
 */

import lancedb from '@lancedb/lancedb';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __script_dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = resolve(__script_dirname, '..');
const DB_PATH = resolve(BASE_DIR, 'data/lancedb');

async function getAllRecords() {
  console.log('Opening LanceDB at:', DB_PATH);
  const db = await lancedb.connect(DB_PATH);
  const tbl = await db.openTable('memories');
  const count = await tbl.countRows();
  console.log(`Table has ${count} rows, reading all...`);

  const rows = await tbl.query().select(['text', 'source', 'timestamp']).limit(count).toArray();
  const records = rows.map(r => {
    let id = '';
    try {
      const meta = typeof r.source === 'string' ? JSON.parse(r.source) : (r.source || {});
      id = meta.id || meta.recordId || r.timestamp || '';
    } catch { id = r.timestamp || ''; }
    return { id, text: r.text || '' };
  });

  return records;
}

async function main() {
  console.log('=== Behavioral Edges Scanner ===\n');

  const records = await getAllRecords();
  console.log(`Loaded ${records.length} records\n`);

  const { scanForBehavioralEdges, mergeBehavioralEdges } = await import('../src/causal.mjs');
  const edges = scanForBehavioralEdges(records);

  console.log(`\nFound ${edges.length} behavioral edges`);

  edges.slice(0, 10).forEach((e, i) => {
    console.log(`\n--- Edge ${i + 1} ---`);
    console.log(`  Cause:    ${e.sourceText}`);
    console.log(`  Effect:   ${e.targetText}`);
    console.log(`  Evidence: ${e.evidence}`);
  });

  if (edges.length > 0) {
    const added = await mergeBehavioralEdges(edges);
    console.log(`\nMerged into graph: ${added} new behavioral edges`);

    const raw = JSON.parse(readFileSync(resolve(BASE_DIR, 'data/causal-graph.json'), 'utf-8'));
    const allEdges = Array.isArray(raw) ? raw : (raw.edges || []);
    const behavioral = allEdges.filter(e => e.type === 'behavioral').length;
    const semantic = allEdges.length - behavioral;
    console.log(`\nGraph totals: ${allEdges.length} edges`);
    console.log(`  Semantic:   ${semantic}`);
    console.log(`  Behavioral: ${behavioral}`);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
