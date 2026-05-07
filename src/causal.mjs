/**
 * Causal graph for the three-layer submarine memory.
 * Stores relations between facts with direction, type, strength, and confidence.
 * @module causal
 * @author D. Ashford
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { withWriteLock } from './utils.mjs';
import { getConfig, getSubmarinePath } from './config.mjs';
import { markCrystalDirty } from '../core/crystal-update-controller.mjs';

const __causal_dirname = dirname(fileURLToPath(import.meta.url));
const _paths = getConfig().paths || {};
const GRAPH_FILE = join(getSubmarinePath(), _paths.causalGraph || join('data', 'causal-graph.json'));
const JOURNAL_FILE = join(__causal_dirname, '..', 'RELATIONS-JOURNAL.md');

/**
 * Generates a unique edge identifier in format rel_<timestamp36>_<random4>
 * @returns {string}
 */
function generateRelationId() {
    const timestamp36 = Date.now().toString(36);
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let random4 = '';
    for (let i = 0; i < 4; i++) {
        random4 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `rel_${timestamp36}_${random4}`;
}

/**
 * Causal graph edge schema
 * @typedef {Object} Edge
 * @property {string} id
 * @property {string} sourceId
 * @property {string} targetId
 * @property {string} sourceText
 * @property {string} targetText
 * @property {'causes'|'enables'|'prevents'|'correlates'} relation
 * @property {'soul'|'core'|'cortex'} layer
 * @property {1|2|3} rung
 * @property {number} alpha
 * @property {number} beta
 * @property {string} validFrom
 * @property {string|null} validTo
 * @property {string|null} supersededBy
 * @property {string} createdAt
 */

/** @type {Edge[]} */
let edges = [];

/** @type {Map<string, {incoming: Edge[], outgoing: Edge[]}>} */
let nodes = new Map();

/** Flag: graph already loaded from disk (do not parse again) */
let initialized = false;
/** Promise-guard against race condition on parallel initGraph */
let _initPromise = null;

/**
 * Loads the graph from a JSON file, creates it if it does not exist.
 * Promise-guard: parallel calls wait for the same Promise (no withWriteLock —
 * initGraph is called from within addRelation, which is already locked, deadlock impossible).
 * @returns {Promise<{edges: Edge[], nodes: Map<string, {incoming: Edge[], outgoing: Edge[]}>}>}
 */
export async function initGraph() {
    if (initialized) return { edges, nodes };
    if (_initPromise) return _initPromise;
    _initPromise = _initGraphImpl();
    return _initPromise;
}

async function _initGraphImpl() {
    try {
        const data = await fs.readFile(GRAPH_FILE, 'utf8');
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) {
            throw new Error('Graph file must contain an array of edges');
        }
        edges = parsed;
        rebuildNodes();
        console.log(`[causal] Loaded ${edges.length} edges`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            // File does not exist, initialize with empty graph
            edges = [];
            nodes = new Map();
            await saveGraph();
            console.log('[causal] Created new graph');
        } else {
            console.error('[causal] Error loading graph:', err.message);
            throw err;
        }
    }
    // migration — mark phantom and null edges
    const PHANTOM_PREFIXES = ['contra_', 'sync_', 'manual_'];
    const isPhantom = (id) => id && PHANTOM_PREFIXES.some(p => id.startsWith(p));
    let migrated = 0;
    for (const edge of edges) {
        // Phantom IDs (contra_*, sync_*, manual_*)
        if (isPhantom(edge.sourceId) && !edge.legacySourceId) {
            edge.legacySourceId = edge.sourceId;
            migrated++;
        }
        if (isPhantom(edge.targetId) && !edge.legacyTargetId) {
            edge.legacyTargetId = edge.targetId;
            migrated++;
        }
        // Null ID edges — contain useful text, mark as incomplete
        if ((edge.sourceId === null || edge.sourceId === undefined) && !edge.incomplete) {
            edge.incomplete = true;
            migrated++;
        }
        if ((edge.targetId === null || edge.targetId === undefined) && !edge.incomplete) {
            edge.incomplete = true;
            migrated++;
        }
    }
    if (migrated > 0) {
        await saveGraph();
        console.log(`[causal] marked ${migrated} phantom/null IDs as legacy/incomplete`);
    }

    initialized = true;
    return { edges, nodes };
}

/**
 * Rebuilds the node index from the edges array
 */
