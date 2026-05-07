/**
 * Utilities for submarine
 * @module utils
 */

import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __utils_dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = join(__utils_dirname, '..', 'data', '.write.lock');

// Ensure data directory exists
try { mkdirSync(join(__utils_dirname, '..', 'data'), { recursive: true }); } catch (e) {}

/**
 * Simple file mutex to protect against concurrent writes to LanceDB
 * @param {Function} fn — async function to execute under lock
 * @param {number} timeoutMs — maximum wait time (default 5000ms)
 * @returns {Promise<any>} result of fn()
 */
export async function withWriteLock(fn, timeoutMs = 5000) {
    const start = Date.now();
    // Wait until lock is released
    while (existsSync(LOCK_FILE)) {
        if (Date.now() - start > timeoutMs) {
            // Stale lock — forcibly remove
            try { unlinkSync(LOCK_FILE); } catch (e) {}
            break;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    // Acquire lock
    try {
        writeFileSync(LOCK_FILE, String(process.pid) + ':' + Date.now());
    } catch (e) {}
    try {
        return await fn();
    } finally {
        // Release lock
        try { unlinkSync(LOCK_FILE); } catch (e) {}
    }
}

/**
 * Generates a random four-character alphanumeric identifier
 * @returns {string} 4 random characters (a-z0-9)
 */
function random4chars() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Generates a unique identifier in format sub_<timestamp36>_<random4>
 * Example: 'sub_m1abc23_x7kq'
 * @returns {string} unique ID
 */
export function generateId() {
    const timestamp36 = Date.now().toString(36);
    return `sub_${timestamp36}_${random4chars()}`;
}

/**
 * Helper function for parsing the source field to find the id
 * @param {string} sourceStr JSON string from the source field
 * @returns {{id?: string, origin?: string, [key: string]: any}} metadata object
 */
export function parseSource(sourceStr) {
    if (!sourceStr || typeof sourceStr !== 'string') {
        return {};
    }
    try {
        if (sourceStr.startsWith('{')) {
            return JSON.parse(sourceStr);
        }
    } catch (err) {
        // ignore parse errors
    }
    return {};
}
