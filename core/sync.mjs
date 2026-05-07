/**
 * submarine Sync module — automatic fact extraction from daily files
 * and routing across three memory layers (Cortex, Core, Soul).
 * Handles heartbeat sync and automatic fact extraction.
 *
 * @module submarine/sync
 * @author D. Ashford
 */

import { Cortex, Core, Soul, getLayerStats } from '../src/layers.mjs';
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getServerPort, getApiKey } from '../src/config.mjs';

// Immune system (optional — does not break sync if it fails to load)
let immuneCheck = null;
try {
  const { immune } = await import('../src/immune.mjs');
  immuneCheck = immune;
  console.log('[sync] immune.mjs loaded');
} catch (e) { console.log('[sync] immune.mjs not available, skipping'); }

// Contradiction detection (optional — does not break sync if it fails to load)
let contradictionCheck = null;
try {
  const { detectContradictions } = await import('./contradiction.mjs');
  contradictionCheck = detectContradictions;
  console.log('[sync] contradiction.mjs loaded');
} catch (e) { console.log('[sync] contradiction.mjs not available, skipping'); }

// Causal graph (optional — does not break sync if it fails to load)
let causalModule = null;
try {
  causalModule = await import('../src/causal.mjs');
  await causalModule.initGraph();
} catch (e) { /* causal module not available */ }

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = join(__dirname, '../..');
const MEMORY_DIR = join(WORKSPACE_ROOT, 'memory');
const MEMORY_MD = join(WORKSPACE_ROOT, 'MEMORY.md');
const STATE_FILE = join(WORKSPACE_ROOT, 'submarine/data/sync-state.json');

// ============================================================
// Fact extraction functions
// ============================================================

/**
 * Extracts facts from markdown text using patterns.
 * @param {string} text - Source text
 * @param {string} source - Source (e.g. 'daily/2025-03-22.md')
 * @returns {Array<{text: string, category: string, importance: number}>}
 */