function rebuildNodes() {
    nodes = new Map();
    for (const edge of edges) {
        // outgoing
        if (!nodes.has(edge.sourceId)) {
            nodes.set(edge.sourceId, { incoming: [], outgoing: [] });
        }
        nodes.get(edge.sourceId).outgoing.push(edge);
        // incoming
        if (!nodes.has(edge.targetId)) {
            nodes.set(edge.targetId, { incoming: [], outgoing: [] });
        }
        nodes.get(edge.targetId).incoming.push(edge);
    }
}

/**
 * Adds a new edge to the graph
 * @param {string} sourceId ID of the cause record
 * @param {string} sourceText brief text of the cause
 * @param {string} targetId ID of the effect record
 * @param {string} targetText brief text of the effect
 * @param {'causes'|'enables'|'prevents'|'correlates'} relation relation type
 * @param {'soul'|'core'|'cortex'} layer layer
 * @param {1|2|3} [rung=1] Pearl's rung level
 * @returns {Promise<{id: string, sourceText: string, targetText: string, relation: string}>}
 */
export async function addRelation(sourceId, sourceText, targetId, targetText, relation, layer, rung = 1) {
    // validation — do not create edge with null/undefined ID
    if (!sourceId || !targetId) {
        console.warn(`[causal] rejected edge with null ID: source=${sourceId}, target=${targetId}`);
        return { id: null, sourceText, targetText, relation, rejected: true };
    }
    return withWriteLock(async () => {
        // Initialize graph if not yet loaded
        if (edges.length === 0 && nodes.size === 0) {
            await initGraph();
        }
        const id = generateRelationId();
        const now = new Date().toISOString();
        /** @type {Edge} */
        const edge = {
            id,
            sourceId,
            targetId,
            sourceText,
            targetText,
            relation,
            layer,
            rung,
            alpha: 1,
            beta: 1,
            validFrom: now,
            validTo: null,
            supersededBy: null,
            createdAt: now
        };
        edges.push(edge);
        rebuildNodes();
        await saveGraph();
        await appendJournal(edge);
        console.log(`[causal] Added edge ${id} (${relation})`);
        markCrystalDirty('causal edge added');
        return { id, sourceText, targetText, relation };
    });
}

/**
 * Appends a relation entry to the JOURNAL file
 * @param {Edge} edge
 */
async function appendJournal(edge) {
    try {
        // If file does not exist, create with header
        try {
            await fs.access(JOURNAL_FILE);
        } catch {
            await fs.writeFile(JOURNAL_FILE, '# RELATIONS-JOURNAL.md — permanent log of causal relations\n\n');
        }
        const entry = `[${edge.createdAt}] [${edge.relation}] [${edge.layer}] "${edge.sourceText}" -> "${edge.targetText}" (alpha:${edge.alpha}, beta:${edge.beta})\n`;
        await fs.appendFile(JOURNAL_FILE, entry);
    } catch (err) {
        console.error('[causal] Failed to write to JOURNAL:', err.message);
    }
}

/**
 * Finds all effects of a fact (direct or chained)
 * @param {string} sourceId ID of the source record
 * @param {number} [depth=1] traversal depth (1 = direct effects)
 * @returns {Promise<Array<{edge: Edge, depth: number, chainStrength: number}>>}
 */
export async function getEffects(sourceId, depth = 1) {
    if (edges.length === 0 && nodes.size === 0) {
        await initGraph();
    }
    const results = [];
    const visited = new Set();
    const queue = /** @type {Array<{id: string, depth: number, chainStrength: number}>} */ ([]);
    queue.push({ id: sourceId, depth: 0, chainStrength: 1.0 });
    while (queue.length > 0) {
        const { id, depth: curDepth, chainStrength } = queue.shift();
        if (curDepth >= depth) continue;
        const node = nodes.get(id);
        if (!node) continue;
        for (const edge of node.outgoing) {
            const edgeKey = edge.id;
            if (visited.has(edgeKey)) continue;
            visited.add(edgeKey);
            const edgeStrength = edge.alpha / (edge.alpha + edge.beta);
            const newChainStrength = chainStrength * edgeStrength * Math.pow(0.9, curDepth);
            results.push({ edge, depth: curDepth + 1, chainStrength: newChainStrength });
            if (curDepth + 1 < depth) {
                queue.push({ id: edge.targetId, depth: curDepth + 1, chainStrength: newChainStrength });
            }
        }
    }
    return results;
}

/**
 * Finds causes of a fact (reverse traversal)
 * @param {string} targetId ID of the effect
 * @param {number} [depth=1] traversal depth
 * @returns {Promise<Array<{edge: Edge, depth: number, chainStrength: number}>>}
 */
