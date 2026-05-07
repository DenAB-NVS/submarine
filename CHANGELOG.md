# Changelog

All notable changes to submarine are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.5] — 2026-04-23

### Changed
- README reorganized and tightened. Differentiator paragraph rewritten to
  describe submarine as a layered cognitive substrate with immune gates,
  causal structure, and purposeful forgetting — not a chat memory plugin or
  vector database wrapper. Licensing section clarified: AGPL-3.0 core plus
  a separate commercial licence for proprietary integrations, closed-source
  forks, and enterprise SLAs through KordinapsLab.
- Requirements now list Ollama and the bge-m3 embedding model explicitly,
  with a link to install instructions.
- Doctrine and config examples: product name normalized to lowercase
  "submarine" across documentation and configuration defaults. Dormant
  configuration keys removed from `submarine.config.example.json`.

### Fixed
- `search.maxDistance` is now read from configuration (`search.maxDistance`,
  default 800) instead of a hardcoded constant in `semantic-memory/memory-engine.mjs`.
- Smoke test suite separates structural checks from runtime checks that
  require accumulated data. A Unicode arrow mismatch in the causal-pattern
  test was corrected.

### Removed
- `@version` annotations removed from source files. The single source of
  truth for the running version is `package.json` and the `/api/v1/manifest`
  endpoint.

### Notes
- Test count reflects the structural suite only — runtime tests live in a
  separate, skippable group that needs a populated SOUL.md, causal graph,
  and immune statistics. The earlier "51/51" figure from 1.0.2 mixed both
  groups; 1.0.4 split them, and 1.0.5 leaves the split in place.
- No public-API changes. No on-disk data-format changes.

### Verified
- Structural smoke tests 46/46 on clean checkout with default config
  (Ollama + bge-m3).
- Health, stats, manifest, and crystal endpoints all return 200.
- `npm test` green.

---

## [1.0.4] — 2026-04-18

### Fixed
- `handleDeleteMemory()` in server — SQL-escape for LanceDB `table.update()` values.

### Changed
- Integrity self-check is temporarily removed from `diagnose.mjs`. The public
  build ships a 9-test diagnostic suite without the integrity stage while the
  internal tuning methodology is recalibrated.

### Notes
- No changes to the public API or on-disk data format.
- Diagnostics run end-to-end without timeouts introduced by the removed stage.

### Verified
- Structural smoke tests 46/46 on clean checkout with default config (Ollama + bge-m3).
- 4 runtime tests skipped on fresh clone (require accumulated SOUL.md, causal graph, immune stats).
- Health, stats, manifest, crystal endpoints all return 200.
- search.maxDistance wired to config (defaults to 800).

---

## [1.0.3] — 2026-04-18

### Security
- **Reranker daemon no longer binds to `0.0.0.0`.** Bind address is now
  `127.0.0.1:3200` — the reranker is strictly local and cannot be reached from
  another host on the network. Users running submarine under WSL should pull
  this release.

### Changed
- Memory engine — rerank and sparse timeouts raised from 5s to 10s to
  accommodate ARM64 CPUs where the reranker processes roughly 20 documents
  in about five seconds.

### Verified
- Services active, ports bound to loopback, health check OK, smoke tests 44/44.

---

## [1.0.2] — 2026-04-18

### Added
- **Behavioral edges — pattern-based causality (zero-LLM).**
  - `extractCausalPatterns(text)` in `src/causal.mjs` — 12 regex patterns
    (6 Russian + 6 English). Markers include `->`, `because`, `due to`,
    `led to`, `consequence`, `decided`, `therefore`, `resulted in`,
    `caused by`. Each extraction returns `{ cause, effect, marker }` —
    verifiable against the source text.
  - `createBehavioralEdge()` — edge format with `type: "behavioral"`,
    `evidence`, `confidence: 1.0`.
  - `scanForBehavioralEdges(records)` — batch extraction over a record set.
  - `mergeBehavioralEdges(edges)` — deduplicated merge into the causal graph.
  - `scripts/scan-behavioral.mjs` — one-shot scanner for existing records.
- Sync pipeline now scans new records for causal patterns automatically.

### Changed
- `rings/causality.mjs` — behavioral edges are prioritized over semantic
  edges during chain traversal.

### Notes
- Zero LLM calls, zero cost, verifiable evidence in every edge.
- Initial scan across existing records produced 301 behavioral edges,
  bringing the causal graph to 982 edges (681 semantic + 301 behavioral).

### Verified
- Smoke tests 51/51. Crystal generation OK. Causality ring active with the
  expanded edge set.

---

## [1.0.1] — 2026-04-18

### Added
- **Real liveness check in the `/health` endpoint.** The handler now issues
  a `countRows()` against LanceDB with a 5-second timeout instead of
  reporting "ok" purely from process state.
  - `health: "ok"` — LanceDB reachable, Ollama OK, layers OK.
  - `health: "degraded"` — search path is down (LanceDB timeout or error),
    other components may still be alive.
  - Response includes `lancedb.rows` for external monitoring.

### Fixed
- Cold-start path: after several idle hours the reranker's two endpoints
  could each consume their full timeout, producing a visible dense-search
  latency spike while the underlying store remained healthy. The liveness
  check above distinguishes the two cases.

