/**
 * promote.mjs — submarine Experience Lift
 *
 * Cortex -> Core: extracts patterns from episodes, deduplication, promotion
 * Core -> Soul: resonance weight — if truth found by >=3 sources, promote to Soul
 *
 * Run: node submarine/core/promote.mjs [--dry-run]
 * Cron: once a day (recommended)
 *
 * @author D. Ashford
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getServerPort, getApiKey, getSubmarinePath } from '../src/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBMARINE_DIR = getSubmarinePath();
const PROMOTE_STATE_PATH = join(SUBMARINE_DIR, 'data', 'promote-state.json');

// Load .env
const envPath = join(SUBMARINE_DIR, '.env');
if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
    }
}

const API_KEY = getApiKey();
const PORT = getServerPort();
const BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Helpers ───

// Immune system (optional)
let immuneCheck = null;
try {
  const { immune } = await import('../src/immune.mjs');
  immuneCheck = immune;
} catch (e) { /* immune not available */ }

async function apiGet(path) {
    const resp = await fetch(`${BASE_URL}${path}`, {
        headers: { 'X-API-Key': API_KEY }
    });
    return resp.json();
}

async function apiPost(path, body) {
    const resp = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return resp.json();
}

function loadState() {
    if (existsSync(PROMOTE_STATE_PATH)) {
        return JSON.parse(readFileSync(PROMOTE_STATE_PATH, 'utf8'));
    }
    return { lastRun: null, promoted: { toCore: 0, toSoul: 0 }, history: [] };
}

function saveState(state) {
    writeFileSync(PROMOTE_STATE_PATH, JSON.stringify(state, null, 2));
}

function log(msg) {
    const ts = new Date().toISOString().slice(0, 19);
    console.log(`[${ts}] ${msg}`);
}

// --- Cortex -> Core: Pattern extraction ---

async function promoteCortexToCore() {
    log('🔍 Analyzing Cortex (episodes)...');
    
    // Read CORTEX-JOURNAL for full set
    const journalPath = join(SUBMARINE_DIR, 'CORTEX-JOURNAL.md');
    if (!existsSync(journalPath)) {
        log('⚠️  CORTEX-JOURNAL.md not found');
        return [];
    }
    
    const journal = readFileSync(journalPath, 'utf8');
    const entries = journal.split('\n').filter(l => l.startsWith('['));
    
    if (entries.length < 3) {
        log(`📭 Too few episodes (${entries.length}), skipping promotion`);
        return [];
    }
    
    // Extract sources ([source] tag at the start of record text)
    const sourceMap = new Map(); // source → [entries]
    const patternCandidates = [];
    
    for (const entry of entries) {
        // Format: [2026-03-24T01:00:00Z] [opus] text...
        const sourceMatch = entry.match(/\]\s*\[(\w+)\]\s*(.*)/);
        const plainMatch = entry.match(/\]\s*(.*)/);
        
        const source = sourceMatch ? sourceMatch[1] : 'unknown';
        const text = sourceMatch ? sourceMatch[2] : (plainMatch ? plainMatch[1] : entry);
        
        if (!sourceMap.has(source)) sourceMap.set(source, []);
        sourceMap.get(source).push(text);
    }
    
    log(`📊 Sources: ${[...sourceMap.keys()].join(', ')} (${entries.length} episodes)`);
    
    // Look for patterns: semantically similar records from DIFFERENT sources
    const promoted = [];
    const checked = new Set();
    
    // Take last 50 episodes for analysis (economy)
    const recentEntries = entries.slice(-50);
    
    for (const entry of recentEntries) {
        const plainMatch = entry.match(/\]\s*(.*)/);
        if (!plainMatch) continue;
        const text = plainMatch[1].substring(0, 200); // truncate for query
        
        if (checked.has(text.substring(0, 50))) continue;
        checked.add(text.substring(0, 50));
        
        // Search similar in Core — if already exists, skip (dedup)
        const coreResults = await apiGet(`/memory/search?q=${encodeURIComponent(text)}&limit=1&layer=core`);
        
        if (coreResults.results && coreResults.results.length > 0 && coreResults.results[0].score > 0.85) {
            continue; // already exists in Core
        }
        
        // Search similar in Cortex — if >=2 similar episodes, it's a pattern
        const cortexResults = await apiGet(`/memory/search?q=${encodeURIComponent(text)}&limit=5&layer=cortex`);
        
        if (cortexResults.results && cortexResults.results.length >= 2) {
            const highSimilarity = cortexResults.results.filter(r => r.score > 0.7);
            if (highSimilarity.length >= 2) {
                // Extract unique sources
                const sources = new Set();
                for (const r of highSimilarity) {
                    const sm = r.text.match(/^\[(\w+)\]/);
                    if (sm) sources.add(sm[1]);
                }
                
                patternCandidates.push({
                    text: text,
                    similarCount: highSimilarity.length,
                    sources: [...sources],
                    avgScore: highSimilarity.reduce((a, b) => a + b.score, 0) / highSimilarity.length
                });
            }
        }
    }
    
    // Promote candidates to Core
    for (const candidate of patternCandidates) {
        const importance = candidate.sources.length >= 2 ? 7 : 5;
        const sourceTag = candidate.sources.length > 0 ? `[${candidate.sources.join('+')}]` : '[auto]';
        const promoText = `${sourceTag} Pattern (${candidate.similarCount} repetitions): ${candidate.text}`;
        
        if (DRY_RUN) {
            log(`🏗️  [DRY] Cortex→Core: ${promoText.substring(0, 100)}...`);
        } else {
            const result = await apiPost('/memory', {
                layer: 'core',
                text: promoText,
                category: 'lesson',
                importance: importance
            });
            if (result.success) {
                log(`⬆️  Cortex→Core: ${promoText.substring(0, 80)}... (importance=${importance})`);
                promoted.push({ from: 'cortex', to: 'core', text: promoText, importance });
            }
        }
    }
    
    log(`📈 Cortex->Core: ${DRY_RUN ? patternCandidates.length + ' candidates' : promoted.length + ' promotions'}`);
    return promoted;
}

