# Architecture

Single source of truth for the submarine memory architecture.
Any agent, through any number of reloads, opens this file — and understands the system.

> **Version:** v1.0.5

---

## Principles

### 1. Markdown is storage, LanceDB is cache

Text files survive everything: engine changes, embedding model changes, host
changes, laptop changes. LanceDB is an index for fast semantic search. If the
index dies, `rebuild` recreates it from the source files in minutes.

Three permanent files form the durable spine of the system:

- `SOUL-JOURNAL.md` — every Soul record is auto-appended here.
- `CORE-JOURNAL.md` — every Core record is auto-appended here.
- `CORTEX-JOURNAL.md` — every Cortex record is auto-appended here.

Format: `[ISO-timestamp] record text`.

### 2. Three memory layers

| Layer | Purpose | Decay | Search weight | LanceDB category |
|-------|---------|-------|---------------|------------------|
| **Soul** | Persistent context, principles, constants | Never | ×3.0 | `identity` |
| **Core** | Facts, decisions, lessons, technical | Standard | ×2.0 | `fact`, `decision`, `lesson`, … |
| **Cortex** | Episodes, events, conversations | 7 days → stale (×0.1) | ×1.0 | `episode`, `resilient_episode` |

`resilient_episode` — episodes that should not decay (lessons-in-action that
matter beyond 7 days).
`unifiedSearch(query)` sorts by
`weightedScore = score × layerWeight × (importance / 10)`.
`deepSearch(query)` — four-pass search through Soul → Core → Coupling → Cortex
(see below).

### 3. Single facade

All external consumers access the system through one facade:

```
Plugin (CJS)   → bridge.cjs → core/rag.mjs → layers.mjs → LanceDB
Cron           → core/sync.mjs             → layers.mjs → LanceDB
Hook           → layers.mjs                             → LanceDB
REST API       → src/server.mjs → layers.mjs            → LanceDB
CLI            → core/rag.mjs or core/sync.mjs
```

`semantic-memory/memory-engine.mjs` is an internal dependency — do not call it
directly from new code.
`semantic-memory/reranker-daemon.py` is a Python daemon bound to
`127.0.0.1:3200`, providing reranking and sparse retrieval.

### 4. Write protection

All `add()` operations go through a file mutex (`withWriteLock`). Two processes
cannot write to LanceDB simultaneously. The lock auto-releases after 5 seconds
if a holder is stuck.

### 5. Self-knowledge

submarine remembers its own architecture as part of Soul. A record describing
the three-layer memory structure exists in both `SOUL-JOURNAL.md` and LanceDB,
so the system can reason about itself.

### 6. Immune protection

Every record targeting Soul or Core is checked by `src/immune.mjs`. Three
immunity layers:

- **Protection** (semantic distance — fail-safe).
- **Recognition** (causal path — advisory).
- **Anticipation** (Soul growth zone — advisory).

Rejected records are redirected downward (Soul → Core, Core → Cortex),
**never deleted**.

### 7. Context optimization philosophy

Proper context setup can improve results more than switching to a more
expensive model. Principle: do not change the model, do not cut capabilities —
give the model exactly the context it needs, and it does in one call what it
used to do in five.

### 8. Zero-LLM memory

The memory layer itself calls no LLM. Embeddings run locally via BGE-M3.
Reranking runs locally. Causal extraction is pattern-based. Crystal generation
is pure data composition. Cost per recall: **$0**.

---

## File structure

