# Quick Start Guide

From zero to a working Crystal in under 10 minutes.

---

## Prerequisites

### Node.js

Node.js 22+ is required.

```bash
node --version
# v22.x.x or higher
```

### Ollama (embedding engine)

submarine uses [Ollama](https://ollama.ai) to run embeddings locally. No cloud calls, no API keys, no cost per operation.

```bash
# Install Ollama (Linux)
curl -fsSL https://ollama.ai/install.sh | sh

# Pull the embedding model
ollama pull bge-m3

# Verify it works
curl http://localhost:11434/api/embeddings \
  -d '{"model":"bge-m3","prompt":"test"}'
```

You should see a JSON response with an `embedding` array. If Ollama is not running, start it with `ollama serve`.

---

## Setup

### 1. Install

```bash
git clone https://github.com/DenAB-NVS/submarine.git
cd submarine
npm install
```

### 2. Configure

```bash
cp submarine.config.example.json submarine.config.json
```

Key configuration fields:

| Field | Default | What it controls |
|---|---|---|
| `server.defaultPort` | `3100` | HTTP server port |
| `ollama.url` | `http://localhost:11434` | Ollama API address |
| `ollama.model` | `bge-m3` | Embedding model name |
| `embedding.dim` | `1024` | Embedding dimensions (must match model) |
| `layers.soul.weight` | `3` | Soul layer weight in search ranking |
| `layers.core.weight` | `2` | Core layer weight in search ranking |
| `layers.cortex.weight` | `1` | Cortex layer weight in search ranking |
| `search.minScore` | `0.3` | Minimum similarity score for results |

The defaults work out of the box. Edit only if you need a different port or embedding model.

### 3. Set up authentication (optional)

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Edit `.env` and set your API key:

```
SUBMARINE_API_KEY=your-secret-key-here
```

If `SUBMARINE_API_KEY` is set, every request must include the `X-API-Key` header. If left empty, authentication is disabled.

### 4. Start

```bash
node index.mjs
```

Verify the server is running:

```bash
curl http://localhost:3100/api/v1/health
```

You should see `"status": "ok"` with checks for Ollama, LanceDB, and layer counts.

---

## Your First Memory

### Define your persistent context

The Soul layer holds persistent context — role, principles, constraints. It never decays.

Create a `SOUL.md` file in your project root (see `templates/SOUL-TEMPLATE.md` for a full template):

```md
# SOUL.md

Role: Backend engineer at a fintech startup. Go + PostgreSQL.

## Persistent context
- Ship working software over perfect abstractions
- Data integrity is non-negotiable
- Clear communication over clever code

## Communication preferences
Direct, technical, no fluff. Prefer specifics over generalities.
```

Then write your persistent context to submarine:

```bash
curl -X POST http://localhost:3100/api/v1/memory \
  -H "Content-Type: application/json" \
  -d '{
    "layer": "soul",
    "text": "Role: backend engineer, distributed systems. Key principles: ship working software, data integrity above all."
  }'
```

### Write your first memories

**A decision** (goes to Core, persists):

```bash
curl -X POST http://localhost:3100/api/v1/memory \
  -H "Content-Type: application/json" \
  -d '{
    "layer": "core",
    "text": "We decided to use PostgreSQL for the main database after evaluating DynamoDB and CockroachDB",
    "category": "decision",
    "importance": 7
  }'
```

**A fact** (goes to Core):

```bash
curl -X POST http://localhost:3100/api/v1/memory \
  -H "Content-Type: application/json" \
  -d '{
    "layer": "core",
    "text": "Our team has 5 backend engineers, 2 frontend engineers, and 1 SRE",
    "category": "fact",
    "importance": 5
  }'
```

**An operational note** (goes to Cortex, fades after 7 days):

```bash
curl -X POST http://localhost:3100/api/v1/memory \
  -H "Content-Type: application/json" \
  -d '{
    "layer": "cortex",
    "text": "Sprint 14 started today. Focus is on the auth module rewrite and payment gateway integration."
  }'
```

Core categories: `fact`, `decision`, `lesson`, `technical`, `finance`, `infrastructure`.

Importance scale: 1 (trivial) to 10 (critical). Default is 5.

### Search your memory

```bash
curl "http://localhost:3100/api/v1/memory/search?q=database&limit=5"
```

Search supports two modes:

- `mode=simple` — direct semantic search within a single layer
- `mode=deep` — multi-layer search with enrichment (default for `layer=all`)

Filter by layer:

```bash
curl "http://localhost:3100/api/v1/memory/search?q=team&layer=core&limit=3"
```

---

## Generate Your Crystal

```bash
curl http://localhost:3100/api/v1/crystal
```

The Crystal is a structured document that distills your memory into a single context payload. It includes:

- **Soul Essence** — your persistent context and principles
- **Current Focus** — active threads and priorities
- **Operational Picture** — recent conversations and decisions
- **Health** — system state and memory statistics

Paste the Crystal output into any model's system prompt or context window. No vendor lock-in — the same Crystal works with Claude, GPT, Gemini, Llama, or any other model.

The Crystal updates automatically on events (memory writes, thread changes) with a 5-minute debounce. No cron jobs needed.

---

## API Reference

All endpoints are prefixed with `/api/v1`. Authentication via `X-API-Key` header when enabled.

### Memory

| Method | Path | Description |
|---|---|---|
| `POST` | `/memory` | Write a memory. Body: `{ layer, text, category?, importance?, metadata? }` |
| `GET` | `/memory/search` | Search memories. Params: `q` (required), `limit`, `layer`, `mode`, `causal`, `cluster`, `rerank` |
| `DELETE` | `/memory?id=<id>` | Soft-delete a memory (marks as inactive) |
| `POST` | `/memory/supersede` | Replace one memory with another. Body: `{ oldId, newId, reason? }` |
| `POST` | `/memory/archive` | Apply archival. Body: `{ apply?: boolean }` (default: dry-run) |
| `GET` | `/memory/archive` | Scan archival candidates (dry-run only) |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check — Ollama, LanceDB, layers, modules |
| `GET` | `/stats` | Layer statistics (record counts per layer) |
| `GET` | `/manifest` | System manifest and version info |

### Crystal

| Method | Path | Description |
|---|---|---|
| `GET` | `/crystal` | Generate a Crystal context document |

### Causal Graph

| Method | Path | Description |
|---|---|---|
| `POST` | `/causal/add` | Add a causal relation. Body: `{ sourceText, targetText, type, sourceId?, targetId? }` |
| `GET` | `/causal/stats` | Causal graph statistics |

Relation types: `causes`, `enables`, `prevents`, `correlates`, `supersedes`.

### Threads (Synapse)

Threads are live topics extracted automatically from memory writes.

| Method | Path | Description |
|---|---|---|
| `GET` | `/threads` | List threads. Params: `status` (open\|resolved\|archived\|all) |
| `GET` | `/synapse/active` | Get active threads only |
| `POST` | `/synapse/extract` | Extract threads from text. Body: `{ text, sessionLabel? }` |
| `POST` | `/synapse/weave` | Find threads related to a query. Body: `{ query, limit? }` |
| `POST` | `/synapse/resolve` | Resolve a thread. Body: `{ threadId, resolution? }` |
| `POST` | `/synapse/archive-stale` | Archive stale threads |

---

## What Happens Automatically

Once submarine is running, several systems work in the background:

- **Contradiction detection** — when you write a memory that contradicts an existing one, submarine detects it and creates a causal link. The newer memory supersedes the older one.
- **Immune system** — protects Soul from accidental overwrites. If you try to write something to Soul that conflicts with existing identity, the immune system may redirect it to Core or Cortex.
- **Purposeful forgetting** — Cortex entries decay over time (default: 7 days). Low-relevance memories fade. Important ones get promoted to Core through the experience elevator.
- **Thread extraction** — every memory write triggers automatic thread extraction via Synapse. Related topics are linked together.

---

## Integration Ideas

### Any REST client

submarine is a standard HTTP API. Use `curl`, Postman, `fetch`, or any HTTP library in any language.

### Shell script automation

```bash
#!/bin/bash
# Record a daily standup note
submarine_write() {
  curl -s -X POST http://localhost:3100/api/v1/memory \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $SUBMARINE_API_KEY" \
    -d "{\"layer\": \"cortex\", \"text\": \"$1\"}"
}

submarine_write "Standup: deployed auth module v2, starting payment gateway today"
```

### Claude Code hooks

Use a [Claude Code hook](https://docs.anthropic.com/en/docs/claude-code) to auto-record session summaries:

```bash
# In your hook script
curl -s -X POST http://localhost:3100/api/v1/memory \
  -H "Content-Type: application/json" \
  -d "{\"layer\": \"cortex\", \"text\": \"Session: $SESSION_SUMMARY\"}"
```

### System prompt injection

Generate a Crystal and inject it into any model's system prompt:

```bash
CRYSTAL=$(curl -s http://localhost:3100/api/v1/crystal)
# Pass $CRYSTAL as part of the system prompt to your model
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Health check shows `ollama: error` | Run `ollama serve` and verify `ollama list` shows `bge-m3` |
| `ECONNREFUSED` on port 3100 | Check if `node index.mjs` is running |
| Search returns empty results | Write some memories first, then search. Check `minScore` in config. |
| Immune system blocks a Soul write | This is by design. The immune system protects persistent context. Write to Core instead, or review the conflict. |
| Crystal is empty | You need at least a few memories across layers before Crystal can generate meaningful output. |
