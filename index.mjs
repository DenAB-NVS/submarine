#!/usr/bin/env node

/**
 * submarine: Dynamic Memory API entry point
 *
 * Loads .env configuration, starts the server, checks dependencies,
 * displays startup information and provides graceful shutdown.
 *
 * @module index
 * @author D. Ashford
 */

import { readFileSync, existsSync } from 'fs';
import { createServer } from './src/server.mjs';
import { getLayerStats } from './src/layers.mjs';
import { getServerPort, getOllamaUrl, getOllamaModel } from './src/config.mjs';
import { startController, stopController } from './core/crystal-update-controller.mjs';

/**
 * Parses .env file (if it exists)
 * @returns {Object} object with key-value pairs
 */
function loadEnv() {
    const envPath = './.env';
    if (!existsSync(envPath)) {
        console.log('⚠  .env file not found, using default values');
        return {};
    }

    const env = {};
    try {
        const content = readFileSync(envPath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            // Skip empty lines and comments
            if (!trimmed || trimmed.startsWith('#')) continue;
            const equalsIndex = trimmed.indexOf('=');
            if (equalsIndex === -1) continue;
            const key = trimmed.substring(0, equalsIndex).trim();
            const value = trimmed.substring(equalsIndex + 1).trim();
            // Remove quotes if present
            env[key] = value.replace(/^['"]|['"]$/g, '');
        }
        console.log(`✅ Loaded ${Object.keys(env).length} variables from .env`);
    } catch (err) {
        console.error('❌ Error reading .env:', err.message);
    }
    return env;
}

/**
 * Checks Ollama availability (ping)
 * @returns {Promise<{ok: boolean, message: string, model?: string}>}
 */
async function checkOllama() {
    const ollamaUrl = getOllamaUrl();
    const modelName = getOllamaModel();
    try {
        const response = await fetch(`${ollamaUrl}/api/tags`, {
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) {
            return { ok: false, message: `HTTP ${response.status}` };
        }
        const data = await response.json();
        const models = data.models || [];
        const embedModel = models.find(m => m.name.includes(modelName)) || models.find(m => m.name.includes('nomic-embed-text'));
        return {
            ok: true,
            message: 'Ollama available',
            model: embedModel ? embedModel.name : `${modelName} not found`
        };
    } catch (err) {
        return { ok: false, message: err.message };
    }
}

/**
 * Displays startup information
 */
async function printStartupInfo(port, apiKeyEnabled, ollamaStatus, stats) {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 SUBMARINE — Dynamic Memory API');
    console.log('='.repeat(60));
    console.log(`📍 Port: ${port}`);
    console.log(`🔐 Authorization: ${apiKeyEnabled ? 'ENABLED (X-API-Key)' : 'DISABLED'}`);
    console.log(`🤖 Ollama: ${ollamaStatus.ok ? '✅ ' : '❌ '}${ollamaStatus.message}`);
    if (ollamaStatus.model) console.log(`   Embedding model: ${ollamaStatus.model}`);
    console.log('\n📊 Memory statistics:');
    console.log(`   Cortex (episodes): ${stats.cortex.count}`);
    console.log(`   Core (facts): ${stats.core.count}`);
    console.log(`   Soul (identity): ${stats.soul.count}`);
    console.log(`   Total records: ${stats.total.count}`);
    console.log('\n🔗 Endpoints:');
    console.log('   POST /api/v1/memory');
    console.log('   GET  /api/v1/memory/search?q=...&layer=all|cortex|core|soul');
    console.log('   GET  /api/v1/stats');
    console.log('='.repeat(60));
    console.log('📝 Logging: Ctrl+C to stop\n');
}

/**
 * Main function
 */
async function main() {
    // Load configuration
    const env = loadEnv();
    const port = Number(env.SUBMARINE_PORT) || getServerPort();
    const apiKey = env.SUBMARINE_API_KEY || '';

    // Check Ollama
    console.log('🔍 Checking Ollama...');
    const ollamaStatus = await checkOllama();
    if (!ollamaStatus.ok) {
        console.warn('⚠  Warning: Ollama is unavailable. Embeddings will not work.');
        console.warn('   Start Ollama and the bge-m3 model');
    }

    // Memory statistics
    let stats;
    try {
        stats = await getLayerStats();
    } catch (err) {
        console.error('❌ Failed to get memory statistics:', err.message);
        stats = {
            cortex: { count: 'error' },
            core: { count: 'error' },
            soul: { count: 'error' },
            total: { count: 'error' }
        };
    }

    // Start server
    const { server, start, stop } = createServer(port, apiKey);
    start();

    // Warmup: warm up LanceDB vector index + Ollama embedding
    // LanceDB ARM64 native binding: first vector search can take ~50s.
    // Warmup BEFORE accepting HTTP requests prevents hanging.
    try {
        const { getDb } = await import('../semantic-memory/memory-engine.mjs');
        const warmStart = Date.now();
        const db = await getDb();
        const table = await db.openTable('memories');
        const dummyVec = Array(1024).fill(0.01);
        const warmResults = await table.search(dummyVec).limit(1).toArray();
        console.log(`🔥 Warmup: LanceDB vector search ${Date.now() - warmStart}ms (${warmResults.length} results)`);
    } catch (e) {
        console.warn(`⚠  Warmup failed: ${e.message}`);
    }

    // Crystal update controller
    startController();

    // Graceful shutdown
    const signals = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
        process.on(signal, () => {
            console.log(`\n${signal} received, stopping server...`);
            stopController();
            server.close(() => {
                console.log('✅ Server stopped');
                process.exit(0);
            });
            // Force exit after 5 seconds
            setTimeout(() => {
                console.warn('⚠  Forced exit');
                process.exit(1);
            }, 5000);
        });
    }

    // Display startup information
    printStartupInfo(port, !!apiKey, ollamaStatus, stats);
}

// Run
main().catch(err => {
    console.error('❌ Critical error during startup:', err);
    process.exit(1);
});