```
submarine/
├── ARCHITECTURE.md                ← you are here
├── README.md
├── CHANGELOG.md
├── LICENSE
├── COPYRIGHT
├── docs/
│   └── QUICKSTART.md
├── templates/
│   └── SOUL-TEMPLATE.md           ← starter SOUL.md
├── adapters/                      ← host-integration adapters (optional)
├── core/
│   ├── crystal.mjs                ← Crystal generator: 5-step pipeline
│   ├── crystal-update-controller.mjs ← Event-driven Crystal updates
│   ├── rag.mjs                    ← RAG facade (search + prompt context) + semantic cache
│   ├── sync.mjs                   ← Markdown extraction + layer routing + immune + contradiction
│   ├── contradiction.mjs          ← Contradiction detection (auto-supersede)
│   ├── contradiction-scan.mjs     ← Scheduled batch contradiction scan
│   └── promote.mjs                ← Experience lift (Cortex → Core → Soul)
├── rings/
│   ├── soul.mjs                   ← Ring 1: Soul Resonance
│   ├── knowledge.mjs              ← Ring 2: Knowledge
│   └── causality.mjs              ← Ring 3: Causality
├── extensions/
│   └── .gitkeep                   ← extension slot (contract = ring contract)
├── src/
│   ├── config.mjs                 ← Central config loader (singleton)
│   ├── layers.mjs                 ← Three layers + deepSearch + unifiedSearch
│   ├── server.mjs                 ← REST API + healthcheck + liveness probe
│   ├── manifest.mjs               ← Manifest endpoint payload
│   ├── immune.mjs                 ← Three-layer immune system
│   ├── causal.mjs                 ← Causal graph + behavioral edge extraction
│   ├── forgetting.mjs             ← decay / supersede / archive
│   ├── synapse.mjs                ← Inter-session thread bridge
│   ├── utils.mjs                  ← ID generation, write lock
├── scripts/
│   └── scan-behavioral.mjs        ← One-shot behavioral-edge scanner
├── test/
│   └── smoke.mjs                  ← smoke tests
├── diagnose.mjs                   ← post-rebuild diagnostics
├── data/
│   ├── causal-graph.json          ← Causal edges (atomic write)
│   ├── immune-stats.json
│   ├── sync-state.json
│   ├── promote-state.json
│   ├── crystal-prev-snapshot.json ← Previous Crystal snapshot (for delta)
│   └── .write.lock                ← Runtime mutex (do not commit)
├── bridge.cjs                     ← CJS bridge for plugin integrations
├── index.mjs                      ← Server entry point
├── package.json
├── submarine.config.example.json ← Config template (copy to submarine.config.json)
├── submarine.service              ← systemd user service (reference)
└── install-service.sh
```

---

## Module contracts

### `src/layers.mjs` — `unifiedSearch(query, limit, options?)`

- **Input:** `query: string`, `limit: number`, `options? { skipRerank?: boolean }`.
- **Output:** `Array<{ text, score, weightedScore, layer: 'soul' | 'core' | 'cortex', source?, category?, importance?, timestamp?, metadata? }>`.
- **Guarantees:** sorted by `weightedScore` descending; `layer` always present.
- `options.skipRerank` bypasses the sparse + reranker pipeline (dense-only scoring). API search uses `skipRerank=true` by default; callers opt in via `?rerank=true`.

### `src/layers.mjs` — `Soul.add / Core.add / Cortex.add`

- **Signatures:** `Soul.add(text)`, `Core.add(text, category, importance)`, `Cortex.add(text, metadata)`.
- **Output:** `{ success, id, text, layer }`.
- **Side effects:** LanceDB write under the write lock; append to the layer's JOURNAL; `markCrystalDirty('record added to {layer}')`.
- **ID format:** `sub_<timestamp36>_<random4>` (example: `sub_m1abc23_x7kq`).

### `core/rag.mjs` — `getRAGContext(query, options?)`

- **Output:** `{ query, cached?, memories[], knowledge[], contextText: string }`.
- **contextText format:** section header followed by lines of the form `- [LAYER] text (score: X.XX)`.
- **Uses** `deepSearch` (Soul → Core → Coupling → Cortex) rather than `unifiedSearch`.
- **Caching:** `checkCache → HIT (0 tokens) / MISS → deepSearch → storeCache`.

### `core/sync.mjs` — `processNewFiles()`