export async function getCauses(targetId, depth = 1) {
    if (edges.length === 0 && nodes.size === 0) {
        await initGraph();
    }
    const results = [];
    const visited = new Set();
    const queue = /** @type {Array<{id: string, depth: number, chainStrength: number}>} */ ([]);
    queue.push({ id: targetId, depth: 0, chainStrength: 1.0 });
    while (queue.length > 0) {
        const { id, depth: curDepth, chainStrength } = queue.shift();
        if (curDepth >= depth) continue;
        const node = nodes.get(id);
        if (!node) continue;
        for (const edge of node.incoming) {
            const edgeKey = edge.id;
            if (visited.has(edgeKey)) continue;
            visited.add(edgeKey);
            const edgeStrength = edge.alpha / (edge.alpha + edge.beta);
            const newChainStrength = chainStrength * edgeStrength * Math.pow(0.9, curDepth);
            results.push({ edge, depth: curDepth + 1, chainStrength: newChainStrength });
            if (curDepth + 1 < depth) {
                queue.push({ id: edge.sourceId, depth: curDepth + 1, chainStrength: newChainStrength });
            }
        }
    }
    return results;
}

/**
 * Finds the root cause (traverses causes until reaching a Soul record or maxDepth)
 * @param {string} factId ID of the starting fact
 * @param {number} [maxDepth=5] maximum depth
 * @returns {Promise<{rootEdge: Edge|null, path: Edge[], depth: number}>}
 */
export async function rootCause(factId, maxDepth = 5) {
    if (edges.length === 0 && nodes.size === 0) {
        await initGraph();
    }
    const path = [];
    let currentId = factId;
    let depth = 0;
    while (depth < maxDepth) {
        const node = nodes.get(currentId);
        if (!node || node.incoming.length === 0) break;
        // Take the first edge (could pick the strongest, but for now just the first)
        const edge = node.incoming[0];
        path.push(edge);
        // If the cause is in the Soul layer — stop
        if (edge.layer === 'soul') {
            return { rootEdge: edge, path, depth: depth + 1 };
        }
        currentId = edge.sourceId;
        depth++;
    }
    return { rootEdge: path.length > 0 ? path[path.length - 1] : null, path, depth };
}

/**
 * Updates edge strength after verification (confirmation or refutation)
 * @param {string} edgeId edge ID
 * @param {boolean} confirmed true = confirmation, false = refutation
 * @returns {Promise<Edge>} updated edge
 */
export async function updateStrength(edgeId, confirmed) {
    return withWriteLock(async () => {
        if (edges.length === 0 && nodes.size === 0) {
            await initGraph();
        }
        const edge = edges.find(e => e.id === edgeId);
        if (!edge) {
            throw new Error(`Edge with ID ${edgeId} not found`);
        }
        if (confirmed) {
            edge.alpha += 1;
        } else {
            edge.beta += 1;
        }
        // Recalculate strength and confidence (stored as computed, but fields can be added)
        rebuildNodes(); // rebuild index (although the edge does not change connections)
        await saveGraph();
        console.log(`[causal] Updated edge ${edgeId}: alpha=${edge.alpha}, beta=${edge.beta}`);
        return edge;
    });
}

/**
 * Computes edge statistics: strength, confidence, uncertainty
 * @param {Edge} edge
 * @returns {{strength: number, confidence: number, uncertainty: number}}
 */
export function getEdgeStats(edge) {
    const { alpha, beta } = edge;
    const total = alpha + beta;
    const strength = alpha / total;
    const confidence = 1 - 1 / total;
    // Uncertainty = sqrt(strength * (1 - strength) / total)
    const uncertainty = Math.sqrt(strength * (1 - strength) / total);
    return { strength, confidence, uncertainty };
}

/**
 * Saves the graph to a JSON file
 * @returns {Promise<void>}
 */
export async function saveGraph() {
    // atomic write (tmp + rename) to protect against race conditions
    const tmpFile = GRAPH_FILE + '.tmp';
    try {
        await fs.writeFile(tmpFile, JSON.stringify(edges, null, 2));
        await fs.rename(tmpFile, GRAPH_FILE);
    } catch (err) {
        console.error('[causal] Error saving graph:', err.message);
        // Cleanup tmp on failure
        try { await fs.unlink(tmpFile); } catch { /* ignore */ }
        throw err;
    }
}

