/**
 * submarine: HTTP REST API for Dynamic Memory
 *
 * Endpoints:
 *   POST /api/v1/memory
 *   GET  /api/v1/memory/search
 *   DELETE /api/v1/memory?id=<id>
 *   GET  /api/v1/stats
 *   POST /api/v1/causal/add
 *
 * Authorization: X-API-Key header (if SUBMARINE_API_KEY is set)
 * CORS: all origins allowed for development
 *
 * @module server
 * @author D. Ashford
 */

import http from 'http';
import { URL } from 'url';
import { getOllamaUrl, getServerPort, getConfig, getWorkspacePath } from './config.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    Cortex,
    Core,
    Soul,
    unifiedSearch,
    deepSearch,
    getLayerStats
} from './layers.mjs';
import { getDb } from '../semantic-memory/memory-engine.mjs';
import { parseSource } from './utils.mjs';
import * as synapse from './synapse.mjs';
import { getManifest } from './manifest.mjs';
import { generateCrystal } from '../core/crystal.mjs';

// Cluster filter (optional)

let clusterFilter = null;
try {
    const cluster = await import('./cluster.mjs');

    clusterFilter = cluster.clusterFilter;
} catch (e) { /* cluster not available */ }

// Causal graph (optional)
let causalModule = null;
try {
    causalModule = await import('./causal.mjs');
    await causalModule.initGraph();
} catch (e) { /* causal not available */ }

// Forgetting mechanism (optional)
let forgettingModule = null;
try {
    forgettingModule = await import('./forgetting.mjs');
} catch (e) { /* forgetting not available */ }

// Immune system (optional)
let immuneFn = null;
try {
    const mod = await import('./immune.mjs');
    immuneFn = mod.immune || mod.default;
} catch (e) { /* immune not available */ }

/**
 * Parses a JSON body from an incoming request
 * @param {http.IncomingMessage} req
 * @returns {Promise<Object|null>}
 */
async function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > 1e6) { // 1MB limit
                req.destroy();
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (err) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Sends a JSON response
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {any} data
 */
function sendJson(res, statusCode, data) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(statusCode);
    res.end(JSON.stringify(data, null, 2));
}

/**
 * Sends an error response
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {string} message
 * @param {string} [code]
 */
function sendError(res, statusCode, message, code) {
    sendJson(res, statusCode, {
        error: {
            code: code || `HTTP_${statusCode}`,
            message
        }
    });
}

/**
 * Checks authorization
 * @param {http.IncomingMessage} req
 * @param {string} requiredApiKey (if empty string — authorization is disabled)
 * @returns {boolean}
 */
function checkAuth(req, requiredApiKey) {
    if (!requiredApiKey) return true;
    const apiKey = req.headers['x-api-key'];
    return apiKey === requiredApiKey;
}

/**
 * CORS handler
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {boolean} true if the request was handled as preflight
 */
function handleCors(req, res) {
    // Allow any origin for development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return true;
    }
    return false;
}

/**
 * Creates an HTTP server
 * @param {number} port port (default from config)
 * @param {string} apiKey secret key (if empty string — authorization is disabled)
 * @returns {{server: http.Server, start: () => void, stop: () => void}}
 */
