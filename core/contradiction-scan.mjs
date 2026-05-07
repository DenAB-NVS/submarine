/**
 * Contradiction Scan — scanning Core for contradictions
 * Cleans Core without touching Soul. Runs via cron every 3 hours.
 *
 * Logic:
 *   1. Determines cutoff from contradiction-stats.json (or 24h ago)
 *   2. Retrieves Core records from LanceDB newer than cutoff
 *   3. For each record, calls detectContradictions
 *   4. On high-confidence — supersede with REAL IDs (not contra_Date.now)
 *   5. Writes statistics to contradiction-stats.json
 *
 * @module contradiction-scan
 * @author D. Ashford
 */

import { detectContradictions } from './contradiction.mjs';
import { searchMemories, getDb } from '../semantic-memory/memory-engine.mjs';
import forgetting from '../src/forgetting.mjs';
import { addRelation, initGraph } from '../src/causal.mjs';
import { parseSource } from '../src/utils.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STATS_FILE = join(DATA_DIR, 'contradiction-stats.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// --- Cutoff: when was the last scan ---
let cutoff;
if (existsSync(STATS_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    cutoff = prev.nextScanFrom || prev.lastRun;
  } catch { cutoff = null; }
}
if (!cutoff) {
  cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}
const cutoffMs = new Date(cutoff).getTime();

// --- Initialize causal graph (optional) ---
try { await initGraph(); } catch { /* non-critical */ }

// --- Retrieve Core records newer than cutoff ---
const db = await getDb();
const table = await db.openTable('memories');
const allRows = await table.query().limit(50000).toArray();

const coreRecords = allRows.filter(r => {
  if (r.active === false || r.active === 'false') return false;
  if (r.text === '__init__') return false;
  const meta = parseSource(r.source);
  if (meta.supersededBy) return false;
  const layer = forgetting.getLayerByCategory(r.category);
  if (layer !== 'core') return false;
  const ts = new Date(r.timestamp).getTime();
  return !isNaN(ts) && ts >= cutoffMs;
});

// Newest first — they supersede older ones, not the other way around
coreRecords.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

let checked = 0;
let contradictionsFound = 0;
let supersededCount = 0;
const supersededIds = new Set();

for (const record of coreRecords) {
  const meta = parseSource(record.source);
  const recordId = meta.id;
  if (!recordId || supersededIds.has(recordId)) continue;

  // Tracker for the last superseded ID for the causal edge
  let lastSupersededId = null;

  const supersedeFn = async (existingId) => {
    if (!existingId || supersededIds.has(existingId) || existingId === recordId) return false;
    lastSupersededId = existingId;
    try {
      const result = await forgetting.supersede(existingId, recordId, 'contradiction-scan');
      if (result.success) {
        supersededIds.add(existingId);
        return true;
      }
    } catch { /* non-critical */ }
    return false;
  };

  const addCausalFn = async (srcText, tgtText, relation) => {
    if (!lastSupersededId) return;
    try {
      // REAL IDs: recordId supersedes lastSupersededId
      await addRelation(recordId, srcText, lastSupersededId, tgtText, relation, 'core', 1);
    } catch { /* non-critical */ }
  };

  const searchFn = async (text, limit) => {
    return await searchMemories(text, limit, 0.2);
  };

  try {
    const result = await detectContradictions(record.text, 'core', {
      searchFn, supersedeFn, addCausalFn
    });
    checked++;
    if (result.contradictions.length > 0) {
      contradictionsFound += result.contradictions.length;
      supersededCount += result.superseded;
    }
  } catch (e) {
    console.warn(`[contradiction-scan] error on ${recordId}: ${(e.message || '').substring(0, 80)}`);
  }
}

// --- Statistics ---
const now = new Date().toISOString();
const stats = {
  lastRun: now,
  checked,
  contradictions: contradictionsFound,
  superseded: supersededCount,
  nextScanFrom: now
};
writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

// --- Report for cron ---
console.log(`[contradiction-scan] Checked: ${checked}, Contradictions: ${contradictionsFound}, Superseded: ${supersededCount}. Core clean.`);
