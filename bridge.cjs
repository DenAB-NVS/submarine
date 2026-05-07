/**
 * CJS bridge for submarine-plugin.
 * Provides a unified interface to the RAG module from CommonJS environments.
 *
 * @module submarine/bridge
 * @author D. Ashford
 * @version 1.0.0
 * @license AGPL-3.0
 */

'use strict';

let _ragPromise = null;

/**
 * Lazily loads the ES module rag.mjs.
 * @returns {Promise<object|null>}
 */
function getRag() {
  if (!_ragPromise) {
    _ragPromise = import('./core/rag.mjs').catch(err => {
      console.warn('[submarine-bridge] ESM import failed:', err.message);
      return null;
    });
  }
  return _ragPromise;
}

/**
 * Gets RAG context for a query.
 * @param {string} query - Search query
 * @returns {Promise<object|null>}
 */
module.exports.getRAGContext = async function getRAGContext(query) {
  try {
    const mod = await Promise.race([
      getRag(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
    ]);
    if (!mod || !mod.getRAGContext) return null;
    return await mod.getRAGContext(query, {
      useDeep: true
    });
  } catch (err) {
    console.warn('[submarine-bridge] Error:', err.message);
    return null;
  }
};