/**
 * Automatically detects the type of causal relation from text.
 * Looks for patterns of causality, correlation, blocking.
 * @param {string} text text to analyze
 * @returns {Array<{source: string, target: string, relation: 'causes'|'enables'|'prevents'|'correlates'}>}
 */
// removed export — not imported, kept as internal utility
function detectRelations(text) {
    if (!text || text.length < 20) return [];
    const results = [];

    /** @type {Array<{re: RegExp, relation: string, sourceGroup: number, targetGroup: number}>} */
    const patterns = [
        // causes
        { re: /(.{10,80}?)\s+(?:because|due to the fact that|as a result of|consequently)\s+(.{10,80})/gi, relation: 'causes', sourceGroup: 2, targetGroup: 1 },
        { re: /(.{10,80}?)\s+(?:led to|leads to|caused|causes)\s+(.{10,80})/gi, relation: 'causes', sourceGroup: 1, targetGroup: 2 },
        // enables
        { re: /(.{10,80}?)\s+(?:allows|allowed|thanks to|makes possible)\s+(.{10,80})/gi, relation: 'enables', sourceGroup: 1, targetGroup: 2 },
        { re: /(.{10,80}?)\s+(?:therefore|hence|so)\s+(.{10,80})/gi, relation: 'enables', sourceGroup: 1, targetGroup: 2 },
        // prevents
        { re: /(.{10,80}?)\s+(?:despite|in spite of)\s+(.{10,80})/gi, relation: 'prevents', sourceGroup: 2, targetGroup: 1 },
        { re: /(.{10,80}?)\s+(?:prevented|prevents|blocks|blocked|hinders)\s+(.{10,80})/gi, relation: 'prevents', sourceGroup: 1, targetGroup: 2 },
        // correlates
        { re: /(.{10,80}?)\s+(?:correlates with|related to|in parallel with|simultaneously with)\s+(.{10,80})/gi, relation: 'correlates', sourceGroup: 1, targetGroup: 2 },
    ];

    for (const p of patterns) {
        let m;
        while ((m = p.re.exec(text)) !== null) {
            const source = m[p.sourceGroup].trim();
            const target = m[p.targetGroup].trim();
            if (source.length > 5 && target.length > 5) {
                results.push({ source, target, relation: p.relation });
            }
        }
    }
    return results;
}

/**
 * Returns graph statistics
 * @returns {Promise<{
 *   totalEdges: number,
 *   byLayer: {soul: number, core: number, cortex: number},
 *   byRelation: {causes: number, enables: number, prevents: number, correlates: number},
 *   avgStrength: number,
 *   avgConfidence: number
 * }>}
 */
export async function getGraphStats() {
    if (edges.length === 0 && nodes.size === 0) {
        await initGraph();
    }
    const byLayer = { soul: 0, core: 0, cortex: 0 };
    const byRelation = { causes: 0, enables: 0, prevents: 0, correlates: 0 };
    let totalStrength = 0;
    let totalConfidence = 0;
    for (const edge of edges) {
        byLayer[edge.layer] = (byLayer[edge.layer] || 0) + 1;
        byRelation[edge.relation] = (byRelation[edge.relation] || 0) + 1;
        const stats = getEdgeStats(edge);
        totalStrength += stats.strength;
        totalConfidence += stats.confidence;
    }
    const totalEdges = edges.length;
    const behavioral = edges.filter(e => e.type === 'behavioral').length;
    return {
        totalEdges,
        behavioral,
        byLayer,
        byRelation,
        avgStrength: totalEdges > 0 ? totalStrength / totalEdges : 0,
        avgConfidence: totalEdges > 0 ? totalConfidence / totalEdges : 0
    };
}

// --- Behavioral Edges — pattern-based causality ---