export function createServer(port = getServerPort(), apiKey = '') {
    const server = http.createServer(async (req, res) => {
        // CORS
        if (handleCors(req, res)) return;

        // Authorization
        if (!checkAuth(req, apiKey)) {
            return sendError(res, 401, 'Invalid or missing X-API-Key header');
        }

        const parsedUrl = new URL(req.url || '', `http://${req.headers.host}`);
        const pathname = parsedUrl.pathname;

        try {
            // Routing
            if (pathname === '/api/v1/memory' && req.method === 'POST') {
                await handleAddMemory(req, res);
            } else if (pathname === '/api/v1/memory/search' && req.method === 'GET') {
                await handleSearch(req, res, parsedUrl);
            } else if (pathname === '/api/v1/stats' && req.method === 'GET') {
                await handleStats(req, res);
            } else if (pathname === '/api/v1/health' && req.method === 'GET') {
                await handleHealth(req, res);
            } else if (pathname === '/api/v1/causal/add' && req.method === 'POST') {
                await handleCausalAdd(req, res);
            } else if (pathname === '/api/v1/causal/stats' && req.method === 'GET') {
                await handleCausalStats(req, res);
            } else if (pathname === '/api/v1/memory/supersede' && req.method === 'POST') {
                await handleSupersede(req, res);
            } else if (pathname === '/api/v1/memory/archive' && req.method === 'POST') {
                await handleArchive(req, res);
            } else if (pathname === '/api/v1/memory/archive' && req.method === 'GET') {
                await handleArchiveScan(req, res, parsedUrl);
            } else if (pathname === '/api/v1/threads' && req.method === 'GET') {
                await handleThreads(req, res, parsedUrl);
            } else if (pathname === '/api/v1/synapse/extract' && req.method === 'POST') {
                await handleSynapseExtract(req, res);
            } else if (pathname === '/api/v1/synapse/weave' && req.method === 'POST') {
                await handleSynapseWeave(req, res);
            } else if (pathname === '/api/v1/synapse/resolve' && req.method === 'POST') {
                await handleSynapseResolve(req, res);
            } else if (pathname === '/api/v1/synapse/archive-stale' && req.method === 'POST') {
                await handleSynapseArchiveStale(req, res);
            } else if (pathname === '/api/v1/synapse/active' && req.method === 'GET') {
                await handleSynapseActive(req, res);
            } else if (pathname === '/api/v1/memory' && req.method === 'DELETE') {
                await handleDeleteMemory(req, res, parsedUrl);
            } else if (pathname === '/api/v1/crystal' && req.method === 'GET') {
                try {
                    await generateCrystal();
                    const cfg = getConfig();
                    const crystalPath = join(getWorkspacePath(), cfg.adapterConfig?.crystalOutputPath || 'CONTEXT-CRYSTAL.md');
                    const content = readFileSync(crystalPath, 'utf-8');
                    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
                    res.end(content);
                } catch (err) {
                    console.error('[crystal] generation failed:', err);
                    sendError(res, 500, 'Crystal generation failed: ' + err.message);
                }
            } else if (pathname === '/api/v1/manifest' && req.method === 'GET') {
                const manifest = getManifest();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(manifest, null, 2));
            } else {
                sendError(res, 404, 'Endpoint not found');
            }
        } catch (err) {
            console.error(`Error processing ${req.method} ${req.url}:`, err);
            sendError(res, 500, 'Internal server error');
        }
    });

    return {
        server,
        start() {
            server.listen(port, '127.0.0.1', () => {
                console.log(`submarine API started on 127.0.0.1:${port}`);
                console.log(`Authorization: ${apiKey ? 'enabled' : 'disabled'}`);
            });
        },
        stop() {
            server.close();
        }
    };
}

// ============================================================
// Endpoint handlers
// ============================================================

/**
 * POST /api/v1/memory
 */
