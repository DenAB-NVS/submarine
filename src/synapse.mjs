/**
 * Synapse — synaptic bridge between sessions and topics.
 *
 * Tracks unfinished thoughts (threads) from different contact points.
 * Links disparate sessions through semantic similarity.
 *
 * No LLM — purely patterns + embeddings + LanceDB.
 *
 * @module submarine/synapse
 * @author D. Ashford
 */

import { getDb, getEmbedding } from '../semantic-memory/memory-engine.mjs';
import { markCrystalDirty } from '../core/crystal-update-controller.mjs';

const EMBED_DIM = 1024;
const STALE_DAYS = 14;

// --- Patterns for thread extraction ---

/** Question patterns — open threads */
const QUESTION_RE = /([^.!?\n]*\?)/g;

/** Task patterns */
const TASK_KEYWORDS = /(?:need to|task|do|TODO|todo|next step|must|necessary|planning to|want to do)\s+(.{10,120})/gi;

/** Past action patterns (completed actions) — do not create threads */
const PAST_ACTION_RE = /(?:clicked|pressed|installed|deleted|restarted|created|copied|moved|closed|opened|started|stopped)\b/i;

/** Pattern for already completed TODO: [x] nearby */
const TODO_DONE_RE = /\[x\]\s*TODO|TODO\s*\[x\]/gi;

/** Resolution patterns (close threads) */
const RESOLUTION_KEYWORDS = /(?:decided|agreed|accepted|done|ready|chosen|using|closed|figured out|fixed|resolved|completed|implemented|installed|done|fixed|resolved|completed|implemented)\s+(.{5,120})/gi;

/**
 * Generates a unique thread ID
 * @returns {string} syn_<timestamp36>_<random4>
 */
function generateThreadId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `syn_${ts}_${rand}`;
}

/**
 * Ensures the threads table exists in LanceDB
 * @param {object} db - LanceDB connection
 * @returns {Promise<object>} LanceDB table
 */
async function ensureThreadsTable(db) {
  const tables = await db.tableNames();
  if (tables.includes('threads')) {
    return db.openTable('threads');
  }

  console.log('[synapse] Creating threads table...');
  const table = await db.createTable('threads', [{
    vector: Array(EMBED_DIM).fill(0),
    id: '__init__',
    topic: '__init__',
    direction: '',
    status: 'archived',
    importance: 0,
    sourceSession: '',
    relatedThreads: '[]',
    lastMention: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    metadata: '{}'
  }]);
  console.log('[synapse] Threads table created');
  return table;
}

/**
 * Get the threads table (lazy init)
 * @returns {Promise<object>}
 */
async function getThreadsTable() {
  const db = await getDb();
  return ensureThreadsTable(db);
}

/**
 * Cleans the beginning of direction from junk characters (spaces, dashes, colons, arrows)
 * @param {string} str
 * @returns {string}
 */
function cleanDirectionPrefix(str) {
  return str.replace(/^[\s\-—:→]+/, '').trim();
}

/**
 * Extracts direction for a question: text from beginning of sentence to '?', max 80 chars.
 * @param {string} questionText - Full question text including '?'
 * @returns {string}
 */
function extractQuestionDirection(questionText) {
  const body = questionText.replace(/\?+$/, '').trim();
  if (body.length <= 80) return body;
  return body.substring(0, 80) + '...';
}

/**
 * Extracts direction for a task: text AFTER the keyword to end of sentence (period, \n, or 80 chars).
 * @param {string} afterKeyword - Text after the task keyword
 * @returns {string}
 */
function extractTaskDirection(afterKeyword) {
  const clean = cleanDirectionPrefix(afterKeyword);
  // Trim at period or newline
  const sentenceEnd = clean.search(/[.\n]/);
  const trimmed = sentenceEnd > 0 ? clean.substring(0, sentenceEnd) : clean;
  if (trimmed.length <= 80) return trimmed.trim();
  return trimmed.substring(0, 80).trim() + '...';
}

/**
 * Extracts direction for a resolution: text AFTER the keyword to end of sentence.
 * @param {string} afterKeyword - Text after the resolution keyword
 * @returns {string}
 */