const CAUSAL_PATTERNS = [
    {
        regex: /(.{5,}?)\s*->\s*(.{5,})/,
        marker: '->',
        extract: (m) => ({ cause: m[1].trim(), effect: m[2].trim() })
    },
    {
        regex: /(.{5,}?)\s+because\s+(.{5,})/i,
        marker: 'because',
        extract: (m) => ({ cause: m[2].trim(), effect: m[1].trim() })
    },
    {
        regex: /(.{5,}?)\s+due to\s+(.{5,})/i,
        marker: 'due to',
        extract: (m) => ({ cause: m[2].trim(), effect: m[1].trim() })
    },
    {
        regex: /(.{5,}?)\s+led to\s+(.{5,})/i,
        marker: 'led to',
        extract: (m) => ({ cause: m[1].trim(), effect: m[2].trim() })
    },
    {
        regex: /(.{5,}?)\s+(?:as a\s+)?consequence\s+(.{5,})/i,
        marker: 'consequence',
        extract: (m) => ({ cause: m[2].trim(), effect: m[1].trim() })
    },
    {
        regex: /decided\s+(.{5,}?)\s+(?:because|due to|since)\s+(.{5,})/i,
        marker: 'decided',
        extract: (m) => ({ cause: m[2].trim(), effect: m[1].trim() })
    },
    {
        regex: /(.{5,}?)\s+therefore\s+(.{5,})/i,
        marker: 'therefore',
        extract: (m) => ({ cause: m[1].trim(), effect: m[2].trim() })
    },
    {
        regex: /(.{5,}?)\s+resulted in\s+(.{5,})/i,
        marker: 'resulted in',
        extract: (m) => ({ cause: m[1].trim(), effect: m[2].trim() })
    },
    {
        regex: /(.{5,}?)\s+caused by\s+(.{5,})/i,
        marker: 'caused by',
        extract: (m) => ({ cause: m[2].trim(), effect: m[1].trim() })
    }
];

/**
 * Extracts causal relations from record text.
 * @param {string} text — full record text
 * @returns {Array<{cause: string, effect: string, marker: string}>}
 */
export function extractCausalPatterns(text) {
    if (!text || typeof text !== 'string' || text.length < 15) return [];

    const results = [];
    const seen = new Set();

    for (const pattern of CAUSAL_PATTERNS) {
        const match = text.match(pattern.regex);
        if (!match) continue;

        const { cause, effect } = pattern.extract(match);
        if (cause.length < 5 || effect.length < 5) continue;
        if (cause.length > 200 || effect.length > 200) continue;

        const key = `${cause.slice(0, 50)}|${effect.slice(0, 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({ cause, effect, marker: pattern.marker });
    }

    return results;
}

/**
 * Creates a behavioral edge from an extracted pattern.
 * @param {{cause: string, effect: string, marker: string}} extraction
 * @param {string} recordId — source record ID
 * @returns {Object} — edge for causal-graph.json
 */
export function createBehavioralEdge(extraction, recordId) {
    return {
        id: generateRelationId(),
        sourceId: recordId || null,
        targetId: null,
        sourceText: extraction.cause.slice(0, 120),
        targetText: extraction.effect.slice(0, 120),
        relation: 'causes',
        type: 'behavioral',
        evidence: extraction.marker,
        confidence: 1.0,
        layer: 'core',
        rung: 1,
        alpha: 2,
        beta: 1,
        validFrom: new Date().toISOString(),
        validTo: null,
        supersededBy: null,
        sourceRecordId: recordId,
        createdAt: new Date().toISOString()
    };
}

/**
 * Scans an array of records and extracts behavioral edges.
 * @param {Array<{id: string, text: string}>} records
 * @returns {Array<Object>} — array of behavioral edges
 */
export function scanForBehavioralEdges(records) {
    if (!Array.isArray(records)) return [];

    const allEdges = [];
    for (const record of records) {
        const text = record.text || record.content || '';
        const id = record.id || record._id || '';

        const extractions = extractCausalPatterns(text);
        for (const ext of extractions) {
            allEdges.push(createBehavioralEdge(ext, id));
        }
    }

    console.log(`[causal:behavioral] Scanned ${records.length} records -> ${allEdges.length} behavioral edges`);
    return allEdges;
}

/**
 * Merges behavioral edges into causal-graph.json with deduplication.
 * @param {Array<Object>} newEdges — from scanForBehavioralEdges()
 * @returns {Promise<number>} — number of newly added edges
 */
export async function mergeBehavioralEdges(newEdges) {
    if (!newEdges || newEdges.length === 0) return 0;

    if (!initialized) await initGraph();

    const existing = new Set();
    for (const e of edges) {
        if (e.type === 'behavioral') {
            existing.add(`${(e.sourceText || '').slice(0, 50)}|${(e.targetText || '').slice(0, 50)}`);
        }
    }

    let added = 0;
    for (const edge of newEdges) {
        const key = `${(edge.sourceText || '').slice(0, 50)}|${(edge.targetText || '').slice(0, 50)}`;
        if (existing.has(key)) continue;

        edges.push(edge);
        existing.add(key);
        added++;
    }

    if (added > 0) {
        rebuildNodes();
        await saveGraph();
        console.log(`[causal:behavioral] Merged ${added} new behavioral edges (total: ${edges.length})`);
    }

    return added;
}