async function handleAddMemory(req, res) {
    let body;
    try {
        body = await parseJsonBody(req);
    } catch (err) {
        return sendError(res, 400, 'Invalid JSON body');
    }

    let { layer, text, metadata, category, importance } = body;

    // Validation
    if (!layer || !text) {
        return sendError(res, 400, 'Missing required fields: layer, text');
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
        return sendError(res, 400, 'Text must be a non-empty string');
    }
    if (!['cortex', 'core', 'soul'].includes(layer)) {
        return sendError(res, 400, 'Layer must be one of: cortex, core, soul');
    }

    try {
        let result;
        switch (layer) {
            case 'cortex':
                result = await Cortex.add(text, metadata || {});
                break;
            case 'core':
                // immune check for Core records
                if (immuneFn) {
                    try {
                        const check = await immuneFn(text, 'core');
                        if (!check.allowed) {
                            console.log(`[server] Immune blocked Core write: ${check.reason}, routing to ${check.layer}`);
                            result = await Cortex.add(text, metadata || {});
                            layer = 'cortex';
                            break;
                        }
                    } catch (e) { /* immune is non-critical */ }
                }
                result = await Core.add(
                    text,
                    category || 'fact',
                    importance || 5
                );
                break;
            case 'soul':
                // Immune system: check before writing to Soul
                if (immuneFn) {
                    try {
                        const check = await immuneFn(text, 'soul');
                        if (!check.allowed) {
                            console.log(`[server] Immune blocked Soul write: ${check.reason}, routing to ${check.layer}`);
                            if (check.layer === 'core') {
                                result = await Core.add(text, category || 'fact', importance || 5);
                                layer = 'core';
                            } else {
                                result = await Cortex.add(text, metadata || {});
                                layer = 'cortex';
                            }
                            break;
                        }
                    } catch (e) {
                        // Immune system is non-critical — on error, write as intended
                    }
                }
                result = await Soul.add(text);
                break;
        }

        sendJson(res, 201, {
            success: true,
            layer,
            id: result.id || null,
            text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
            timestamp: new Date().toISOString()
        });

        // Fire-and-forget: extract threads from the written text
        const sessionLabel = new Date().toISOString().slice(0, 10);
        synapse.extract(text, sessionLabel).catch(e =>
            console.warn('[server] synapse.extract fire-and-forget error:', e.message)
        );
    } catch (err) {
        console.error('Error adding memory:', err);
        sendError(res, 500, 'Failed to add memory');
    }
}

/**
 * GET /api/v1/memory/search
 * Query params:
 *   q       - search query (required)
 *   limit   - max results (default 5, max 50)
 *   layer   - 'all'|'cortex'|'core'|'soul' (default 'all')
 *   mode    - 'simple'|'deep' (default 'deep' for layer=all)
 *   # cluster filter applied automatically when available
 *   causal  - 'true'|'false' (include causal links, default 'true')
 */
async function handleSearch(req, res, parsedUrl) {
    const query = parsedUrl.searchParams.get('q');
    const limit = Math.min(Number(parsedUrl.searchParams.get('limit')) || 5, 50);
    const layer = parsedUrl.searchParams.get('layer') || 'all';
    let mode = parsedUrl.searchParams.get('mode') || (layer === 'all' ? 'deep' : 'simple'); if (mode === 'deep') mode = 'deep';
    const useCluster = parsedUrl.searchParams.get('cluster') === 'true';
    const useCausal = parsedUrl.searchParams.get('causal') !== 'false';
    const skipRerank = parsedUrl.searchParams.get('rerank') !== 'true';

    if (!query) {
        return sendError(res, 400, 'Missing query parameter: q');
    }

    try {
        let results;
        let meta = null;
        const searchOpts = skipRerank ? { skipRerank: true } : {};

        const t0 = Date.now();
        // Step 1: Search
        if (mode === 'deep' && layer === 'all') {
            // Deep search: Soul -> Core (enriched) -> Coupling -> Cortex
            const fp = await deepSearch(query, { totalLimit: limit, ...searchOpts });
            results = fp.results;
            meta = fp.meta;
        } else {
            switch (layer) {
                case 'cortex':
                    results = await Cortex.search(query, limit, searchOpts);
                    break;
                case 'core':
                    results = await Core.search(query, limit, searchOpts);
                    break;
                case 'soul':
                    results = await Soul.search(query, limit, searchOpts);
                    break;
                case 'all':
                    results = await unifiedSearch(query, limit, searchOpts);
                    break;
                default:
                    return sendError(res, 400, 'Layer must be one of: all, cortex, core, soul');
            }
        }
        const searchMs = Date.now()-t0;
        if (searchMs > 10000) console.warn(`[search] SLOW: ${searchMs}ms q="${query}" layer=${layer} mode=${mode}`);

        // Step 2: Cluster density filter
        if (useCluster && clusterFilter && results.length > 1) {
            try {
                results = await clusterFilter(results, { minClusterIndex: 0.03 });
            } catch (e) {
                // Filter non-critical, continue without it
            }
        }

        // Step 3: Causal enrichment (add causes/effects)
        let causalLinks = null;
        if (useCausal && causalModule && results.length > 0) {
            try {
                causalLinks = [];
                for (const r of results.slice(0, 5)) {
                    const memId = r.id || (r.source && r.source.match(/id:([^\s|]+)/)?.[1]);
                    if (!memId) continue;
                    const causes = await causalModule.getCauses(memId, 1);
                    const effects = await causalModule.getEffects(memId, 1);
                    if (causes.length > 0 || effects.length > 0) {
                        causalLinks.push({
                            memoryId: memId,
                            causes: causes.map(c => ({
                                text: c.edge.sourceText?.substring(0, 100),
                                relation: c.edge.relation,
                                strength: causalModule.getEdgeStats(c.edge).strength
                            })),
                            effects: effects.map(e => ({
                                text: e.edge.targetText?.substring(0, 100),
                                relation: e.edge.relation,
                                strength: causalModule.getEdgeStats(e.edge).strength
                            }))
                        });
                    }
                }
                if (causalLinks.length === 0) causalLinks = null;
            } catch (e) {
                // Causal enrichment non-critical
                causalLinks = null;
            }
        }

        const response = {
            success: true,
            query,
            limit,
            layer,
            mode,
            count: results.length,
            results
        };
        if (meta) response.meta = meta;
        if (causalLinks) response.causalLinks = causalLinks;

        sendJson(res, 200, response);
    } catch (err) {
        console.error(`[search] ERROR after ${Date.now()-t0}ms:`, err);
        sendError(res, 500, 'Failed to search memories');
    }
}

