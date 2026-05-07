/**
 * Benchmark: BGE-M3 (F16) vs Qwen3-Embedding-0.6B
 * =================================================
 * Compares embedding quality on domain-specific queries.
 *
 * Approach:
 *   1. Get top-5 results from current pipeline (BGE-M3 + LanceDB + reranker)
 *   2. Re-embed query + each result with Qwen3
 *   3. Compute cosine similarity with Qwen3 embeddings
 *   4. Compare rankings side-by-side
 *
 * Run: node semantic-memory/benchmark-models.mjs
 */

import { searchMemories, getDb } from './memory-engine.mjs';

const OLLAMA_URL = 'http://localhost:11434';

const TEST_QUERIES = [
  'vector similarity search',
  'temporal decay mechanism',
  'hybrid ranking algorithm',
  'embedding model comparison',
  'decentralized architecture patterns',
  'causal graph memory traversal',
  'forgetting stale memories',
  'energy-efficient inference',
  'quantum superposition of decisions',
  'knowledge distillation pipeline',
];

async function embed(text, model) {
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status} for ${model}`);
  const data = await resp.json();
  return data.embedding;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function kendallTau(a, b) {
  const n = Math.min(a.length, b.length);
  let concordant = 0, discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ai = a[i], aj = a[j], bi = b[i], bj = b[j];
      if ((ai - aj) * (bi - bj) > 0) concordant++;
      else if ((ai - aj) * (bi - bj) < 0) discordant++;
    }
  }
  const pairs = n * (n - 1) / 2;
  return pairs > 0 ? (concordant - discordant) / pairs : 0;
}

async function benchmarkQuery(query, idx) {
  const bgResults = await searchMemories(query, 5, 0.1);
  if (bgResults.length === 0) {
    console.log(`  Query ${idx + 1}: "${query}" — no results, skipping`);
    return null;
  }

  const qwenQueryEmb = await embed(query, 'qwen3-embedding:0.6b');

  const qwenScores = [];
  for (const r of bgResults) {
    const docEmb = await embed(r.text, 'qwen3-embedding:0.6b');
    qwenScores.push(cosineSim(qwenQueryEmb, docEmb));
  }

  const bgeRanks = bgResults.map((_, i) => i);

  const qwenRankIndices = [...Array(bgResults.length).keys()]
    .sort((a, b) => qwenScores[b] - qwenScores[a]);
  const qwenRanks = Array(bgResults.length);
  qwenRankIndices.forEach((origIdx, rank) => { qwenRanks[origIdx] = rank; });

  const tau = kendallTau(bgeRanks, qwenRanks);

  return { query, bgResults, qwenScores, qwenRanks, bgeRanks, tau };
}

async function main() {
  console.log('Embedding Model Benchmark: BGE-M3 (F16) vs Qwen3-0.6B');
  console.log('='.repeat(56) + '\n');

  console.log('Warming up models...');
  await embed('test', 'bge-m3');
  await embed('test', 'qwen3-embedding:0.6b');
  console.log('Ready.\n');

  const results = [];
  let totalTau = 0;
  let validQueries = 0;

  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const q = TEST_QUERIES[i];
    console.log(`--- Query ${i + 1}/10: "${q}" ---`);

    const r = await benchmarkQuery(q, i);
    if (!r) continue;

    results.push(r);
    totalTau += r.tau;
    validQueries++;

    console.log('  Rank | Text (first 46 chars)                            | BGE Score| Qwen3 Cos| Qwen3 Rank');
    console.log('  ' + '-'.repeat(100));

    for (let j = 0; j < r.bgResults.length; j++) {
      const text = r.bgResults[j].text.substring(0, 46).padEnd(46);
      const bgeScore = (r.bgResults[j].score || 0).toFixed(4).padStart(8);
      const qwenCos = r.qwenScores[j].toFixed(4).padStart(8);
      const qwenRank = String(r.qwenRanks[j] + 1).padStart(8);
      console.log(`    ${j + 1}  | ${text} | ${bgeScore} | ${qwenCos} | ${qwenRank}`);
    }
    console.log(`  Kendall tau: ${r.tau.toFixed(3)} ${r.tau > 0.5 ? 'agree' : r.tau > 0 ? 'partial' : 'disagree'}\n`);
  }

  console.log('\nSUMMARY');
  console.log('='.repeat(48));
  console.log(`  Queries tested:     ${validQueries}/${TEST_QUERIES.length}`);
  console.log(`  Avg Kendall tau:    ${validQueries > 0 ? (totalTau / validQueries).toFixed(3) : 'N/A'}`);
  console.log(`  Interpretation:`);
  if (validQueries > 0) {
    const avgTau = totalTau / validQueries;
    if (avgTau > 0.6) {
      console.log('    Models largely agree on ranking — Qwen3 viable as replacement.');
    } else if (avgTau > 0.2) {
      console.log('    Partial agreement — Qwen3 captures some semantics differently.');
      console.log('    Switching would change search behavior noticeably.');
    } else {
      console.log('    Models disagree significantly — DO NOT switch without retuning.');
    }
  }

  console.log('\n  BGE-M3:  567M params, F16, 1024-dim, proven multilingual');
  console.log('  Qwen3:   620M params, F16, 1024-dim, instruction-aware, Matryoshka');
  console.log('  Note: BGE-M3 results include reranker boost; Qwen3 is raw cosine only.');
  console.log('');
}

// Only run as CLI, not when imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