- **Output:** `{ filesProcessed: number, factsAdded: number }`.
- **Routing:** philosophy / relationship → Soul; milestone / quote → Cortex; everything else → Core.
- **Immune:** `immune.mjs` checks Soul and Core records before write.
- **Behavioral:** new records are auto-scanned for causal patterns via `extractCausalPatterns()`.

### `core/promote.mjs` — experience lift (Cortex → Core → Soul)

- **Run:** `node core/promote.mjs [--dry-run]`.
- **State:** `data/promote-state.json`.
- **Immune gate:** every Core → Soul promotion is checked by `immune.mjs`.

### `core/crystal.mjs` — Crystal generator

- **Output:** `CONTEXT-CRYSTAL.md` — a self-contained inter-session briefing. Cost: **$0**. No LLM.
- **Inputs (pure data):** `SOUL.md` + LanceDB + Synapse + `immune-stats.json` + `causal-graph.json`.

Five-step pipeline:

1. `collectArtifacts()` — `Promise.allSettled` across all build blocks; returns a raw struct.
2. `enrichWithRings(artifacts)` — dynamically loads rings, applies annotations, computes coverage.
3. `runExtensions(artifacts)` — loads `.mjs` files from `extensions/` (contract = ring contract).
4. `formatCrystal(artifacts)` — assembles the Crystal markdown from enriched artifacts.
5. `generateCrystal()` — orchestration: `collect → enrich → extend → format → delta → write`.

Six content sections:

1. **Soul Essence** — identity from `SOUL.md` (read-only; Soul Lock respected).
2. **Focus** — top-3 Synapse threads (importance ≥ 6) + top-3 Core decisions (72 h, cascading fallback) + ring annotations.
3. **Operational Picture** — Cortex episodes (48 h → 7 d → last 5), errors, metrics.
4. **Health** — immune stats + system health + maturity score + annotation counts.
5. **Live Threads (Synapse)** — all threads grouped (hot ≥ 6 / rest) + recently closed (72 h) + totals.
6. **Fresh Insights** — decisions + lessons (48 h, cascading fallback) + ring annotations.

Crystal header includes per-ring status and annotation counts. A delta line at the end tracks what changed since the previous generation.

### `core/crystal-update-controller.mjs` — event-driven updates

- **Exports:** `markCrystalDirty(reason?)`, `startController()`, `stopController()`, `getStatus()`.
- **Trigger:** any mutation calls `markCrystalDirty(reason)` → debounce → regeneration.
- **Intervals:** debounce 5 min (configurable), check every 60 s, safety cron every 6 h.
- **Mutex:** `isGenerating` flag prevents parallel generation.
- **Callers:** `layers.mjs` (add), `synapse.mjs` (extract / resolve), `causal.mjs` (addRelation), `forgetting.mjs` (supersede / archive).
- **Lifecycle:** `startController()` on server start, `stopController()` in graceful shutdown.

### `src/immune.mjs` — immune system

Three layers:

1. **Protection** (fail-safe): semantic distance from existing Soul records.
2. **Recognition** (advisory): causal path to Soul through the graph.
3. **Anticipation** (advisory): Soul growth zone — effects of Soul nodes in the causal graph.

Policies:

- **Soul:** majority vote — more than half of the available layers must approve; early exit at semantic similarity ≥ 0.55.
- **Core:** semantic gate, with causality as a second chance.
- **Cortex:** free entry (no immune check).
- **Rejected records** are redirected downward, never deleted.

Config:

```json
{ "semanticThreshold": 0.45, "semanticAutoPass": 0.55, "causalDepth": 3 }
```

Causal graph cache TTL: 10 min. Timeout 45 s → fallback Core.

### `src/forgetting.mjs` — decay / supersede / archive

Three mechanisms:

1. **Decay** — `effectiveImportance` decreases with time. Soul = 1.0 (permanent), Core half-life 60 days, Cortex stale at 7 days.
2. **Supersede** — the old fact is marked `superseded` by the new one (`active=false`, `source.supersededBy`).
3. **Archive** — low-importance records are flagged `archived`. Thresholds: Soul never; Core < 2.0; Cortex < 1.0.

Principle: **data is never deleted from LanceDB** — only metadata flags change. JOURNALs are immutable.

`applyForgettingFilters()` is called in every search, filtering superseded and archived records.

### `core/contradiction.mjs` — contradiction detection

- **Trigger:** called from `sync.mjs` → `routeToLayer()` on Core / Soul writes.
- **Algorithm:** top-10 similar records → cosine > 0.72 + negation words → auto-supersede old record.
- **Side effect:** creates a `supersedes` edge in the causal graph.
- **Cost:** $0. Fully local on BGE-M3; zero API tokens.

### `src/synapse.mjs` — inter-session bridge

Methods:

- `extract(text, sessionLabel)` — pattern matching: `?` → question; `need / TODO` → task; resolution keywords → resolve.
- `weave(query, n)` — semantic search over open threads; `score = similarity × recency × importance`.
- `resolve(threadId, resolution)` — status → resolved via `table.update({status: "'resolved'"}, { where: "id = '…'" })`.
- `archiveStale()` — threads older than 14 days without mentions are archived. Runs before every Crystal generation.
- `getActive()`, `getThreads(status, limit)`, `reExtractAll()`.

Storage: LanceDB table `threads` — vector 1024 d BGE-M3, plus `id, topic, direction, status, importance, sourceSession, relatedThreads, lastMention, createdAt, metadata`.

No LLM — pure patterns + embeddings + LanceDB.

---

## REST API (`src/server.mjs`)

**Memory**

- `GET  /api/v1/memory/search?q=...&mode=simple|deep&limit=5&layer=all|soul|core|cortex&cluster=true&causal=true&rerank=true` — search. `mode=deep` triggers `deepSearch` (four-pass). `causal=true` is the default (set `causal=false` to disable). `skipRerank=true` is the default; pass `rerank=true` to opt in to the sparse + reranker pipeline.
- `POST /api/v1/memory` — write. Body: `{ layer, text, metadata }`. Immune gate + auto-extract synapse.
- `DELETE /api/v1/memory?id=X` — soft delete (`active=false`, `source.forgotten=true`).
- `POST /api/v1/memory/supersede` — supersede old fact with new.
- `GET  /api/v1/memory/archive` — scan archive candidates (dry-run).
- `POST /api/v1/memory/archive` — apply archival.

**System**

- `GET  /api/v1/health` — `{ status: 'ok' | 'degraded', checks: { ollama, lancedb: { status, rows }, layers, modules }, timestamp }`. Includes liveness probe: real `countRows()` with a 5 s timeout.
- `GET  /api/v1/stats` — layer statistics.
- `GET  /api/v1/manifest` — `{ block, version, rings[], extensions[], update_channel, generated }`.

**Causal**

- `GET  /api/v1/causal/stats` — graph statistics (`totalEdges`, `byRelation`, behavioral count).
- `POST /api/v1/causal/add` — add edge. Body: `{ fromId, toId, type, strength, confidence }`. Types: `causes`, `enables`, `prevents`, `correlates`.

**Synapse**

- `POST /api/v1/synapse/extract` — extract threads from text.
- `POST /api/v1/synapse/weave` — semantic thread search.
- `POST /api/v1/synapse/resolve` — resolve thread.
- `POST /api/v1/synapse/archive-stale` — archive old threads.
- `GET  /api/v1/synapse/active` — list open threads.
- `GET  /api/v1/threads?status=open|resolved|archived|all` — threads by status.

---

## Configuration

All parameters live in `submarine.config.json` (see `submarine.config.example.json`). Code reads through `src/config.mjs` (singleton) rather than hardcoded values.

### `src/config.mjs`