/**
 * GET /api/v1/stats
 */
async function handleStats(req, res) {
    try {
        const stats = await getLayerStats();
        sendJson(res, 200, {
            success: true,
            stats,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error getting stats:', err);
        sendError(res, 500, 'Failed to get stats');
    }
}

/**
 * GET /api/v1/health — liveness check
 */
async function handleHealth(req, res) {
    const health = { status: 'ok', checks: {} };
    let allOk = true;

    // 1. Ollama ping
    try {
        const resp = await fetch(`${getOllamaUrl()}/api/tags`, {
            signal: AbortSignal.timeout(3000)
        });
        health.checks.ollama = resp.ok ? 'ok' : 'error: HTTP ' + resp.status;
        if (!resp.ok) allOk = false;
    } catch (e) {
        health.checks.ollama = 'error: ' + e.message;
        allOk = false;
    }

    // 2. LanceDB read + liveness (real countRows with timeout)
    try {
        const db = await getDb();
        const tables = await db.tableNames();
        const tbl = await db.openTable('memories');
        const count = await Promise.race([
            tbl.countRows(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 5s')), 5000))
        ]);
        health.checks.lancedb = { status: 'ok', tables: tables.length, rows: count };
    } catch (e) {
        health.checks.lancedb = { status: 'error', message: e.message };
        allOk = false;
    }

    // 3. Layer stats
    try {
        const stats = await getLayerStats();
        health.checks.layers = {
            soul: stats.soul.count,
            core: stats.core.count,
            cortex: stats.cortex.count,
            total: stats.total.count
        };
    } catch (e) {
        health.checks.layers = 'error: ' + e.message;
        allOk = false;
    }

    // 4. Module status
    health.checks.modules = {
        clusterFilter: clusterFilter ? 'loaded' : 'not available',
        immune: immuneFn ? 'loaded' : 'not available',
        causalGraph: causalModule ? 'loaded' : 'not available',
        forgetting: forgettingModule ? 'loaded' : 'not available',
        deepSearch: 'loaded'
    };

    health.status = allOk ? 'ok' : 'degraded';
    health.timestamp = new Date().toISOString();
    sendJson(res, allOk ? 200 : 503, health);
}

/**
 * GET /api/v1/causal/stats — causal graph statistics
 */
async function handleCausalStats(req, res) {
    if (!causalModule) {
        return sendJson(res, 200, {
            success: true,
            available: false,
            message: 'Causal module not loaded'
        });
    }
    try {
        const stats = await causalModule.getGraphStats();
        sendJson(res, 200, {
            success: true,
            available: true,
            stats,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error getting causal stats:', err);
        sendError(res, 500, 'Failed to get causal stats');
    }
}

/**
 * POST /api/v1/causal/add — add a causal relation
 * Body: { sourceText, targetText, type: 'causes'|'enables'|'prevents'|'correlates', strength?, confidence? }
 */
async function handleCausalAdd(req, res) {
    if (!causalModule) {
        return sendError(res, 503, 'Causal module not available');
    }

    let body;
    try {
        body = await parseJsonBody(req);
    } catch (err) {
        return sendError(res, 400, 'Invalid JSON body');
    }

    const { sourceText, targetText, type, sourceId: bodySourceId, targetId: bodyTargetId } = body;
    if (!sourceText || !targetText || !type) {
        return sendError(res, 400, 'Missing required fields: sourceText, targetText, type');
    }
    if (!['causes', 'enables', 'prevents', 'correlates', 'supersedes'].includes(type)) {
        return sendError(res, 400, 'type must be one of: causes, enables, prevents, correlates, supersedes');
    }

    try {
        // use real IDs if provided, otherwise search by text
        let sourceId = bodySourceId || null;
        let targetId = bodyTargetId || null;

        if (!sourceId || !targetId) {
            try {
                const results = await searchMemories(sourceText.substring(0, 150), 5, 0.3);
                if (!sourceId) {
                    const srcMatch = results.find(r => r.text?.includes(sourceText.substring(0, 50)));
                    if (srcMatch) {
                        const meta = typeof srcMatch.source === 'string' ? JSON.parse(srcMatch.source) : {};
                        sourceId = meta.id || null;
                    }
                }
            } catch { /* search is non-critical */ }
            try {
                const results = await searchMemories(targetText.substring(0, 150), 5, 0.3);
                if (!targetId) {
                    const tgtMatch = results.find(r => r.text?.includes(targetText.substring(0, 50)));
                    if (tgtMatch) {
                        const meta = typeof tgtMatch.source === 'string' ? JSON.parse(tgtMatch.source) : {};
                        targetId = meta.id || null;
                    }
                }
            } catch { /* search is non-critical */ }
        }

        // If IDs not found after search — reject (do not create phantom)
        if (!sourceId || !targetId) {
            return sendError(res, 400, 'Could not resolve record IDs. Provide sourceId/targetId explicitly or ensure records exist.');
        }

        const result = await causalModule.addRelation(
            sourceId, sourceText,
            targetId, targetText,
            type, 'core', 1
        );
        sendJson(res, 201, {
            success: true,
            ...result,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('[server] Error adding causal relation:', err);
        sendError(res, 500, 'Failed to add causal relation');
    }
}

/**
 * POST /api/v1/memory/supersede
 * Body: { oldId: string, newId: string, reason?: string }
 */
async function handleSupersede(req, res) {
    if (!forgettingModule) {
        return sendError(res, 503, 'Forgetting module not available');
    }

    let body;
    try {
        body = await parseJsonBody(req);
    } catch (err) {
        return sendError(res, 400, 'Invalid JSON body');
    }

    const { oldId, newId, reason } = body;
    if (!oldId || !newId) {
        return sendError(res, 400, 'Missing required fields: oldId, newId');
    }

    try {
        const result = await forgettingModule.supersede(oldId, newId, reason || '');
        if (result.success) {
            sendJson(res, 200, { success: true, ...result, timestamp: new Date().toISOString() });
        } else {
            sendError(res, 400, result.error || 'Supersede failed');
        }
    } catch (err) {
        console.error('Error in supersede:', err);
        sendError(res, 500, 'Failed to supersede memory');
    }
}

/**
 * POST /api/v1/memory/archive — apply archival
 * Body: { apply?: boolean } (default: dry-run)
 */
async function handleArchive(req, res) {
    if (!forgettingModule) {
        return sendError(res, 503, 'Forgetting module not available');
    }

    let body;
    try {
        body = await parseJsonBody(req);
    } catch (err) {
        return sendError(res, 400, 'Invalid JSON body');
    }

    const apply = body.apply === true;

    try {
        const result = await forgettingModule.archiveScan({ apply });
        sendJson(res, 200, {
            success: true,
            dryRun: !apply,
            ...result,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error in archive:', err);
        sendError(res, 500, 'Failed to archive memories');
    }
}

/**
 * GET /api/v1/memory/archive — scan archival candidates (dry-run)
 */
async function handleArchiveScan(req, res, parsedUrl) {
    if (!forgettingModule) {
        return sendError(res, 503, 'Forgetting module not available');
    }

    try {
        const result = await forgettingModule.archiveScan({ apply: false });
        sendJson(res, 200, {
            success: true,
            dryRun: true,
            ...result,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error in archive scan:', err);
        sendError(res, 500, 'Failed to scan archive candidates');
    }
}

/**
 * DELETE /api/v1/memory?id=<id> — soft delete (active=false)
 */
async function handleDeleteMemory(req, res, parsedUrl) {
    const id = parsedUrl.searchParams.get('id');
    if (!id) {
        return sendError(res, 400, 'Missing query parameter: id');
    }

    try {
        const { findById } = await import('./layers.mjs');
        const row = await findById(id);
        if (!row) {
            return sendError(res, 404, `Memory with id=${id} not found`);
        }

        const db = await getDb();
        const table = await db.openTable('memories');

        // Soft delete: mark active=false (like forgetting)
        const meta = parseSource(row.source);
        meta.forgotten = true;
        meta.forgottenAt = new Date().toISOString();

        const escapedSource = JSON.stringify(meta).replace(/'/g, "''");
        await table.update(
            { active: "'false'", source: `'${escapedSource}'` },
            { where: `timestamp = '${row.timestamp}'` }
        );

        const textPreview = (row.text || '').substring(0, 80);
        console.log(`[server] Memory soft-deleted: ${id} — "${textPreview}"`);
        sendJson(res, 200, {
            success: true,
            id,
            text_preview: textPreview
        });
    } catch (err) {
        console.error('[server] Error deleting memory:', err);
        sendError(res, 500, 'Failed to delete memory');
    }
}

// --- Threads / Synapse handlers ---

/**
 * GET /api/v1/threads?status=open|resolved|archived|all
 */
async function handleThreads(req, res, parsedUrl) {
    const status = parsedUrl.searchParams.get('status') || 'all';
    if (!['open', 'resolved', 'archived', 'all'].includes(status)) {
        return sendError(res, 400, 'status must be one of: open, resolved, archived, all');
    }
    const threads = await synapse.getThreads(status);
    sendJson(res, 200, { threads, count: threads.length });
}

async function handleSynapseExtract(req, res) {
    const body = await parseJsonBody(req);
    if (!body.text) return sendError(res, 400, 'text is required');
    const result = await synapse.extract(body.text, body.sessionLabel);
    sendJson(res, 200, result);
}

async function handleSynapseWeave(req, res) {
    const body = await parseJsonBody(req);
    if (!body.query) return sendError(res, 400, 'query is required');
    const result = await synapse.weave(body.query, body.limit || 5);
    sendJson(res, 200, { threads: result });
}

async function handleSynapseResolve(req, res) {
    const body = await parseJsonBody(req);
    if (!body.threadId) return sendError(res, 400, 'threadId is required');
    const result = await synapse.resolve(body.threadId, body.resolution);
    sendJson(res, 200, result);
}

async function handleSynapseArchiveStale(req, res) {
    const result = await synapse.archiveStale();
    sendJson(res, 200, result);
}

async function handleSynapseActive(req, res) {
    const threads = await synapse.getActive();
    sendJson(res, 200, { threads, count: threads.length });
}
