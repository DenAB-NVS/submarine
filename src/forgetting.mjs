/**
 * Forgetting mechanism for the three-layer submarine memory.
 *
 * Three mechanisms:
 *   1. Decay — effectiveImportance decreases over time
 *   2. Supersede — old fact is marked superseded by a new one
 *   3. Archive — low-effectiveness records are marked archived
 *
 * Principle: data is never deleted from LanceDB — only marked in metadata.
 * JOURNAL files are immutable.
 *
 * @module forgetting
 * @author D. Ashford
 */

import { getDb } from '../semantic-memory/memory-engine.mjs';
import { parseSource } from './utils.mjs';
import { markCrystalDirty } from '../core/crystal-update-controller.mjs';

// immune check before archiving Core records
let immuneCheck = null;
try {
    const { immune } = await import('./immune.mjs');
    immuneCheck = immune;
} catch { /* immune not loaded — safe default: do not archive Core */ }

// ============================================================
// Constants
// ============================================================

/** Half-life for Core layer in days */
const CORE_HALF_LIFE_DAYS = 60;

/** Cortex becomes stale after 7 days (already implemented in layers.mjs — here for completeness) */
const CORTEX_STALE_DAYS = 7;

/** Archive thresholds by layer */
const ARCHIVE_THRESHOLDS = {
    soul: Infinity,  // Soul is never archived
    core: 2.0,
    cortex: 1.0
};

/** Categories by layer */
const LAYER_CATEGORIES = {
    soul: ['identity'],
    core: ['fact', 'decision', 'lesson', 'technical', 'finance', 'infrastructure', 'insight', 'philosophy'],
    cortex: ['episode', 'resilient_episode']
};

// ============================================================
// 1. DECAY — importance fading over time
// ============================================================

/**
 * Determines the layer of a record by its category
 * @param {string} category LanceDB category
 * @returns {'soul'|'core'|'cortex'|'unknown'}
 */
export function getLayerByCategory(category) {
    if (LAYER_CATEGORIES.soul.includes(category)) return 'soul';
    if (LAYER_CATEGORIES.core.includes(category)) return 'core';
    if (LAYER_CATEGORIES.cortex.includes(category)) return 'cortex';
    return 'unknown';
}

/**
 * Computes the decay factor for a record.
 *
 * Soul — NO decay (always 1.0).
 * Core — soft decay with half-life of 60 days.
 * Cortex — stale after 7 days (x0.1), resilient_episode without decay.
 *
 * @param {string} layer 'soul'|'core'|'cortex'
 * @param {number} ageDays record age in days
 * @param {Object} [options]
 * @param {boolean} [options.resilient=false] resilient episode (no decay)
 * @returns {number} multiplier 0.0-1.0
 */
export function decayFactor(layer, ageDays, options = {}) {
    if (ageDays < 0) ageDays = 0;

    switch (layer) {
        case 'soul':
            // Soul — permanent, no decay
            return 1.0;

        case 'core':
            // Exponential decay with half-life = CORE_HALF_LIFE_DAYS
            // factor = 0.5^(ageDays / halfLife)
            return Math.pow(0.5, ageDays / CORE_HALF_LIFE_DAYS);

        case 'cortex':
            // resilient_episode — no decay
            if (options.resilient) return 1.0;
            // Regular episodes: after 7 days — stale (x0.1)
            if (ageDays > CORTEX_STALE_DAYS) return 0.1;
            // Linear decay in the first 7 days: 1.0 -> 0.1
            return 1.0 - (ageDays / CORTEX_STALE_DAYS) * 0.9;

        default:
            return 1.0;
    }
}

/**
 * Computes the effective importance of a record considering decay.
 *
 * effectiveImportance = importance x decayFactor(layer, ageDays)
 *
 * @param {Object} record LanceDB record
 * @param {number} record.importance 1-10
 * @param {string} record.category category
 * @param {string} record.timestamp ISO timestamp
 * @returns {number} effective importance
 */
export function effectiveImportance(record) {
    const importance = record.importance ?? 5;
    const layer = getLayerByCategory(record.category);
    const ageDays = getAgeDays(record.timestamp);
    const isResilient = record.category === 'resilient_episode';
    const factor = decayFactor(layer, ageDays, { resilient: isResilient });
    return importance * factor;
}