function extractResolutionDirection(afterKeyword) {
  const clean = cleanDirectionPrefix(afterKeyword);
  const sentenceEnd = clean.search(/[.\n]/);
  const trimmed = sentenceEnd > 0 ? clean.substring(0, sentenceEnd) : clean;
  if (trimmed.length <= 80) return trimmed.trim();
  return trimmed.substring(0, 80).trim() + '...';
}

/**
 * Forms a topic from direction: first 60 chars + '...' if longer.
 * @param {string} direction
 * @returns {string}
 */
function topicFromDirection(direction) {
  // Remove Unicode escapes (\uXXXX), markdown formatting, and trailing junk (dashes, colons)
  let topic = direction
    .replace(/\\u[0-9a-fA-F]{4}/g, '')
    .replace(/[\s\-—:]+$/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~`>\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (topic.length > 60) topic = topic.substring(0, 60) + '...';
  return topic;
}

/**
 * Extracts threads from a message text.
 *
 * Algorithm:
 * - Looks for '?' -> question = open thread, direction = question text
 * - Looks for 'need to/task/do/TODO' -> task, direction = text after keyword
 * - Looks for 'decided/agreed/accepted' -> resolution, direction = text after keyword
 * - Embedding -> search for similar open threads -> linking
 *
 * @param {string} text - Text to analyze
 * @param {string} [sessionLabel='unknown'] - Session/topic identifier
 * @returns {Promise<{created: Array, resolved: Array}>}
 */
export async function extract(text, sessionLabel = 'unknown') {
  if (!text || text.trim().length < 10) {
    return { created: [], resolved: [] };
  }

  const table = await getThreadsTable();
  const created = [];
  const resolved = [];

  // Determine overrideDate from sessionLabel (YYYY-MM-DD... -> end-of-day timestamp)
  const isDateLabel = /^\d{4}-\d{2}-\d{2}/.test(sessionLabel);
  const overrideDate = isDateLabel ? sessionLabel.slice(0, 10) + 'T23:59:00.000Z' : undefined;

  // 1. Extract questions (minimum 30 chars to filter out fragments)
  const questions = [];
  let m;
  while ((m = QUESTION_RE.exec(text)) !== null) {
    const q = m[1].trim();
    if (q.length > 30) questions.push(q);
  }

  // 2. Extract tasks (with noise filtering)
  const tasks = [];
  while ((m = TASK_KEYWORDS.exec(text)) !== null) {
    const full = m[0].trim();
    const afterKeyword = m[1].trim();
    if (full.length <= 30) continue;
    if (PAST_ACTION_RE.test(full)) continue;
    if (/^(?:need to|necessary)/i.test(full)) {
      const wordsAfter = afterKeyword.split(/\s+/).filter(w => w.length > 0);
      if (wordsAfter.length <= 3) continue;
    }
    if (/TODO/i.test(full) && TODO_DONE_RE.test(text)) continue;
    tasks.push({ full, afterKeyword });
  }

  // 3. Extract resolutions
  const resolutions = [];
  while ((m = RESOLUTION_KEYWORDS.exec(text)) !== null) {
    const full = m[0].trim();
    const afterKeyword = m[1].trim();
    if (full.length > 5) resolutions.push({ full, afterKeyword });
  }

  // 4. Create threads for questions
  for (const q of questions) {
    const direction = extractQuestionDirection(q);
    const topic = topicFromDirection(direction);
    const thread = await createThread(table, {
      topic,
      direction,
      importance: 5,
      sourceSession: sessionLabel,
      text: q,
      overrideDate
    });
    if (thread) created.push(thread);
  }

  // 5. Create threads for tasks
  for (const { full, afterKeyword } of tasks) {
    const direction = extractTaskDirection(afterKeyword);
    const topic = topicFromDirection(direction);
    const thread = await createThread(table, {
      topic,
      direction,
      importance: 6,
      sourceSession: sessionLabel,
      text: full,
      overrideDate
    });
    if (thread) created.push(thread);
  }

  // 6. For resolutions — try to close related threads
  for (const { full, afterKeyword } of resolutions) {
    const direction = extractResolutionDirection(afterKeyword);
    const embedding = await getEmbedding(full);
    if (!embedding) continue;

    try {
      const similar = await table.search(embedding)
        .where("status = 'open'")
        .limit(3)
        .toArray();

      for (const s of similar) {
        if (s.id === '__init__') continue;
        const dist = s._distance || Infinity;
        if (dist < 300) {
          await resolve(s.id, direction || full);
          resolved.push({ id: s.id, topic: s.topic, resolution: direction || full });
        }
      }
    } catch (e) {
      console.warn('[synapse] Error resolving threads:', e.message);
    }
  }

  console.log(`[synapse] extract: ${created.length} created, ${resolved.length} resolved from session=${sessionLabel}`);
  if (created.length > 0 || resolved.length > 0) {
    markCrystalDirty(`synapse: ${created.length} created, ${resolved.length} resolved`);
  }
  return { created, resolved };
}

/**
 * Creates a thread in LanceDB with search for related ones
 * @param {object} table - LanceDB threads table
 * @param {object} params
 * @returns {Promise<object|null>} Created thread or null on duplicate
 */
async function createThread(table, { topic, direction, importance, sourceSession, text, overrideDate }) {
  const embedding = await getEmbedding(text);
  if (!embedding) return null;

  // Duplicate check: if a very similar open thread exists — do not create, update lastMention instead
  try {
    const similar = await table.search(embedding)
      .where("status = 'open'")
      .limit(1)
      .toArray();

    if (similar.length > 0 && similar[0].id !== '__init__') {
      const dist = similar[0]._distance || Infinity;
      if (dist < 80) {
        // Too similar — update lastMention of the existing thread
        console.log(`[synapse] Duplicate detected (dist=${dist.toFixed(1)}), updating lastMention for ${similar[0].id}`);
        try {
          const now = new Date().toISOString();
          await table.update(
            { lastMention: `'${now}'` },
            { where: `id = '${similar[0].id}'` }
          );
        } catch (e) {
          console.warn('[synapse] Failed to update lastMention on dedup:', e.message);
        }
        return null;
      }
    }
  } catch (e) {
    // first run — table may still be empty
  }

  // Search for related threads
  let relatedIds = [];
  try {
    const related = await table.search(embedding)
      .where("status = 'open'")
      .limit(5)
      .toArray();

    relatedIds = related
      .filter(r => r.id !== '__init__' && (r._distance || Infinity) < 300)
      .map(r => r.id);
  } catch (e) {
    // ok
  }

  const now = new Date().toISOString();
  const createdAt = overrideDate || now;
  const id = generateThreadId();

  const record = {
    vector: embedding,
    id,
    topic,
    direction,
    status: 'open',
    importance,
    sourceSession,
    relatedThreads: JSON.stringify(relatedIds),
    lastMention: now,
    createdAt,
    metadata: JSON.stringify({ originalText: text.substring(0, 300) })
  };

  await table.add([record]);
  console.log(`[synapse] Thread created: ${id} — "${topic.substring(0, 60)}"`);

  return { id, topic, direction, status: 'open', importance, sourceSession, relatedThreads: relatedIds };
}

/**
 * Finds live threads relevant to a query.
 * Semantic search over open threads, sorted by relevance x recency.
 *
 * @param {string} query - Query
 * @param {number} [limit=5] - Maximum results
 * @returns {Promise<Array<{id, topic, direction, sourceSession, lastMention, score, context}>>}
 */
export async function weave(query, limit = 5) {
  if (!query || query.trim().length < 3) return [];

  const table = await getThreadsTable();
  const embedding = await getEmbedding(query);
  if (!embedding) return [];

  let results;
  try {
    results = await table.search(embedding)
      .where("status = 'open'")
      .limit(limit * 3)
      .toArray();
  } catch (e) {
    console.warn('[synapse] weave search error:', e.message);
    return [];
  }

  const now = Date.now();
  const RECENCY_GAMMA = 0.997; // ~10 day half-life

  return results
    .filter(r => r.id !== '__init__')
    .map(r => {
      const baseSimilarity = Math.max(0, 1 - (r._distance || 0) / 400);
      const ageHours = (now - new Date(r.lastMention).getTime()) / 3600000;
      const recency = Math.pow(RECENCY_GAMMA, ageHours);
      const importanceBoost = 0.5 + (r.importance || 5) / 10;
      const score = baseSimilarity * recency * importanceBoost;

      return {
        id: r.id,
        topic: r.topic,
        direction: r.direction,
        sourceSession: r.sourceSession,
        lastMention: r.lastMention,
        importance: r.importance,
        relatedThreads: safeParseJSON(r.relatedThreads, []),
        score,
        context: `In session ${r.sourceSession}: ${r.topic} -> ${r.direction}`
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Closes a thread (status -> resolved)
 * @param {string} threadId - Thread ID
 * @param {string} [resolution] - Resolution text
 * @returns {Promise<{success: boolean, threadId: string}>}
 */
export async function resolve(threadId, resolution) {
  const table = await getThreadsTable();

  try {
    const all = await table.search(Array(EMBED_DIM).fill(0))
      .where(`id = '${threadId}'`)
      .limit(1)
      .toArray();

    if (all.length === 0) {
      return { success: false, threadId, error: 'Thread not found' };
    }

    const thread = all[0];
    const meta = safeParseJSON(thread.metadata, {});
    meta.resolution = resolution || 'Resolved';
    meta.resolvedAt = new Date().toISOString();

    const metaStr = JSON.stringify(meta).replace(/'/g, "''");
    const now = new Date().toISOString();
    await table.update(
      { status: "'resolved'", metadata: `'${metaStr}'`, lastMention: `'${now}'` },
      { where: `id = '${threadId}'` }
    );

    console.log(`[synapse] Thread resolved: ${threadId}`);
    markCrystalDirty('thread resolved');
    return { success: true, threadId };
  } catch (e) {
    console.error('[synapse] resolve error:', e.message);
    return { success: false, threadId, error: e.message };
  }
}

/**
 * Archives threads older than STALE_DAYS days without mentions
 * @returns {Promise<{archived: number}>}
 */
export async function archiveStale() {
  const table = await getThreadsTable();
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let archived = 0;
  try {
    const stale = await table.search(Array(EMBED_DIM).fill(0))
      .where("status = 'open'")
      .limit(500)
      .toArray();

    for (const thread of stale) {
      if (thread.id === '__init__') continue;
      if (thread.lastMention && thread.lastMention < cutoff) {
        await table.update(
          { status: "'archived'" },
          { where: `id = '${thread.id}'` }
        );
        archived++;
      }
    }
  } catch (e) {
    console.error('[synapse] archiveStale error:', e.message);
  }

  console.log(`[synapse] Archived ${archived} stale threads`);
  return { archived };
}

/**
 * Returns all open threads
 * @returns {Promise<Array>}
 */
export async function getActive() {
  const table = await getThreadsTable();

  try {
    const results = await table.search(Array(EMBED_DIM).fill(0))
      .where("status = 'open'")
      .limit(100)
      .toArray();

    return results
      .filter(r => r.id !== '__init__')
      .map(r => ({
        id: r.id,
        topic: r.topic,
        direction: r.direction,
        status: r.status,
        importance: r.importance,
        sourceSession: r.sourceSession,
        relatedThreads: safeParseJSON(r.relatedThreads, []),
        lastMention: r.lastMention,
        createdAt: r.createdAt || r.lastMention || null
      }))
      .sort((a, b) => (b.importance || 0) - (a.importance || 0));
  } catch (e) {
    console.error('[synapse] getActive error:', e.message);
    return [];
  }
}

/**
 * Returns threads by status (or all)
 * @param {'open'|'resolved'|'archived'|'all'} [status='all']
 * @param {number} [limit=100]
 * @returns {Promise<Array>}
 */
export async function getThreads(status = 'all', limit = 100) {
  const table = await getThreadsTable();

  try {
    let query = table.search(Array(EMBED_DIM).fill(0)).limit(limit);
    if (status !== 'all') {
      query = query.where(`status = '${status}'`);
    }
    const results = await query.toArray();

    return results
      .filter(r => r.id !== '__init__')
      .map(r => ({
        id: r.id,
        topic: r.topic,
        direction: r.direction,
        status: r.status,
        importance: r.importance,
        sourceSession: r.sourceSession,
        relatedThreads: safeParseJSON(r.relatedThreads, []),
        lastMention: r.lastMention,
        createdAt: r.createdAt || r.lastMention || null
      }))
      .sort((a, b) => (b.importance || 0) - (a.importance || 0));
  } catch (e) {
    console.error('[synapse] getThreads error:', e.message);
    return [];
  }
}

/**
 * Safe JSON.parse with fallback
 * @param {string} str
 * @param {*} fallback
 * @returns {*}
 */
function safeParseJSON(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Re-extracts all threads from daily files memory/2026-03-*.md.
 * Clears the threads table (drop + recreate), runs each file through extract().
 *
 * @returns {Promise<{files: number, created: number, resolved: number}>}
 */
export async function reExtractAll() {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');

  const memoryDir = join(homedir(), 'submarine', 'memory');
  const allFiles = await readdir(memoryDir);
  const dailyFiles = allFiles
    .filter(f => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
    .sort();

  console.log(`[synapse] re-extract: found ${dailyFiles.length} daily files`);

  // Drop and recreate table
  const db = await getDb();
  const tables = await db.tableNames();
  if (tables.includes('threads')) {
    await db.dropTable('threads');
    console.log('[synapse] re-extract: dropped old threads table');
  }
  // ensureThreadsTable will recreate it
  await ensureThreadsTable(db);

  // Load all files
  const fileContents = [];
  for (const file of dailyFiles) {
    const filePath = join(memoryDir, file);
    const content = await readFile(filePath, 'utf-8');
    const sessionLabel = file.replace(/\.md$/, '');
    fileContents.push({ file, content, sessionLabel });
  }

  // Pass 1: create threads (resolve in extract will also fire,
  // but on the first pass the table is still being populated)
  let totalCreated = 0;
  let totalResolved = 0;

  for (const { file, content, sessionLabel } of fileContents) {
    const { created, resolved } = await extract(content, sessionLabel);
    totalCreated += created.length;
    totalResolved += resolved.length;
    console.log(`[synapse] re-extract pass1: ${file} -> ${created.length} created, ${resolved.length} resolved`);
  }

  // Pass 2: re-resolve — now the table has all threads,
  // and resolutions can find matches
  console.log('[synapse] re-extract: starting pass 2 (resolve only)...');
  let pass2Resolved = 0;

  for (const { file, content, sessionLabel } of fileContents) {
    // Extract only resolutions and attempt to resolve
    const resolutions = [];
    let m;
    const re = new RegExp(RESOLUTION_KEYWORDS.source, RESOLUTION_KEYWORDS.flags);
    while ((m = re.exec(content)) !== null) {
      const full = m[0].trim();
      const afterKeyword = m[1].trim();
      if (full.length > 5) resolutions.push({ full, afterKeyword });
    }

    if (resolutions.length === 0) continue;

    const table = await getThreadsTable();
    for (const { full, afterKeyword } of resolutions) {
      const direction = extractResolutionDirection(afterKeyword);
      const embedding = await getEmbedding(full);
      if (!embedding) continue;

      try {
        const similar = await table.search(embedding)
          .where("status = 'open'")
          .limit(3)
          .toArray();

        for (const s of similar) {
          if (s.id === '__init__') continue;
          const dist = s._distance || Infinity;
          if (dist < 300) {
            await resolve(s.id, direction || full);
            pass2Resolved++;
          }
        }
      } catch (e) {
        // ok
      }
    }
  }

  totalResolved += pass2Resolved;
  console.log(`[synapse] re-extract pass2: ${pass2Resolved} additional resolved`);
  console.log(`[synapse] re-extract done: ${dailyFiles.length} files, ${totalCreated} threads created, ${totalResolved} total resolved`);
  return { files: dailyFiles.length, created: totalCreated, resolved: totalResolved };
}

// --- CLI ---
const cliArg = process.argv[2];
if (cliArg === 're-extract') {
  reExtractAll()
    .then(r => {
      console.log(`[synapse] CLI re-extract complete:`, r);
      process.exit(0);
    })
    .catch(e => {
      console.error('[synapse] CLI re-extract failed:', e);
      process.exit(1);
    });
}