// --- Core -> Soul: Resonance weight ---

async function promoteCoreToSoul() {
    log('🔍 Analyzing Core (facts/lessons) for resonance...');
    
    const journalPath = join(SUBMARINE_DIR, 'CORE-JOURNAL.md');
    if (!existsSync(journalPath)) {
        log('⚠️  CORE-JOURNAL.md not found');
        return [];
    }
    
    const journal = readFileSync(journalPath, 'utf8');
    const entries = journal.split('\n').filter(l => l.startsWith('['));
    
    const promoted = [];
    const checked = new Set();
    
    // Look for records with multi-source confirmation (>=3 sources)
    // and high importance (>=7)
    const recentEntries = entries.slice(-100);
    
    for (const entry of recentEntries) {
        const plainMatch = entry.match(/\]\s*(.*)/);
        if (!plainMatch) continue;
        const text = plainMatch[1].substring(0, 200);
        
        if (checked.has(text.substring(0, 50))) continue;
        checked.add(text.substring(0, 50));
        
        // Already in Soul?
        const soulResults = await apiGet(`/memory/search?q=${encodeURIComponent(text)}&limit=1&layer=soul`);
        if (soulResults.results && soulResults.results.length > 0 && soulResults.results[0].score > 0.85) {
            continue;
        }
        
        // Search for confirmations in Core
        const coreResults = await apiGet(`/memory/search?q=${encodeURIComponent(text)}&limit=8&layer=core`);
        
        if (coreResults.results && coreResults.results.length >= 3) {
            const confirmed = coreResults.results.filter(r => r.score > 0.7);
            
            if (confirmed.length >= 3) {
                // Extract unique sources
                const sources = new Set();
                for (const r of confirmed) {
                    const sm = r.text.match(/^\[(\w+)[+\]]/);
                    if (sm) sources.add(sm[1]);
                }
                
                // Resonance condition: >=3 confirmations OR >=2 unique sources with >=3 confirmations
                if (confirmed.length >= 4 || sources.size >= 2) {
                    const resonanceText = `[resonance:${sources.size}x${confirmed.length}] ${text}`;
                    
                    // Immune check before writing to Soul
                    let finalLayer = 'soul';
                    if (immuneCheck) {
                        try {
                            const check = await immuneCheck(resonanceText, 'soul');
                            if (!check.allowed) {
                                log('  \u{1f6e1} immune: Soul -> ' + check.layer + ' (' + check.reason + ')');
                                finalLayer = check.layer;
                            }
                        } catch (e) { /* immune error — continue to Soul */ }
                    }

                    if (DRY_RUN) {
                        log(`💎 [DRY] Core→${finalLayer}: ${resonanceText.substring(0, 100)}...`);
                    } else {
                        const result = await apiPost('/memory', {
                            layer: finalLayer,
                            text: resonanceText
                        });
                        if (result.success) {
                            log(`💎 Core→Soul: ${resonanceText.substring(0, 80)}...`);
                            promoted.push({ from: 'core', to: 'soul', text: resonanceText });
                        }
                    }
                }
            }
        }
    }
    
    log(`💎 Core->Soul: ${DRY_RUN ? 'analysis complete' : promoted.length + ' promotions'}`);
    return promoted;
}

// ─── Main ───

async function main() {
    log(`🚀 Experience lift ${DRY_RUN ? '(DRY RUN)' : ''}`);
    log('━'.repeat(50));
    
    // Check submarine health
    try {
        const health = await apiGet('/health');
        if (health.status !== 'ok') {
            log(`❌ submarine unhealthy: ${JSON.stringify(health)}`);
            process.exit(1);
        }
        log(`✅ submarine: Soul=${health.checks.layers.soul}, Core=${health.checks.layers.core}, Cortex=${health.checks.layers.cortex}`);
    } catch (e) {
        log(`❌ submarine unavailable: ${e.message}`);
        process.exit(1);
    }
    
    log('━'.repeat(50));
    
    const state = loadState();
    const cortexPromotions = await promoteCortexToCore();
    
    log('━'.repeat(50));
    
    const corePromotions = await promoteCoreToSoul();
    
    log('━'.repeat(50));
    
    // Update state
    state.lastRun = new Date().toISOString();
    state.promoted.toCore += cortexPromotions.length;
    state.promoted.toSoul += corePromotions.length;
    state.history.push({
        date: state.lastRun,
        toCore: cortexPromotions.length,
        toSoul: corePromotions.length,
        dryRun: DRY_RUN
    });
    
    // Keep only last 30 runs
    if (state.history.length > 30) {
        state.history = state.history.slice(-30);
    }
    
    if (!DRY_RUN) saveState(state);
    
    log(`\n📊 Total: Cortex->Core: ${cortexPromotions.length}, Core->Soul: ${corePromotions.length}`);
    log(`📊 All time total: Core: ${state.promoted.toCore}, Soul: ${state.promoted.toSoul}`);
    log(`✅ Experience lift complete`);
}

main().catch(e => {
    console.error(`❌ Fatal: ${e.message}`);
    process.exit(1);
});