- **Cache:** JSON parsed once; stored in a module-level singleton.
- **Exports:** `getConfig()`, `getServerPort()`, `getOllamaUrl()`, `getOllamaModel()`, `getEmbedDim()`, `getApiKey()`, `getWorkspacePath()`, `getSubmarinePath()`.
- **Usage pattern:** `getConfig().crystal?.soulResonanceThreshold || 0.45` — always with a fallback.

### Config sections

```
version, layers, server, search, writeLock, sync, backup,
ollama, embedding, crystal, rings, update, manifest,
adapter, adapterConfig, paths
```

Key sections:

- `crystal` — mode, `soulResonanceThreshold` (0.45), fallback windows, `maxEnrichmentsPerSection` (3).
- `rings` — `soul / knowledge / causality`: per-ring `enabled` flag plus `threshold / minScore / maxDepth`.
- `update` — `mode: event-driven`, `debounceMinutes` (5), `checkIntervalSeconds` (60), `safetyCronHours` (6).
- `manifest` — `updateChannel`.
- `adapter` / `adapterConfig` — host-specific integration paths (optional). `adapterConfig.claudeMdPath` and `adapterConfig.claudeMdSection` are reserved for the upcoming CLAUDE.md adapter and will be wired in a future release.
- `paths` — data dir, causal graph, immune stats, journals, extensions, rings.

---

## Four-pass search (`deepSearch`)

Implementation of four reasoning modes:

```
Pass 1 (Soul):     "Who am I in the context of this query?"
Pass 2 (Core):     "What do I know?"  (query enriched with Soul context)
Pass 3 (Coupling): Cluster resonance check between Soul and Core results
Pass 4 (Cortex):   "What happened recently?" + final assembly
```

Call: `deepSearch(query, { totalLimit: 10, skipRerank: true })`.
Return: `{ results: [...], meta: { passes, soulCount, coreCount, cortexCount, couplingScore } }`.

`skipRerank` bypasses the sparse + reranker pipeline across all three layer searches.

### `categoryFilter`

Each layer passes a `categoryFilter` to `searchMemories()`:

```
Soul.search(query, limit, options)   → searchMemories(query, limit*2, 0.3, 'identity', options)
Core.search(query, limit, options)   → searchMemories(query, limit*3, 0.2, [...categories...], options)
Cortex.search(query, limit, options) → searchMemories(query, limit*3, 0.1, ['episode', 'resilient_episode'], options)
```

This ensures layers do not compete with each other. Without it, a small Soul set would lose to a much larger Core set in a shared pool. The parameter is optional (default `null`); old callers still work.

### LanceDB update pattern

LanceDB has no classical `UPDATE WHERE`. Writes use `table.update({fields}, { where })` with SQL-escaped string values:

```js
// Important: string values must be SQL-escaped — wrapped in single quotes.
const escapedSource = JSON.stringify(meta).replace(/'/g, "''");
await table.update(
  { active: "'false'", source: `'${escapedSource}'` },
  { where: `timestamp = '${row.timestamp}'` }
);
```

`forgetting.mjs` uses this pattern for marking records superseded / archived.
`synapse.mjs` applies the same pattern for thread resolution — `table.search(…).where(id = …)` to locate, then `table.update({status: "'resolved'"}, { where })` to write.

### LanceDB schema — `threads` table (synapse)

| Field | Type | Description |
|-------|------|-------------|
| `vector` | `float32[1024]` | Topic embedding (BGE-M3, 1024-dim) |
| `id` | `string` | Unique thread ID |
| `topic` | `string` | Question / task text |
| `direction` | `string` | `question`, `task`, `idea` |
| `status` | `string` | `open`, `resolved`, `archived` |
| `importance` | `number` | 1–10 |
| `sourceSession` | `string` | Source session ID |
| `relatedThreads` | `string` | JSON array of related IDs |
| `lastMention` | `string` | ISO timestamp of last mention |
| `createdAt` | `string` | ISO timestamp of creation |
| `metadata` | `string` | JSON extra data |

