/**
 * submarine: three-layer abstraction over Semantic Memory Engine
 *
 * Cortex (episodes): fast decay, temporary events
 * Core (facts): medium decay, stable knowledge
 * Soul (identity): permanent, no decay
 *
 * Exports:
 * - Cortex.add(text, metadata)
 * - Cortex.search(query, limit)
 * - Core.add(text, category, importance)
 * - Core.search(query, limit)
 * - Soul.add(text)
 * - Soul.search(query, limit)
 * - unifiedSearch(query, limit)
 * - getLayerStats()
 * - findById(id)
 *
 * @module layers
 * @author D. Ashford
 */

import {
    addMemory,
    searchMemories,
    getStats,
    getDb
} from '../semantic-memory/memory-engine.mjs';
import { generateId, parseSource, withWriteLock } from './utils.mjs';
import { applyForgettingFilters, getDecayFactor } from './forgetting.mjs';
import { markCrystalDirty } from '../core/crystal-update-controller.mjs';
import { appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __layers_dirname = dirname(fileURLToPath(import.meta.url));
const SOUL_JOURNAL = join(__layers_dirname, '..', 'SOUL-JOURNAL.md');
const CORE_JOURNAL = join(__layers_dirname, '..', 'CORE-JOURNAL.md');
const CORTEX_JOURNAL = join(__layers_dirname, '..', 'CORTEX-JOURNAL.md');
const CHANGELOG = join(__layers_dirname, '..', 'CHANGELOG.live.md');

/**
 * Appends an entry to a JOURNAL file — a permanent text log
 * @param {string} journalPath path to the file
 * @param {string} text entry text
 * @param {string} [prefix] optional prefix (category)
 */
function appendJournal(journalPath, text, prefix = '') {
    try {
        const tag = prefix ? `[${prefix}] ` : '';
        const entry = `[${new Date().toISOString()}] ${tag}${text}\n`;
        appendFileSync(journalPath, entry);
    } catch (e) {
        console.error('Failed to write to JOURNAL:', e.message);
    }
}

/**
 * Logs an operation to the live journal — submarine pulse
 * @param {string} operation write|search|sync|rebuild|health|error
 * @param {string} layer soul|core|cortex|all
 * @param {string} description
 */
function logChange(operation, layer, description) {
    try {
        const entry = `[${new Date().toISOString()}] [${operation}] [${layer}] ${description}\n`;
        appendFileSync(CHANGELOG, entry);
    } catch (e) { /* pulse must not crash the system */ }
}

// Constants
const CORTEX_CATEGORY = 'episode';
const CORTEX_IMPORTANCE = 3;
const CORTEX_DECAY_DAYS = 7;
const CORTEX_STALE_FACTOR = 0.1;

const CORE_DEFAULT_CATEGORY = 'fact';
const CORE_DEFAULT_IMPORTANCE = 5;

const SOUL_CATEGORY = 'identity';
const SOUL_IMPORTANCE = 10;

/**
 * Converts metadata to a JSON string for storing in source
 * @param {Object} metadata
 * @returns {string}
 */
function metadataToString(metadata) {
    if (!metadata || Object.keys(metadata).length === 0) {
        return '';
    }
    try {
        return JSON.stringify(metadata);
    } catch (err) {
        console.error('Failed to serialize metadata:', err);
        return '';
    }
}

/**
 * Converts a source string back to metadata
 * @param {string} sourceStr
 * @returns {Object}
 */
function sourceToMetadata(sourceStr) {
    return parseSource(sourceStr);
}

/**
 * Calculates the age of a record in days
 * @param {string} timestamp ISO string
 * @returns {number} days
 */
function getAgeDays(timestamp) {
    if (!timestamp) return 0;
    try {
        const then = new Date(timestamp).getTime();
        const now = Date.now();
        return (now - then) / (1000 * 60 * 60 * 24);
    } catch (err) {
        return 0;
    }
}

/**
 * Cortex — episode layer
 */
export const Cortex = {
    /**
     * Add an episode
     * @param {string} text episode text
     * @param {Object} metadata additional metadata (stored in source as JSON)
     * @returns {Promise<Object>} addition result {success, id, text, layer}
     */
    async add(text, metadata = {}) {
        return withWriteLock(async () => {
            const id = generateId();
            const category = metadata.resilient ? 'resilient_episode' : CORTEX_CATEGORY;
            const enrichedMetadata = { ...metadata, id };
            const source = metadataToString(enrichedMetadata);
            const result = await addMemory(text, source, category, CORTEX_IMPORTANCE);
            appendJournal(CORTEX_JOURNAL, text);
            logChange('write', 'cortex', text.substring(0, 80));
            markCrystalDirty('record added to cortex');
            return { ...result, id, layer: 'cortex' };
        });
    },

    /**
     * Search episodes
     * @param {string} query search query
     * @param {number} limit maximum number of results (default 5)
     * @returns {Promise<Array>} array of results with stale field for outdated records
     */
    async search(query, limit = 5, options = {}) {
        // Cortex — soft threshold 0.1. Fresh episodes, temporal decay active.
        const results = await searchMemories(query, limit * 3, 0.1, [CORTEX_CATEGORY, 'resilient_episode'], options);
        const cortexResults = results.filter(r =>
            r.category === CORTEX_CATEGORY || r.category === 'resilient_episode'
        );

        // Apply forgetting filters (superseded, archived)
        const filtered = applyForgettingFilters(cortexResults, {
            includeArchived: options.includeArchived || false,
            includeSuperseded: options.includeSuperseded || false
        });

        const enriched = filtered.map(r => {
            const ageDays = getAgeDays(r.timestamp);
            const isResilient = r.category === 'resilient_episode';
            const stale = !isResilient && ageDays > CORTEX_DECAY_DAYS;
            let adjustedScore = r.score;
            if (stale) {
                adjustedScore *= CORTEX_STALE_FACTOR;
            }
            return {
                ...r,
                score: adjustedScore,
                stale,
                resilient: isResilient,
                metadata: sourceToMetadata(r.source)
            };
        });

        // Sort by adjusted score
        enriched.sort((a, b) => b.score - a.score);
        return enriched.slice(0, limit);
    },

    /**
     * Finds stale episode records (older than 7 days)
     * @returns {Promise<{staleCount: number, staleIds: string[]}>}
     */
    async cleanup() {
        try {
            const db = await getDb();
            const table = await db.openTable('memories');
            const rows = await table.query()
                .filter(`category = '${CORTEX_CATEGORY}'`)
                .limit(50000)
                .toArray();
            const now = Date.now();
            const staleIds = [];
            for (const row of rows) {
                if (row.timestamp) {
                    const age = now - new Date(row.timestamp).getTime();
                    if (age > CORTEX_DECAY_DAYS * 24 * 60 * 60 * 1000) {
                        const meta = parseSource(row.source);
                        if (meta.id) {
                            staleIds.push(meta.id);
                        }
                    }
                }
            }
            return {
                staleCount: staleIds.length,
                staleIds
            };
        } catch (err) {
            console.error('Error in Cortex cleanup:', err);
            return { staleCount: 0, staleIds: [] };
        }
    }
};

/**
 * Core — facts and decisions layer
 */
export const Core = {
    /**
     * Add a fact
     * @param {string} text fact text
     * @param {string} category category ('fact', 'decision', 'lesson', etc.)
     * @param {number} importance importance 1-10
     * @returns {Promise<Object>} addition result {success, id, text, layer}
     */
    async add(text, category = CORE_DEFAULT_CATEGORY, importance = CORE_DEFAULT_IMPORTANCE, parentId = null) {
        return withWriteLock(async () => {
            const id = generateId();
            const source = JSON.stringify({ id, origin: 'core', parentId: parentId || undefined });
            const result = await addMemory(text, source, category, importance);
            appendJournal(CORE_JOURNAL, text, category);
            logChange('write', 'core', `[${category}] ${text.substring(0, 60)}`);
            markCrystalDirty('record added to core');
            return { ...result, id, layer: 'core', parentId };
        });
    },

    /**
     * Search facts, decisions, lessons
     * @param {string} query search query
     * @param {number} limit maximum number of results (default 5)
     * @returns {Promise<Array>} array of results
     */
    async search(query, limit = 5, options = {}) {
        // Core — medium threshold 0.2. Sensitive enough for the filtered pool,
        // but not so soft as to let noise through.
        const coreCategories = ['fact', 'decision', 'lesson', 'technical', 'finance', 'infrastructure', 'insight', 'philosophy'];
        const results = await searchMemories(query, limit * 3, 0.2, coreCategories, options);
        const coreResults = results.filter(r => coreCategories.includes(r.category));

        // Apply forgetting filters (superseded, archived)
        const filtered = applyForgettingFilters(coreResults, {
            includeArchived: options.includeArchived || false,
            includeSuperseded: options.includeSuperseded || false
        });

        return filtered.slice(0, limit);
    }
};

/**
 * Soul — identity layer
 */
export const Soul = {
    /**
     * Add an identity assertion
     * @param {string} text assertion text
     * @returns {Promise<Object>} addition result {success, id, text, layer}
     */
    async add(text, parentId = null) {
        return withWriteLock(async () => {
            const id = generateId();
            const source = JSON.stringify({ id, origin: 'soul', parentId: parentId || undefined });
            const result = await addMemory(text, source, SOUL_CATEGORY, SOUL_IMPORTANCE);
            appendJournal(SOUL_JOURNAL, text);
            logChange('write', 'soul', text.substring(0, 80));
            markCrystalDirty('record added to soul');
            return { ...result, id, layer: 'soul', parentId };
        });
    },

    /**
     * Search identity assertions
     * @param {string} query search query
     * @param {number} limit maximum number of results (default 5)
     * @returns {Promise<Array>} array of results
     */
    async search(query, limit = 5, options = {}) {
        // Soul — strict threshold 0.3. Identity must not be diluted.
        // If the query is not about identity — it's correct for Soul to stay silent.
        // Soul is NOT subject to decay, but superseded/archived filters still apply.
        const results = await searchMemories(query, limit * 2, 0.3, SOUL_CATEGORY, options);
        const soulResults = results.filter(r => r.category === SOUL_CATEGORY);

        const filtered = applyForgettingFilters(soulResults, {
            includeArchived: options.includeArchived || false,
            includeSuperseded: options.includeSuperseded || false
        });

        return filtered.slice(0, limit);
    }
};

/**
 * Find a record by ID (scans all records)
 * @param {string} id identifier
 * @returns {Promise<Object|null>} found record or null
 */
export async function findById(id) {
    if (!id || typeof id !== 'string') {
        return null;
    }
    try {
        const db = await getDb();
        const table = await db.openTable('memories');
        const rows = await table.query().limit(50000).toArray();
        for (const row of rows) {
            const meta = parseSource(row.source);
            if (meta.id === id) {
                return {
                    ...row,
                    metadata: meta
                };
            }
        }
        return null;
    } catch (err) {
        console.error('Error in findById:', err);
        return null;
    }
}

/**
 * Computes the importance factor from metadata (importance 1-10, normalized to a multiplier).
 * Takes decay into account: effectiveImportance = importance x decayFactor
 * @param {Object} record a LanceDB record
 * @returns {number} importance multiplier (0.1 - 1.0)
 */
function getImportanceFactor(record) {
    const imp = record.importance ?? record.metadata?.importance ?? 5;
    const decay = getDecayFactor(record);
    return Math.max(0.1, Math.min(1.0, (imp * decay) / 10));
}

/**
 * Unified search across all layers with weight coefficients and importance consideration.
 * Formula: weightedScore = score x layerWeight x importanceFactor
 * @param {string} query search query
 * @param {number} limit total number of results (default 10)
 * @returns {Promise<Array>} array of results with layer and weightedScore fields
 */
export async function unifiedSearch(query, limit = 10, options = {}) {
    // Sequential search: LanceDB ARM64 deadlock on parallel search
    const cortexResults = await Cortex.search(query, limit, options);
    const coreResults = await Core.search(query, limit, options);
    const soulResults = await Soul.search(query, limit, options);

    const combined = [];

    // Soul x3.0 x importance
    for (const r of soulResults) {
        const impFactor = getImportanceFactor(r);
        combined.push({
            ...r,
            layer: 'soul',
            importanceFactor: impFactor,
            weightedScore: r.score * 3.0 * impFactor
        });
    }

    // Core x2.0 x importance
    for (const r of coreResults) {
        const impFactor = getImportanceFactor(r);
        combined.push({
            ...r,
            layer: 'core',
            importanceFactor: impFactor,
            weightedScore: r.score * 2.0 * impFactor
        });
    }

    // Cortex x1.0 x importance
    for (const r of cortexResults) {
        const impFactor = getImportanceFactor(r);
        combined.push({
            ...r,
            layer: 'cortex',
            importanceFactor: impFactor,
            weightedScore: r.score * 1.0 * impFactor
        });
    }

    combined.sort((a, b) => b.weightedScore - a.weightedScore);
    return combined.slice(0, limit);
}

/**
 * Deep search — implementation of four reasoning passes:
 *
 * Pass 1 (Soul): "Who am I in the context of this query?" — search Soul, establish identity
 * Pass 2 (Core): "What do I know about this?" — search Core, query enriched with Soul context
 * Pass 3 (Coupling): Check correlation between Soul and Core results — coupling filter
 * Pass 4 (Cortex + surfacing): "What happened recently?" + final context assembly
 *
 * Through the ocean (Cortex, natural flow) -> surfacing (result, natural)
 *
 * @param {string} query search query
 * @param {Object} options parameters
 * @param {number} [options.soulLimit=3] results from Soul
 * @param {number} [options.coreLimit=5] results from Core
 * @param {number} [options.cortexLimit=3] results from Cortex
 * @param {number} [options.totalLimit=10] total output limit
 * @returns {Promise<Object>} deep search result
 */
export async function deepSearch(query, options = {}) {
    const {
        soulLimit = 3,
        coreLimit = 5,
        cortexLimit = 3,
        totalLimit = 10
    } = options;

    // === PASS 1 + 4 SEQUENTIAL: LanceDB ARM64 deadlock on parallel search ===
    // Parallel Promise.all hangs (LanceDB Rust binding concurrent table.search)
    const soulResults = await Soul.search(query, soulLimit, options);
    const cortexResults = await Cortex.search(query, cortexLimit, options);

    const soulEnriched = soulResults.map(r => {
        const impFactor = getImportanceFactor(r);
        return {
            ...r,
            layer: 'soul',
            pass: 1,
            importanceFactor: impFactor,
            weightedScore: r.score * 3.0 * impFactor
        };
    });

    const cortexEnriched = cortexResults.map(r => {
        const impFactor = getImportanceFactor(r);
        return {
            ...r,
            layer: 'cortex',
            pass: 4,
            importanceFactor: impFactor,
            weightedScore: r.score * 1.0 * impFactor
        };
    });

    // === PASS 2: CORE — What do I know? (enriched with Soul context) ===
    // Build enriched query: original + keywords from Soul
    let enrichedQuery = query;
    if (soulEnriched.length > 0) {
        const soulContext = soulEnriched[0].text;
        const soulWords = soulContext
            .split(/\s+/)
            .filter(w => w.length > 4)
            .slice(0, 5)
            .join(' ');
        enrichedQuery = `${query} ${soulWords}`;
    }

    const coreResults = await Core.search(enrichedQuery, coreLimit, options);
    const coreEnriched = coreResults.map(r => {
        const impFactor = getImportanceFactor(r);
        return {
            ...r,
            layer: 'core',
            pass: 2,
            importanceFactor: impFactor,
            weightedScore: r.score * 2.0 * impFactor
        };
    });

    // === PASS 3: COUPLING — Compute coupling from Soul and Core result intersection ===
    // Instead of a separate searchMemories(soulText) — compare score overlap
    let couplingScore = 0;
    if (soulEnriched.length > 0 && coreEnriched.length > 0) {
        // Coupling via score overlap: if both Soul and Core have high scores,
        // it means identity and knowledge resonate on this topic
        const soulAvgScore = soulEnriched.reduce((s, r) => s + r.score, 0) / soulEnriched.length;
        const coreAvgScore = coreEnriched.reduce((s, r) => s + r.score, 0) / coreEnriched.length;
        // Geometric mean normalizes different score scales
        couplingScore = Math.sqrt(soulAvgScore * coreAvgScore);
    }

    // Coupling bonus: if Soul and Core resonate — boost Core
    const couplingBonus = 1.0 + Math.min(couplingScore * 3, 0.5); // max bonus +50%
    const coreBoosted = coreEnriched.map(r => ({
        ...r,
        couplingScore,
        weightedScore: r.weightedScore * couplingBonus
    }));

    // === SURFACING — final assembly ===
    const combined = [...soulEnriched, ...coreBoosted, ...cortexEnriched];
    combined.sort((a, b) => b.weightedScore - a.weightedScore);

    return {
        results: combined.slice(0, totalLimit),
        meta: {
            passes: 4,
            soulCount: soulEnriched.length,
            coreCount: coreBoosted.length,
            cortexCount: cortexEnriched.length,
            couplingScore,
            couplingBonus,
            enrichedQuery: enrichedQuery !== query ? enrichedQuery : null
        }
    };
}

/**
 * Layer statistics — counting by categories from LanceDB
 * @returns {Promise<Object>} object with record counts for each layer
 */
export async function getLayerStats() {
    try {
        const db = await getDb();
        const tables = await db.tableNames();
        if (!tables.includes('memories')) {
            return { cortex: { count: 0 }, core: { count: 0 }, soul: { count: 0 }, total: { count: 0 } };
        }
        const table = await db.openTable('memories');
        const rows = await table.query().limit(50000).toArray();
        const active = rows.filter(r => r.active !== false && r.text !== '__init__');

        const CORE_CATEGORIES = ['fact', 'decision', 'lesson', 'technical', 'finance', 'infrastructure', 'insight', 'philosophy'];
        let cortex = 0, core = 0, soul = 0;
        for (const r of active) {
            if (r.category === CORTEX_CATEGORY || r.category === 'resilient_episode') cortex++;
            else if (r.category === SOUL_CATEGORY) soul++;
            else if (CORE_CATEGORIES.includes(r.category)) core++;
        }

        return {
            cortex: { count: cortex },
            core: { count: core },
            soul: { count: soul },
            total: { count: active.length }
        };
    } catch (err) {
        console.error('Error counting layer statistics:', err.message);
        return { cortex: { count: 0 }, core: { count: 0 }, soul: { count: 0 }, total: { count: 0 } };
    }
}

/**
 * Find all children of a record (records with parentId = given id)
 * @param {string} parentId ID of the parent record
 * @returns {Promise<Array>} array of child records
 */
export async function findChildren(parentId) {
    if (!parentId) return [];
    try {
        const db = await getDb();
        const table = await db.openTable('memories');
        const rows = await table.query().limit(50000).toArray();
        const children = [];
        for (const row of rows) {
            const meta = parseSource(row.source);
            if (meta.parentId === parentId) {
                children.push({
                    ...row,
                    metadata: meta,
                    layer: row.category === 'identity' ? 'soul' :
                           row.category === 'episode' || row.category === 'resilient_episode' ? 'cortex' : 'core'
                });
            }
        }
        return children;
    } catch (err) {
        console.error('Error in findChildren:', err);
        return [];
    }
}

/**
 * Find the ancestor chain (from a record upward to the root)
 * @param {string} id record ID
 * @param {number} maxDepth maximum traversal depth
 * @returns {Promise<Array>} ancestor chain [nearest...root]
 */
export async function findAncestors(id, maxDepth = 10) {
    const ancestors = [];
    let currentId = id;
    for (let depth = 0; depth < maxDepth; depth++) {
        const record = await findById(currentId);
        if (!record) break;
        const meta = record.metadata || parseSource(record.source);
        if (!meta.parentId) break;
        const parent = await findById(meta.parentId);
        if (!parent) break;
        ancestors.push(parent);
        currentId = meta.parentId;
    }
    return ancestors;
}

/**
 * Find the "most fertile" records — those with the most children
 * @param {string} layer 'soul'|'core'|'cortex'|'all'
 * @param {number} limit number of results
 * @returns {Promise<Array<{id: string, text: string, childCount: number}>>}
 */
export async function findMostFertile(layer = 'all', limit = 10) {
    try {
        const db = await getDb();
        const table = await db.openTable('memories');
        const rows = await table.query().limit(50000).toArray();

        // Count children
        const parentCounts = new Map();
        for (const row of rows) {
            const meta = parseSource(row.source);
            if (meta.parentId) {
                parentCounts.set(meta.parentId, (parentCounts.get(meta.parentId) || 0) + 1);
            }
        }

        // Filter by layer
        const layerCategories = {
            soul: ['identity'],
            core: ['fact', 'decision', 'lesson', 'technical', 'finance', 'infrastructure'],
            cortex: ['episode', 'resilient_episode']
        };
        const validCategories = layer === 'all' ? null : layerCategories[layer];

        const results = [];
        for (const row of rows) {
            if (validCategories && !validCategories.includes(row.category)) continue;
            const meta = parseSource(row.source);
            const id = meta.id;
            if (!id) continue;
            const childCount = parentCounts.get(id) || 0;
            if (childCount > 0) {
                results.push({
                    id,
                    text: row.text?.substring(0, 120),
                    childCount,
                    layer: row.category === 'identity' ? 'soul' :
                           row.category === 'episode' || row.category === 'resilient_episode' ? 'cortex' : 'core'
                });
            }
        }

        results.sort((a, b) => b.childCount - a.childCount);
        return results.slice(0, limit);
    } catch (err) {
        console.error('Error in findMostFertile:', err);
        return [];
    }
}

// For backward compatibility (if someone imports default)
export default {
    Cortex,
    Core,
    Soul,
    unifiedSearch,
    deepSearch,
    getLayerStats,
    findById,
    findChildren,
    findAncestors,
    findMostFertile
};
