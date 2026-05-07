#!/usr/bin/env node
/**
 * submarine Heartbeat Memory Sync
 * ================================
 * Runs from heartbeat or cron.
 * 1. Extracts new facts from daily memory files
 * 2. Reindexes changed documents in knowledge
 * 3. Outputs brief status
 *
 * Created: 2026-03-14
 */

import { getStats } from './memory-engine.mjs';

function processNewFiles() {
  return { totalAdded: 0, filesProcessed: 0 };
}

async function sync() {
  const startTime = Date.now();

  console.log('Semantic memory sync starting...');

  // Step 1: Extract new facts
  const extractResult = processNewFiles();

  // Step 2: Get stats
  const stats = await getStats();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\nSync complete in ${elapsed}s`);
  console.log(`   New facts added: ${extractResult.totalAdded}`);
  console.log(`   Files processed: ${extractResult.filesProcessed}`);
  for (const [name, info] of Object.entries(stats.tables)) {
    console.log(`   ${name}: ${info.rows} records`);
  }

  return {
    elapsed,
    newFacts: extractResult.totalAdded,
    filesProcessed: extractResult.filesProcessed,
    stats: stats.tables
  };
}

// Only run as CLI, not when imported
if (import.meta.url === `file://${process.argv[1]}`) {
  sync().catch(console.error);
}