function extractFacts(text, source) {
  const facts = [];
  const lines = text.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines and separator headings
    if (!line || line === '#' || line.startsWith('```')) continue;
    
    // Pattern 1: Bullet points with substantive text (- fact...)
    if (line.startsWith('- ') && line.length > 20) {
      const content = line.substring(2).trim();
      // Skip meta/structural items
      if (content.startsWith('Saturday') || content.startsWith('Heartbeat running')) continue;
      
      const category = categorize(content);
      if (category) {
        facts.push({ text: content, category, importance: estimateImportance(content) });
      }
    }
    
    // Pattern 2: Key-value pairs (Key: Value)
    if (line.includes(':**') || (line.includes(': ') && line.startsWith('**'))) {
      const cleaned = line.replace(/\*\*/g, '').trim();
      if (cleaned.length > 15 && cleaned.length < 300) {
        facts.push({ text: cleaned, category: 'fact', importance: 5 });
      }
    }
    
    // Pattern 3: Attributed quotes (> author:, "Name said")
    if (/^>\s|\bsaid:\s/.test(line) || /\b[A-Z][a-z]+\s+said\b/.test(line)) {
      const cleaned = line.replace(/^[-•*>]\s*/, '').trim();
      if (cleaned.length > 10) {
        facts.push({ text: cleaned, category: 'quote', importance: 8 });
      }
    }
    
    // Pattern 4: Lessons (lesson, important, remember, never)
    const lessonWords = ['lesson', 'important', 'remember', 'never', 'always', 'error', 'mistake'];
    if (lessonWords.some(w => line.toLowerCase().includes(w))) {
      const cleaned = line.replace(/^[-•*#]\s*/, '').trim();
      if (cleaned.length > 15) {
        facts.push({ text: cleaned, category: 'lesson', importance: 7 });
      }
    }
    
    // Pattern 5: Dates and milestones (Day, March, date)
    if (/\d{1,2}\s*(March|February|January|April|May)/i.test(line) ||
        line.includes('Day ') || line.includes('milestone')) {
      const cleaned = line.replace(/^[-•*#]\s*/, '').trim();
      if (cleaned.length > 15) {
        facts.push({ text: cleaned, category: 'milestone', importance: 8 });
      }
    }
    
    // Pattern 6: Technical decisions (decision, chose, using)
    const decisionWords = ['decision', 'decided', 'chose', 'using', 'switched to', 'installed'];
    if (decisionWords.some(w => line.toLowerCase().includes(w))) {
      const cleaned = line.replace(/^[-•*#]\s*/, '').trim();
      if (cleaned.length > 15) {
        facts.push({ text: cleaned, category: 'decision', importance: 7 });
      }
    }
  }
  
  // Deduplication by similar text
  const unique = [];
  const seen = new Set();
  for (const fact of facts) {
    const key = fact.text.substring(0, 50).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(fact);
    }
  }
  
  return unique;
}

/**
 * Determines fact category by keywords.
 * @param {string} text - Fact text
 * @returns {string|null} Category or null
 */
function categorize(text) {
  const lower = text.toLowerCase();
  
  // === DECISION: decisions, choices, switches ===
  if (lower.includes('decided') || lower.includes('resolved') || lower.includes('decision:') ||
      lower.includes('chose') || lower.includes('choice:') || lower.includes('switched') ||
      lower.includes('abandoned') || lower.includes('moved to') || lower.includes('accepted') ||
      lower.includes('using') || lower.includes('installed') || lower.includes('replaced') ||
      lower.includes('pivot') || lower.includes('vector:') || lower.includes('strateg')) {
    return 'decision';
  }
  
  // === LESSON: lessons, conclusions, errors, rules ===
  if (lower.includes('lesson') || lower.includes('conclusion') || lower.includes('remember') ||
      lower.includes('never') || lower.includes('always need') || lower.includes('no longer') ||
      lower.includes('error') || lower.includes('problem:') || lower.includes('cause:') ||
      lower.includes('do not repeat') || lower.includes('important:') ||
      lower.includes('rule:') || lower.includes('fix:') || lower.includes('bug') ||
      lower.includes('broke') || lower.includes('lost') || lower.includes('not work')) {
    return 'lesson';
  }
  
  // === TECHNICAL: infrastructure and technologies ===
  if (lower.includes('vpn') || lower.includes('proxy') || lower.includes('dns') || 
      lower.includes('ollama') || lower.includes('gateway') || lower.includes('wsl') ||
      lower.includes('systemd') || lower.includes('npm') || lower.includes('node') ||
      lower.includes('chromium') || lower.includes('playwright') || lower.includes('api')) {
    return 'technical';
  }
  
  if (lower.includes('skill') || lower.includes('cron')) {
    return 'infrastructure';
  }
  if (lower.includes('$') || lower.includes('expense') || lower.includes('budget') || lower.includes('cost') ||
      lower.includes('balance') || lower.includes('credit') || lower.includes('payment')) {
    return 'finance';
  }
  if (lower.includes('architecture') || lower.includes('principle') || lower.includes('invariant') ||
      lower.includes('contract') || lower.includes('manifest')) {
    return 'philosophy';
  }
  // Episodes: specific events with date/time, heartbeat logs, actions
  if (lower.includes('heartbeat') || lower.includes('launched') || lower.includes('restarted') ||
      lower.includes('created') || lower.includes('built') || lower.includes('fixed') ||
      lower.includes('pipeline') || lower.includes('commit') || lower.includes('deploy')) {
    return 'episode';
  }
  
  // Default: if text is substantive enough, it's a fact
  if (text.length > 30) return 'fact';
  return null;
}

/**
 * Estimates fact importance (1-10).
 * @param {string} text - Fact text
 * @returns {number} Importance from 1 to 10
 */
function estimateImportance(text) {
  let score = 5;
  const lower = text.toLowerCase();
  
  // Boost for structural/architectural content
  if (lower.includes('architecture') || lower.includes('invariant') || lower.includes('contract')) score += 2;
  if (lower.includes('decision') || lower.includes('law')) score += 2;
  if (lower.includes('error') || lower.includes('lesson')) score += 1;
  if (lower.includes('$') || lower.includes('invest')) score += 1;
  
  // Reduction for generic content
  if (lower.includes('heartbeat') || lower.includes('nominal')) score -= 2;
  
  return Math.max(1, Math.min(10, score));
}

// ============================================================
// Fact routing across submarine memory layers
// ============================================================

/**
 * Routes a fact to the appropriate memory layer.
 * Before writing to Soul — passes through the immune check.
 * @param {Object} fact - Fact {text, category, importance}
 * @param {string} source - Fact source
 * @returns {Promise<Object>} Addition result
 */
async function routeToLayer(fact, source) {
  let targetLayer;
  
  if (fact.category === 'philosophy') {
    targetLayer = 'soul';
  } else if (fact.category === 'milestone' || fact.category === 'quote' || fact.category === 'episode') {
    targetLayer = 'cortex';
  } else {
    targetLayer = 'core';
  }

  // Immune system: check record before adding to Soul/Core
  if (immuneCheck && (targetLayer === 'soul' || targetLayer === 'core')) {
    try {
      const check = await immuneCheck(fact.text, targetLayer);
      if (!check.allowed) {
        console.log('  \u{1f6e1} immune: ' + targetLayer + ' -> ' + check.layer + ' (' + check.reason + ')');
        targetLayer = check.layer;
      }
    } catch (e) {
      console.warn('  immune error: ' + (e.message || '').substring(0, 60) + ', keeping ' + targetLayer);
    }
  }

  // Contradiction detection before writing to Soul/Core
  // Edges are created AFTER writing — when the real ID of the new record exists
  let contradictionInfo = null;
  if (contradictionCheck && (targetLayer === 'soul' || targetLayer === 'core')) {
    try {
      const { searchMemories } = await import('../semantic-memory/memory-engine.mjs');
      const supersedeFn = async (id) => {
        const res = await fetch(`http://127.0.0.1:${getServerPort()}/api/v1/memory/supersede`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': getApiKey() },
          body: JSON.stringify({ ids: [id] }),
          signal: AbortSignal.timeout(10000)
        });
        return res.ok;
      };
      // addCausalFn NOT passed — edges will be created after writing with real IDs
      const check = await contradictionCheck(fact.text, targetLayer, { searchFn: searchMemories, supersedeFn });
      if (check.superseded > 0) {
        contradictionInfo = check;
        console.log('  ⚠️ Contradiction: ' + check.superseded + ' old record(s) superseded');
        for (const c of check.contradictions) { console.log('    "' + c.existingText.substring(0, 60) + '..." (' + c.reason + ')'); }
      }
    } catch (e) { /* detection is non-critical */ }
  }

  // Write to target layer
  let result;
  switch (targetLayer) {
    case 'soul':
      result = await Soul.add(fact.text);
      break;
    case 'cortex':
      result = await Cortex.add(fact.text, { source, category: fact.category });
      break;
    default:
      result = await Core.add(fact.text, fact.category, fact.importance);
      break;
  }

  // Causal edges for contradictions — with real record IDs
  // sourceId = new record ID (winner), targetId = superseded record ID
  if (contradictionInfo && causalModule && result?.id) {
    for (const c of contradictionInfo.contradictions) {
      if (c.confidence === 'high' && c.existingId) {
        try {
          await causalModule.addRelation(
            result.id, fact.text.substring(0, 200),
            c.existingId, c.existingText,
            'supersedes', targetLayer, 1
          );
        } catch (e) { /* causal edges are non-critical */ }
      }
    }
  }

  return result;
}

/**
 * Generates causal links between recently added facts.
 * Takes the last N facts from the current sync pass and looks for links.
 * Uses real record IDs (recordId) instead of phantom sync_Date.now()
 *
 * @param {Array<{text: string, category: string, recordId: string|null}>} recentFacts facts with IDs
 * @param {string} source fact source
 * @returns {Promise<number>} number of links created
 */
async function generateCausalLinks(recentFacts, source) {
  if (!causalModule || recentFacts.length < 2) return 0;

  let linksCreated = 0;
  const maxLinks = 10; // up to 10 links per sync
  const MIN_SIMILARITY = 0.25; // minimum semantic similarity to create a link

  // Strategy: look for fact pairs from the same file where one may cause the other
  // Double filter: 1) categories match a pattern 2) embedding similarity > threshold
  const causalPatterns = [
    // Decisions produce facts and lessons
    { sourceCategory: 'decision', targetCategory: 'fact', relation: 'causes' },
    { sourceCategory: 'decision', targetCategory: 'lesson', relation: 'causes' },
    { sourceCategory: 'decision', targetCategory: 'episode', relation: 'causes' },
    // Lessons and facts help make decisions
    { sourceCategory: 'lesson', targetCategory: 'decision', relation: 'enables' },
    { sourceCategory: 'fact', targetCategory: 'decision', relation: 'enables' },
    // Technical facts produce lessons
    { sourceCategory: 'technical', targetCategory: 'lesson', relation: 'causes' },
    { sourceCategory: 'technical', targetCategory: 'decision', relation: 'enables' },
    // Finances enable decisions
    { sourceCategory: 'finance', targetCategory: 'decision', relation: 'enables' },
    // Infrastructure enables facts and technical knowledge
    { sourceCategory: 'infrastructure', targetCategory: 'technical', relation: 'enables' },
    { sourceCategory: 'infrastructure', targetCategory: 'fact', relation: 'enables' },
    // Episodes produce lessons
    { sourceCategory: 'episode', targetCategory: 'lesson', relation: 'causes' },
    // Facts between each other (if from same file — likely related)
    { sourceCategory: 'fact', targetCategory: 'lesson', relation: 'causes' },
    { sourceCategory: 'lesson', targetCategory: 'fact', relation: 'enables' },
  ];

  for (let i = 0; i < recentFacts.length && linksCreated < maxLinks; i++) {
    for (let j = i + 1; j < recentFacts.length && linksCreated < maxLinks; j++) {
      const a = recentFacts[i];
      const b = recentFacts[j];

      // Look for matching pattern
      const pattern = causalPatterns.find(p =>
        (p.sourceCategory === a.category && p.targetCategory === b.category) ||
        (p.sourceCategory === b.category && p.targetCategory === a.category)
      );

      if (pattern) {
        const isForward = pattern.sourceCategory === a.category;
        const sourceFact = isForward ? a : b;
        const targetFact = isForward ? b : a;
        const sourceText = sourceFact.text;
        const targetText = targetFact.text;

        // Skip if records have no real IDs
        if (!sourceFact.recordId || !targetFact.recordId) continue;

        // Semantic filter: verify that facts are actually about the same thing
        try {
          const { searchMemories } = await import('../semantic-memory/memory-engine.mjs');
          const results = await searchMemories(sourceText.substring(0, 150), 10, 0.1);
          const match = results.find(r => {
            // Look for targetText among results (by partial text match)
            const targetShort = targetText.substring(0, 60).toLowerCase();
            return r.text?.toLowerCase().includes(targetShort) ||
                   targetShort.includes(r.text?.substring(0, 60).toLowerCase());
          });

          // If no exact match found — check the best score among similar results
          const topScore = results.length > 0 ? results[0].score : 0;
          const similarity = match ? match.score : topScore * 0.5; // penalty if no direct match

          if (similarity < MIN_SIMILARITY) {
            // Facts are not semantically related — skip
            continue;
          }

          // Real record IDs instead of phantom sync_Date.now()
          await causalModule.addRelation(
            sourceFact.recordId,
            sourceText.substring(0, 200),
            targetFact.recordId,
            targetText.substring(0, 200),
            pattern.relation,
            'core',
            1
          );
          linksCreated++;
          console.log(`  🔗 Causal (sim=${similarity.toFixed(3)}): "${sourceText.substring(0, 40)}" ${pattern.relation} "${targetText.substring(0, 40)}"`);
        } catch (e) {
          // Non-critical
        }
      }
    }
  }

  return linksCreated;
}

// ============================================================
// State management (state tracking)
// ============================================================

/**
 * Loads processing state from JSON file.
 * @returns {Object} State {processedFiles: {filename: mtimeMs}, lastRun: isoString}
 */
function loadState() {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  }
  return { processedFiles: {}, lastRun: null };
}

/**
 * Saves processing state.
 * @param {Object} state - State
 */
function saveState(state) {
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// Processing new/modified files
// ============================================================

/**
 * Processes all daily files and MEMORY.md that changed since last run.
 * @returns {Promise<{filesProcessed: number, factsAdded: number}>}
 */
async function processNewFiles() {
  const state = loadState();
  let filesProcessed = 0;
  let factsAdded = 0;

  // 1. Daily memory files
  if (existsSync(MEMORY_DIR)) {
    const files = readdirSync(MEMORY_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort();
    
    for (const file of files) {
      const filePath = join(MEMORY_DIR, file);
      const mtime = statSync(filePath).mtimeMs;
      
      // Skip if already processed and unchanged
      if (state.processedFiles[file] && state.processedFiles[file] >= mtime) {
        continue;
      }
      
      console.log(`📝 Processing ${file}...`);
      const text = readFileSync(filePath, 'utf-8');
      const facts = extractFacts(text, `daily/${file}`);
      
      let added = 0;
      const addedFacts = []; // for causal links (with real IDs)
      for (const fact of facts) {
        try {
          const result = await routeToLayer(fact, `daily/${file}`);
          added++;
          addedFacts.push({ ...fact, recordId: result?.id || null });
        } catch (err) {
          console.warn(`  ⚠ Failed to add fact: ${err.message}`);
        }
      }
      
      // Auto-generate causal links between facts of this file
      if (addedFacts.length >= 2) {
        const links = await generateCausalLinks(addedFacts, `daily/${file}`);
        if (links > 0) console.log(`   🔗 Causal links generated: ${links}`);
      }

      // Behavioral edges: extracting real causal links from text
      if (addedFacts.length > 0 && causalModule) {
        try {
          const { scanForBehavioralEdges, mergeBehavioralEdges } = await import('../src/causal.mjs');
          const records = addedFacts.map(f => ({ id: f.recordId || '', text: f.text }));
          const behavioralEdges = scanForBehavioralEdges(records);
          if (behavioralEdges.length > 0) {
            const added = await mergeBehavioralEdges(behavioralEdges);
            if (added > 0) console.log(`   🧬 Behavioral edges: +${added}`);
          }
        } catch(e) { /* behavioral extraction non-critical */ }
      }
      
      state.processedFiles[file] = mtime;
      filesProcessed++;
      factsAdded += added;
      console.log(`   Extracted: ${facts.length} facts, Added: ${added}`);
    }
  }

  // 2. MEMORY.md — SKIPPED during normal sync
  // MEMORY.md is a curated digest; its content duplicates daily files.
  // Processing a 40KB file = 336 facts x HTTP request to Ollama = timeout on ARM64.
  // All facts are already extracted from daily/YYYY-MM-DD.md.
  // For full rebuild use: node sync.mjs rebuild
  if (existsSync(MEMORY_MD)) {
    console.log(`⏭️  Skipping MEMORY.md (curated digest — facts already in daily files)`);
  }

  saveState(state);
  return { filesProcessed, factsAdded };
}

// ============================================================
// CLI
// ============================================================

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  
  switch (cmd) {
    case 'run': {
      console.log('🔄 submarine sync: extracting new facts from memory files...');
      const result = await processNewFiles();
      console.log(`✅ Done: ${result.filesProcessed} files processed, ${result.factsAdded} new facts added.`);
      break;
    }
    
    case 'preview': {
      // Preview extraction from specified file
      const filePath = args[0];
      if (!filePath) {
        console.log('Usage: node submarine/core/sync.mjs preview <file>');
        break;
      }
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        break;
      }
      const text = readFileSync(filePath, 'utf-8');
      const facts = extractFacts(text, filePath);
      console.log(`\n📋 Would extract ${facts.length} facts from ${filePath}:\n`);
      for (const f of facts) {
        console.log(`  [${f.importance}] ${f.category}: ${f.text.substring(0, 100)}`);
      }
      break;
    }
    
    case 'reset': {
      if (existsSync(STATE_FILE)) {
        writeFileSync(STATE_FILE, JSON.stringify({ processedFiles: {}, lastRun: null }, null, 2));
        console.log('✅ Sync state reset.');
      } else {
        console.log('ℹ️ State file does not exist.');
      }
      break;
    }
    
    case 'rebuild': {
      console.log('🔄 REBUILD: recreating index from ALL text sources...');
      console.log('⚠ Resetting state, restoring from JOURNALs + markdown files.\n');
      // Reset state
      writeFileSync(STATE_FILE, JSON.stringify({ processedFiles: {}, lastRun: null }, null, 2));

      // Restore from JOURNALs
      const journals = [
        { path: join(WORKSPACE_ROOT, 'submarine', 'SOUL-JOURNAL.md'), name: 'Soul', fn: (t) => Soul.add(t) },
        { path: join(WORKSPACE_ROOT, 'submarine', 'CORE-JOURNAL.md'), name: 'Core', fn: (t, cat) => Core.add(t, cat || 'fact', 5) },
        { path: join(WORKSPACE_ROOT, 'submarine', 'CORTEX-JOURNAL.md'), name: 'Cortex', fn: (t) => Cortex.add(t, { source: 'rebuild' }) },
      ];

      for (const journal of journals) {
        if (!existsSync(journal.path)) { console.log(`   ${journal.name}: JOURNAL not found, skipping`); continue; }
        console.log(`📜 Restoring ${journal.name} from JOURNAL...`);
        const content = readFileSync(journal.path, 'utf-8');
        const entries = content.split('\n')
          .filter(l => l.match(/^\[20/) && !l.startsWith('[DELETED]'))  // [20xx but not [DELETED]
          .map(l => {
            // Parse: [timestamp] [category] text  OR  [timestamp] text
            const match = l.match(/^\[[^\]]+\]\s*(?:\[([^\]]*)\]\s*)?(.+)$/);
            return match ? { text: match[2].trim(), category: match[1] || null } : null;
          })
          .filter(e => e && e.text.length > 5);
        let added = 0;
        for (const entry of entries) {
          try {
            await journal.fn(entry.text, entry.category);
            added++;
          } catch (e) { /* dedup or error — skip */ }
        }
        console.log(`   ${journal.name}: ${added} records restored`);
      }

      // Full processing of all markdown files
      const result = await processNewFiles();
      console.log(`\n✅ Rebuild complete: ${result.filesProcessed} files, ${result.factsAdded} facts from markdown`);
      const stats = await getLayerStats();
      console.log(`   Soul: ${stats.soul?.count}, Core: ${stats.core?.count}, Cortex: ${stats.cortex?.count}, Total: ${stats.total?.count}`);
      break;
    }
    
    case 'stats': {
      const state = loadState();
      const stats = await getLayerStats();
      console.log('📊 submarine sync stats:');
      console.log(`  Last run: ${state.lastRun || 'never'}`);
      console.log(`  Files tracked: ${Object.keys(state.processedFiles).length}`);
      console.log(`  Memory layers: Cortex ${stats.cortex?.count}, Core ${stats.core?.count}, Soul ${stats.soul?.count}`);
      break;
    }
    
    default:
      console.log(`
submarine Sync — three-layer fact extraction
=============================================
Usage:
  node submarine/core/sync.mjs run          — Process new/modified files
  node submarine/core/sync.mjs preview <f>  — Show what will be extracted from file
  node submarine/core/sync.mjs reset        — Reset processing state
  node submarine/core/sync.mjs rebuild      — Recreate EVERYTHING from files (Soul from JOURNAL)
  node submarine/core/sync.mjs stats        — Show statistics
      `);
  }
}

export { extractFacts, processNewFiles };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}