---

## Rings of Depth

Three rings enrich the Crystal during generation. Each ring implements a standard contract:

```js
{
  name: string,
  version: string,
  canActivate(config, context): boolean,
  enrich(artifacts, config, context): void
}
```

Rings are loaded dynamically by `enrichWithRings()`: it imports `rings/*.mjs`, calls `canActivate()`, runs `enrich()`, and tracks `artifacts.rings.applied[]`.

| Ring | File | Annotation | Data source | Cost |
|------|------|-----------|-------------|------|
| **Soul** | `rings/soul.mjs` | `↳ Soul: <essence>` | `SOUL.md` → BGE-M3 embed → cosine similarity ≥ 0.45 | $0 |
| **Knowledge** | `rings/knowledge.mjs` | `↳ Knowledge: <fact>` | HTTP search in Core layer (decision / lesson / fact / technical), `minScore` 0.5 | $0 |
| **Causality** | `rings/causality.mjs` | `↳ Path: src → cause1 → cause2` | `causal-graph.json`, text matching + chain traversal, `maxDepth` 3 | $0 |

**Annotation order:** Soul → Knowledge → Causality. Each ring inserts after the previous ring's annotations.

**Graceful degradation**

- Ring disabled in config → `canActivate()` returns `false` → zero annotations; Crystal still generates.
- Ollama down → Soul ring deactivated; Knowledge and Causality still work.
- Server down → Knowledge ring deactivated (HTTP search fails); others work.
- Graph contains fewer than 5 edges → Causality ring deactivated.

**Coverage score:** `(rings with annotations / 3) × 100%`. Shown in the Crystal header.

**Per-ring config**

```json
{
  "rings": {
    "soul":      { "enabled": true, "threshold": 0.45 },
    "knowledge": { "enabled": true, "minScore": 0.5, "maxResults": 3 },
    "causality": { "enabled": true, "maxDepth": 3 }
  }
}
```

---

## Behavioral edges

Pattern-based causal extraction — regex patterns (Russian and English) that detect cause-effect relations in record text without any LLM calls.

Markers include `->`, `because`, `due to`, `led to`, `consequence`, `decided`, `therefore`, `resulted in`, `caused by`, and Russian equivalents.

**Functions (`src/causal.mjs`)**

- `extractCausalPatterns(text)` → `Array<{ cause, effect, marker }>`.
- `createBehavioralEdge(extraction, recordId)` → edge with `type: "behavioral"`, `evidence: marker`, `confidence: 1.0`.
- `scanForBehavioralEdges(records)` → batch processing.
- `mergeBehavioralEdges(edges)` → deduplicated merge into `causal-graph.json`.

**Integration.** The sync pipeline auto-scans new records for causal patterns on write. A one-shot scanner for existing records is available at `scripts/scan-behavioral.mjs`.

**In the causality ring** behavioral edges are prioritized over semantic edges during chain traversal, because they carry a literal marker as evidence rather than a similarity score.

---

## Extension system

Extensions follow the same contract as rings:

```js
{
  name: string,
  version: string,
  canActivate(config, context): boolean,
  enrich(artifacts, config, context): void
}
```

- **Location:** `extensions/*.mjs` (excluding dot-prefixed files).
- **Loading:** `runExtensions()` in `crystal.mjs` loads every `.mjs` file from `extensions/`.
- **Context:** extensions receive `context.manifest` and `context.rings` — they know which rings are active.
- **Graceful:** an error in one extension is caught and logged; the others continue.
- **Manifest:** `GET /api/v1/manifest` lists active extensions alongside rings.

The directory ships empty (`.gitkeep`). Zero changes to core are required to add an extension.

---

## Experience lift (`promote.mjs`)

Vertical knowledge promotion between layers:

```
Cortex (episodes from all sources, 7 days)
    ↓ deduplication + pattern extraction (≥ 2 similar records → pattern)
Core (lessons, facts — shared across all consumers)
    ↓ resonance weight (≥ 3 confirmations, ≥ 2 sources → law) + immune gate
Soul (wisdom — permanent, verified by multiple sources)
```

The Core → Soul gap is closed: `immune.mjs` verifies every promotion.

---

## Semantic cache

Located in `semantic-memory/semantic-cache.mjs`.

- **Model:** BGE-M3.
- **Parameters:** `MAX_DISTANCE = 250`, `TTL = 6 h`.
- **Full cycle:** `query → checkCache → HIT / MISS → deepSearch → storeCache → similar query → HIT`.

---

## Disaster recovery

```bash
# Quick rollback (seconds) — if a snapshot exists
rm -rf ./semantic-memory/data/lancedb/
cp -r ./snapshots/lancedb-YYYY-MM-DD ./semantic-memory/data/lancedb
systemctl --user restart submarine.service

# Full rebuild (10–15 min) — if no snapshot exists
rm -rf ./semantic-memory/data/lancedb/
node core/sync.mjs rebuild
# Rebuilds Soul from SOUL-JOURNAL, Core from CORE-JOURNAL, Cortex from CORTEX-JOURNAL,
# plus all markdown files from memory/

# After rebuild, run diagnostics:
node diagnose.mjs

# Embedding model change:
# 1. Update memory-engine.mjs → EMBED_MODEL, EMBED_DIM
# 2. rm -rf semantic-memory/data/lancedb/
# 3. node core/sync.mjs rebuild
# JOURNALs are permanent — rebuild recreates embeddings with any model.
```

---

## Data flow

```
INPUT (markdown files, HTTP API, host hooks)
  │
  ▼
sync.mjs → extractFacts() → routeToLayer()
  │
  ├─ [IMMUNE GATE] immune.mjs → 3-layer check (semantic, causality, growth)
  │    ├─ Soul   → immune vote → approved / rejected → Core fallback
  │    ├─ Core   → semantic + causality → approved / rejected → Cortex fallback
  │    └─ Cortex → free entry
  │    └─ data/immune-stats.json (fire-and-forget)
  │
  ├─ [CONTRADICTION] contradiction.mjs → detectContradictions()
  │    └─ Real IDs: sourceId = winner, targetId = superseded → causal.mjs
  │
  ├─ [BEHAVIORAL] extractCausalPatterns(text) → mergeBehavioralEdges()
  │    └─ regex patterns → `type: "behavioral"` edges in causal-graph.json
  │
  ├─ layers.mjs → Soul.add / Core.add / Cortex.add → LanceDB + JOURNAL
  │    └─ markCrystalDirty('record added to {layer}')
  │
  └─ generateCausalLinks() → causal.mjs (real recordId)

STORAGE
  ├─ LanceDB (memories table) — semantic index
  ├─ causal-graph.json — semantic + behavioral edges (atomic write)
  ├─ *-JOURNAL.md — permanent append-only logs
  └─ data/immune-stats.json — immune statistics

READ
  ├─ memory-engine.mjs → BGE-M3 embed → LanceDB search → [optional: sparse → reranker] → top-k
  ├─ layers.mjs → deepSearch(query, { skipRerank }) / unifiedSearch(query, limit, { skipRerank })
  ├─ rag.mjs    → RAG pipeline (layers + semantic cache)
  └─ crystal.mjs → 5-step pipeline → CONTEXT-CRYSTAL.md ($0)
         ├─ collectArtifacts() → Soul Essence + Focus + Now + Health + Synapse + Insights
         ├─ enrichWithRings() → Soul ↳ + Knowledge ↳ + Causality ↳ (3 rings, dynamic load)
         ├─ runExtensions()  → extensions/*.mjs
         ├─ formatCrystal()  → 6 sections + ring header + annotation counts
         └─ delta: crystal-prev-snapshot.json → "what changed"

CRYSTAL UPDATE (event-driven, crystal-update-controller.mjs)
  mutation → markCrystalDirty(reason) → 5 min debounce → regeneration
  safety cron: every 6 h regardless of changes

MAINTENANCE
  ├─ forgetting.mjs        → decay + archive (with immune gate for Core)
  ├─ contradiction-scan.mjs → scheduled batch pass, real IDs
  └─ promote.mjs           → Core → Soul promotion (with immune gate)
```