### Verified
- Dense search: 5 results in 8 seconds on a warm reranker.
- Smoke tests 45/45.

---

## [1.0.0] — 2026-04-17

**Block 1: Rings of Depth.** First tagged release of submarine as a
self-contained public package.

### Added
- **Three-ring enrichment pipeline.** Crystal generation now runs through
  a contract-driven ring system rather than a monolithic function. Each
  ring implements `name`, `version`, `canActivate(config, context)`,
  `enrich(artifacts, config, context)`.
  - **Soul ring** (`rings/soul.mjs`) — soul resonance via local BGE-M3
    embeddings. Threshold configurable at `rings.soul.threshold`.
  - **Knowledge ring** (`rings/knowledge.mjs`) — Core-layer search over
    the local HTTP API, filtered by category (decision, lesson, fact,
    technical) with a self-citation filter.
  - **Causality ring** (`rings/causality.mjs`) — chain traversal over
    `data/causal-graph.json`, inserting `↳ Causality:` annotations into
    the Crystal. Graph cache with 60-second TTL.
- **Event-driven Crystal controller** (`core/crystal-update-controller.mjs`).
  Regeneration is triggered by mutation events instead of a fixed schedule:
  layer writes, synapse resolution, causal edge addition, supersession,
  archival. Debounce 5 min (configurable), 60-second check interval,
  6-hour safety interval, mutex on generation.
- **Manifest endpoint** — `GET /api/v1/manifest` returns the block, version,
  enabled rings, extensions, and update channel.
- **Extension slot** — `.mjs` files dropped into `extensions/` follow the
  ring contract and are loaded automatically. Extensions receive the
  active-rings context and degrade gracefully on error.
- **Ring coverage score** in Crystal output — per-ring annotation counts
  plus overall coverage percentage. Emitted in both the Crystal header
  and the Health section.
- **Smoke test suite** — `test/smoke.mjs`, 45 assertions across 7 categories
  (Config, Ring Contracts, Manifest, Controller, File Structure, Crystal
  Output, API). `npm test` runs the suite.
- `templates/SOUL-TEMPLATE.md` — starter template for SOUL.md.

### Changed
- `core/crystal.mjs` — monolithic `generateCrystal()` decomposed into a
  five-step pipeline: `collectArtifacts` → `enrichWithRings` →
  `runExtensions` → `formatCrystal` → write.
- Build functions (`buildFocusBlock`, `buildFreshInsightsBlock`) now
  return `{ lines, soulItems }`; soul enrichment lives in
  `enrichWithRings()` rather than inside each build function.
- CLI guard (`process.argv[1] === __filename`) so that importing the
  module no longer triggers Crystal generation.
- Configuration centralization: every module now reads from
  `src/config.mjs` (singleton loader) instead of hardcoded values.
  Pattern: `getConfig().section?.key || fallback`.

### Reranker stabilization (landed during Block 1)
- `reranker-daemon.py` — `HTTPServer` → `ThreadingHTTPServer` so that
  parallel `/rerank` and `/sparse` requests no longer serialize.
- Memory engine — rerank timeout 3s → 30s (CPU-bound reranking on
  15–20 documents).
- `buildRingContext()` health timeout 5s → 15s (the submarine health path
  includes an Ollama ping and can take ~5s on a cold start).
- Default `rings.knowledge.minScore` 0.5 → 0.4 (CPU reranker produces
  scores in the 0.45–0.50 band without the GPU boost).

### Notes
- Extensions directory is shipped empty (`.gitkeep`). Zero changes to core
  are required to add one.
- Crystal continues to degrade gracefully: disable any ring via config and
  its annotations simply disappear.

---

## [0.5.x] — 2026-03 to 2026-04

Pre-1.0 series. Major milestones during this period:

- **0.5.1** — Embedding migration from nomic-embed-text to BGE-M3
  F16 1024-dim. Reranker daemon introduced. Hybrid search
  (dense + sparse).
- **0.5.2** — Architecture audit. Synapse dimension fix (768 → 1024).
  Gateway moved into systemd.
- **0.5.3** — Immune system v2.1.0. Context optimization reducing
  Crystal payload from 117 KB to 46 KB. Semantic cache fix.
  Long cache retention.
- **0.5.4** — Reranker restored after the migration. Git autocommit
  for SOUL/CLAUDE. Post-update verification.
- **0.5.5** — Claude Code integration. Hooks system.
- **0.5.7** — `contradiction.mjs` v1.0. Immune system wired into the
  main server. Ralph-loop.
- **0.5.8** — Crystal Block 1 prototype. Synapse integration. Soul
  resonance via direct embedding.

---

## [0.5.0] — 2026-03-31

### Added
- **Purposeful forgetting** — decay, supersede, and archive lifecycle
  for records.
- **Synapse** — cross-session bridge between related records.
- `crystal.mjs` — initial Crystal generator.

---

## [0.4.0] — 2026-03-26

Initial release. Four-pass search, cluster filter, sanitize filter,
causal graph, resilient episodes. P001–P016 feature set.

---
