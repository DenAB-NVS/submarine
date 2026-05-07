# semantic-memory

Semantic memory module for submarine. Built on LanceDB + BGE-M3 embeddings.

## Architecture

Three tables:
- `memories` — episodic records (facts, events, decisions)
- `knowledge` — distilled long-term knowledge
- `decisions` — architectural and operational decisions

## Search

Hybrid ranking:
1. Dense vector similarity (BGE-M3, 1024-dim, cosine)
2. Sparse lexical overlap (BM25 via BGE-M3 sparse weights)
3. Cross-encoder reranker (BAAI/bge-reranker-v2-m3) on top-K

## Files

- `memory-engine.mjs` — core: LanceDB connection, embeddings, search
- `semantic-cache.mjs` — query→response cache by semantic similarity
- `reranker-daemon.py` — Python HTTP service for reranker + sparse weights
- `migrate-bge-m3.mjs` — one-shot migration from 768-dim to 1024-dim
- `benchmark-models.mjs` — embedding model comparison
- `dedup-memories.mjs` — deduplicate memory records
- `heartbeat-sync.mjs` — periodic sync wrapper (for cron)
- `rag-context.mjs` — CLI wrapper for RAG context retrieval

## Requirements

- Node.js >= 18
- Python 3.10+ (for reranker daemon)
- Ollama running locally with `bge-m3` model pulled
- LanceDB (auto-installed via `@lancedb/lancedb` npm dependency)

## Quick start

Run the reranker daemon (required for hybrid search):

    python3 reranker-daemon.py

In another terminal:

    node memory-engine.mjs add "your memory content" fact 7

See `docs/QUICKSTART.md` for full setup.

## License

AGPL-3.0 — see `../LICENSE`.