---

## Integrity guards

| Guard | Protects | Where |
|-------|----------|-------|
| **Soul Lock** | Soul is not modified by maintenance: forgetting skips it (threshold = ∞), contradiction does not write, immune does not write, Crystal does not write | `forgetting.mjs`, `layers.mjs` |
| **Immune Gate (write)** | Soul / Core records checked by immune before write | `sync.mjs`, `server.mjs`, `promote.mjs` |
| **Immune Gate (archive)** | Core records checked by immune before archival | `forgetting.mjs` |
| **Real IDs** | Causal edges reference real record IDs (no phantoms) | `sync.mjs`, `contradiction-scan.mjs` |
| **Null Guard** | `addRelation` rejects edges with null `sourceId` / `targetId` | `causal.mjs` |
| **Atomic Write** | `causal-graph.json` uses `tmp + rename` on every save | `causal.mjs` |
| **SQL Escape** | LanceDB `table.update()` values are wrapped in SQL single quotes | `server.mjs`, `forgetting.mjs` |
| **Fire-and-Forget Stats** | `immune-stats.json` writes are wrapped in try/catch, atomic, non-blocking | `immune.mjs` |

---

## Services

| Service | Port | Description |
|---------|------|-------------|
| **submarine** | 3100 | Node.js API and all modules |
| **reranker** | 3200 (`127.0.0.1`) | Python daemon: `bge-reranker-v2-m3` + BGE-M3 sparse. `ThreadingHTTPServer` for concurrent requests |
| **Ollama** | 11434 | BGE-M3 embedding model (required); other models optional |

Typical workflow after a code change:

```bash
systemctl --user restart submarine
```

The reranker daemon binds strictly to loopback (`127.0.0.1:3200`); it is not reachable from another host on the network.

---

## Tests

`npm test` runs `node test/smoke.mjs` — smoke tests across 8 categories, up to **49 assertions** at runtime (subject to environment: Ollama availability and causal-graph data affect two optional checks). Requires a running server on the configured port.

| Category | Assertions | What it checks |
|----------|-----------:|----------------|
| Config | 7 | default port, rings (soul / knowledge / causality), `update.mode`, manifest, paths |
| Ring contracts | 3 | `name`, `version`, `canActivate`, `enrich` exports per ring |
| Manifest module | 5 | block number, rings array, count, extensions array, version |
| Crystal controller | 5 | `markCrystalDirty`, `startController`, `stopController`, `status.dirty`, `status.running` |
| File structure | 13 | `core/crystal`, `rings/*`, manifest, adapters, extensions, `data/*`, README, CHANGELOG, ARCHITECTURE |
| Crystal output | 4 + 2 optional | header, Ring Coverage, ring status line, annotation counts (+ Soul / Path annotation presence) |
| API | 6 | `/health`, `/manifest`, `/memory/search`, `/synapse/active`, `/stats` |
| Behavioral edges | 6 | pattern extraction (RU / EN), no false positives, edge format, batch scan |

---

## v1.0.0 → v1.0.4 — Rings of Depth

- Three rings: **Soul** (Why) + **Knowledge** (What is known) + **Causality** (Where from).
- Manifest endpoint + extension slot (infrastructure for future extensions).
- Maturity score + auto-activation + graceful degradation.
- Event-driven Crystal generation (debounce 5 min, safety 6 h).
- Behavioral edges: regex-based pattern extraction, zero LLM, zero cost.
- `skipRerank` option for API search (dense-only path for low-latency calls).
- 51 / 51 smoke tests across 8 categories.

---