/**
 * Calculates the age of a record in days
 * @param {string} timestamp ISO string
 * @returns {number}
 */
function getAgeDays(timestamp) {
    if (!timestamp) return 0;
    try {
        return Math.max(0, (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24));
    } catch {
        return 0;
    }
}

// ============================================================
// 2. SUPERSEDE — replacing outdated records
// ============================================================

/**
 * Marks an old record as superseded by a new one.
 * Updates the source (metadata) of the old record: { supersededBy, supersededAt }.
 * JOURNAL is not touched — it is immutable.
 *
 * @param {string} oldId ID of the old record
 * @param {string} newId ID of the new record
 * @param {string} [reason] reason for superseding
 * @returns {Promise<{success: boolean, oldId: string, newId: string, error?: string}>}
 */
export async function supersede(oldId, newId, reason = '') {
    if (!oldId || !newId) {
        return { success: false, oldId, newId, error: 'oldId and newId are required' };
    }
    if (oldId === newId) {
        return { success: false, oldId, newId, error: 'oldId and newId must differ' };
    }

    try {
        const db = await getDb();
        const table = await db.openTable('memories');
        const rows = await table.query().limit(50000).toArray();

        // Find the old record
        let oldRow = null;
        let oldIndex = -1;
        for (let i = 0; i < rows.length; i++) {
            const meta = parseSource(rows[i].source);
            if (meta.id === oldId) {
                oldRow = rows[i];
                oldIndex = i;
                break;
            }
        }

        if (!oldRow) {
            return { success: false, oldId, newId, error: `Record ${oldId} not found` };
        }

        // Verify that newId exists
        const newExists = rows.some(r => {
            const meta = parseSource(r.source);
            return meta.id === newId;
        });
        if (!newExists) {
            return { success: false, oldId, newId, error: `Record ${newId} not found` };
        }

        // Update metadata of the old record
        const oldMeta = parseSource(oldRow.source);
        oldMeta.supersededBy = newId;
        oldMeta.supersededAt = new Date().toISOString();
        if (reason) oldMeta.supersedeReason = reason;

        const newSource = JSON.stringify(oldMeta);

        // LanceDB: update active=false for superseded records
        // and update source with supersede metadata
        // Values in update() are SQL expressions, strings need wrapping in quotes
        const escapedSource = newSource.replace(/'/g, "''");
        await table.update(
            { active: "'false'", source: `'${escapedSource}'` },
            { where: `timestamp = '${oldRow.timestamp}'` }
        );

        console.log(`[forgetting] supersede: ${oldId} -> ${newId}${reason ? ` (${reason})` : ''}`);
        markCrystalDirty('record superseded');
        return { success: true, oldId, newId, reason };
    } catch (err) {
        console.error('[forgetting] supersede error:', err.message);
        return { success: false, oldId, newId, error: err.message };
    }
}

/**
 * Checks whether a record has been superseded
 * @param {Object} record LanceDB record
 * @returns {boolean}
 */
export function isSuperseded(record) {
    const meta = typeof record.source === 'string' ? parseSource(record.source) : (record.metadata || {});
    return !!meta.supersededBy;
}

// ============================================================
// 3. ARCHIVE — archiving low-effectiveness records
// ============================================================

/**
 * Checks whether a record has been archived
 * @param {Object} record LanceDB record
 * @returns {boolean}
 */
export function isArchived(record) {
    const meta = typeof record.source === 'string' ? parseSource(record.source) : (record.metadata || {});
    return !!meta.archived;
}

/**
 * Scans all records and returns candidates for archival.
 *
 * @param {Object} [options]
 * @param {boolean} [options.apply=false] true — mark archived in LanceDB
 * @returns {Promise<{candidates: Array, applied: boolean, count: number}>}
 */
export async function archiveScan(options = {}) {
    const { apply = false } = options;

    try {
        const db = await getDb();
        const table = await db.openTable('memories');
        const rows = await table.query().limit(50000).toArray();

        const candidates = [];

        for (const row of rows) {
            if (row.active === false || row.text === '__init__') continue;

            const meta = parseSource(row.source);
            // Already archived or superseded — skip
            if (meta.archived || meta.supersededBy) continue;

            const layer = getLayerByCategory(row.category);
            const threshold = ARCHIVE_THRESHOLDS[layer];

            // Soul is never archived
            if (threshold === Infinity) continue;

            const effImp = effectiveImportance(row);

            if (effImp < threshold) {
                candidates.push({
                    id: meta.id || null,
                    text: row.text.substring(0, 120),
                    layer,
                    category: row.category,
                    importance: row.importance,
                    effectiveImportance: Math.round(effImp * 1000) / 1000,
                    threshold,
                    ageDays: Math.round(getAgeDays(row.timestamp) * 10) / 10,
                    timestamp: row.timestamp
                });
            }
        }

        if (apply && candidates.length > 0) {
            let applied = 0;
            let immuneProtected = 0;
            for (const c of candidates) {
                try {
                    // immune check before archiving Core records
                    // Soul is already filtered out (threshold=Infinity). Cortex — no check.
                    if (c.layer === 'core') {
                        if (!immuneCheck) {
                            // Immune not loaded — safe default: do NOT archive Core
                            console.log(`  [forgetting] immune unavailable, skipping Core: ${c.text.substring(0, 60)}`);
                            immuneProtected++;
                            continue;
                        }
                        try {
                            const check = await immuneCheck(c.text, 'core');
                            if (check.allowed && check.layer === 'core') {
                                // Immune considers the record valuable for Core — do not archive
                                console.log(`  [forgetting] immune protected Core: ${c.text.substring(0, 60)} (${check.reason})`);
                                immuneProtected++;
                                continue;
                            }
                        } catch {
                            // Immune error — safe default: do NOT archive
                            immuneProtected++;
                            continue;
                        }
                    }

                    // Find the row and update metadata
                    const matchRows = await table.query()
                        .limit(50000)
                        .toArray();
                    const target = matchRows.find(r => {
                        const m = parseSource(r.source);
                        return m.id === c.id && r.text === c.text.substring(0, 120).replace(/…$/, '') + (c.text.length >= 120 ? '' : '');
                    }) || matchRows.find(r => {
                        const m = parseSource(r.source);
                        return m.id === c.id;
                    });

                    if (target) {
                        const oldMeta = parseSource(target.source);
                        oldMeta.archived = true;
                        oldMeta.archivedAt = new Date().toISOString();
                        oldMeta.archivedReason = `effectiveImportance ${c.effectiveImportance} < threshold ${c.threshold}`;

                        await table.update(
                            { active: 'false', source: JSON.stringify(oldMeta) },
                            { where: `timestamp = '${target.timestamp}'` }
                        );
                        applied++;
                    }
                } catch (err) {
                    console.error(`[forgetting] archive error for ${c.id}:`, err.message);
                }
            }
            if (immuneProtected > 0) {
                console.log(`[forgetting] immune protected ${immuneProtected} Core records from archival`);
            }
            console.log(`[forgetting] archive: ${applied}/${candidates.length} records archived`);
            if (applied > 0) markCrystalDirty(`${applied} records archived`);
            return { candidates, applied: true, count: applied };
        }

        return { candidates, applied: false, count: candidates.length };
    } catch (err) {
        console.error('[forgetting] archiveScan error:', err.message);
        return { candidates: [], applied: false, count: 0, error: err.message };
    }
}

// ============================================================
// Search filters
// ============================================================

/**
 * Applies all forgetting filters to search results:
 * - Filters out superseded records
 * - Filters out archived records (unless includeArchived)
 * - Recalculates score considering decay
 *
 * @param {Array} results array of results from searchMemories
 * @param {Object} [options]
 * @param {boolean} [options.includeArchived=false] include archived records
 * @param {boolean} [options.includeSuperseded=false] include superseded records
 * @returns {Array} filtered results
 */
export function applyForgettingFilters(results, options = {}) {
    const { includeArchived = false, includeSuperseded = false } = options;

    return results.filter(r => {
        // Filter by active=false (LanceDB-level: superseded/archived are marked active=false)
        if (!includeSuperseded && !includeArchived && r.active === false) return false;
        // Filter superseded (by metadata in source)
        if (!includeSuperseded && isSuperseded(r)) return false;
        // Filter archived (by metadata in source)
        if (!includeArchived && isArchived(r)) return false;
        return true;
    });
}

/**
 * Computes decay-adjusted score for a search result.
 * Used in layers.mjs for weightedScore.
 *
 * @param {Object} record search result
 * @returns {number} decay factor (0.0-1.0)
 */
export function getDecayFactor(record) {
    const layer = getLayerByCategory(record.category);
    const ageDays = getAgeDays(record.timestamp);
    const isResilient = record.category === 'resilient_episode';
    return decayFactor(layer, ageDays, { resilient: isResilient });
}

// ============================================================
// Utilities
// ============================================================

/**
 * Escapes single quotes for SQL WHERE
 * @param {string} str
 * @returns {string}
 */
function escapeSQL(str) {
    if (!str) return '';
    return str.replace(/'/g, "''");
}

// ============================================================
// CLI interface
// ============================================================

async function cli() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command) {
        console.log(`
[forgetting] submarine forgetting mechanism

Commands:
  archive --dry-run    Show candidates for archival (no changes)
  archive --apply      Apply archival
  stats                Statistics: superseded, archived, decay
  supersede <oldId> <newId> [reason]  Mark a record as superseded
`);
        return;
    }

    switch (command) {
        case 'archive': {
            const apply = args.includes('--apply');
            const dryRun = !apply;
            console.log(`[forgetting] archive scan (${dryRun ? 'DRY RUN' : 'APPLYING'})...`);
            const result = await archiveScan({ apply });

            if (result.candidates.length === 0) {
                console.log('[forgetting] No candidates for archival.');
                return;
            }

            console.log(`\n[forgetting] ${result.candidates.length} candidates:`);
            for (const c of result.candidates) {
                console.log(`  [${c.layer}] importance=${c.importance} effective=${c.effectiveImportance} age=${c.ageDays}d | ${c.text}`);
            }

            if (dryRun) {
                console.log(`\n[forgetting] Dry run — nothing changed. Use --apply to archive.`);
            } else {
                console.log(`\n[forgetting] Archived ${result.count} records.`);
            }
            break;
        }

        case 'stats': {
            const db = await getDb();
            const table = await db.openTable('memories');
            const rows = await table.query().limit(50000).toArray();
            const active = rows.filter(r => r.active !== false && r.text !== '__init__');

            let supersededCount = 0;
            let archivedCount = 0;
            const layerCounts = { soul: 0, core: 0, cortex: 0 };
            const decayBuckets = { fresh: 0, aging: 0, stale: 0 };

            for (const row of active) {
                const meta = parseSource(row.source);
                if (meta.supersededBy) supersededCount++;
                if (meta.archived) archivedCount++;

                const layer = getLayerByCategory(row.category);
                if (layerCounts[layer] !== undefined) layerCounts[layer]++;

                const factor = getDecayFactor(row);
                if (factor > 0.8) decayBuckets.fresh++;
                else if (factor > 0.3) decayBuckets.aging++;
                else decayBuckets.stale++;
            }

            console.log(`\n[forgetting] Stats:`);
            console.log(`  Total active: ${active.length}`);
            console.log(`  Layers: Soul=${layerCounts.soul}, Core=${layerCounts.core}, Cortex=${layerCounts.cortex}`);
            console.log(`  Superseded: ${supersededCount}`);
            console.log(`  Archived: ${archivedCount}`);
            console.log(`  Decay: fresh=${decayBuckets.fresh} aging=${decayBuckets.aging} stale=${decayBuckets.stale}`);
            break;
        }

        case 'supersede': {
            const oldId = args[1];
            const newId = args[2];
            const reason = args.slice(3).join(' ') || '';
            if (!oldId || !newId) {
                console.error('[forgetting] Usage: supersede <oldId> <newId> [reason]');
                process.exit(1);
            }
            const result = await supersede(oldId, newId, reason);
            console.log('[forgetting] supersede result:', result);
            break;
        }

        default:
            console.error(`[forgetting] Unknown command: ${command}`);
            process.exit(1);
    }
}

// Run CLI if invoked directly
const isMainModule = process.argv[1] && (
    process.argv[1].endsWith('forgetting.mjs') ||
    process.argv[1].includes('forgetting')
);
if (isMainModule) {
    cli().catch(err => {
        console.error('[forgetting] Fatal:', err);
        process.exit(2);
    });
}

export default {
    decayFactor,
    effectiveImportance,
    getDecayFactor,
    getLayerByCategory,
    supersede,
    isSuperseded,
    isArchived,
    archiveScan,
    applyForgettingFilters,
    ARCHIVE_THRESHOLDS,
    CORE_HALF_LIFE_DAYS
};
