# submarine

> Sovereign, deeply-adaptive AI memory.
> Open source. Local-first. Yours.

---

## Memory depth decides everything

The depth of an AI agent's memory decides everything.

---

## What submarine is

submarine is a fully sovereign, open-source memory layer.

You control your data transparently, and you control its growth at the actual pace of competition.

Those who move to this standard first turn their data into an asset.

A personalized memory layer is not just the source of your effectiveness — it is what defines your position in the world today.

---

## The rules have changed

Those who own information no longer rule the world. The world is ruled by those who own time.

That is why submarine does not merely store or consolidate data. It makes your data deeply adaptive to the most competitive tempo in existence.

But that is not all.

The modules that generate depth and dynamics today are already several orders ahead of every current assumption about "how it should be" — and orders ahead of future competitors who have not yet realized what the standard is.

---

## Models are the engine. submarine is the car.

Any AI model receives only the context your architecture provides.

Models are the engine. Engines come and go. Your deep, dynamic memory stays with you.

Large corporations are beginning to see the problem of native memory and the shift underway in the market — but only at the level of noticing it. Their answer, user retention through native memory inside their own AI model, amounts to telling you: *keep your car in our garage.*

submarine absorbs that model with simple primitives — and only grows stronger in the process.

---

## Your life belongs to you

Your life and your work belong to you — not to corporations.

That is what submarine says.

And intellectual advantage is no longer on their side. They sell the engine. Whether they like it or not, the car is submarine. And the market is telling them the car will sit in your garage.

---

## The soil and the standard

We build unique modules of depth and adaptive dynamics for your memory. These solutions give you the exact advantage your competitor is looking for right now — or may have already found.

One way or another, the personalized memory layer is the new standard. The earlier you plant it, and the richer the soil, the more time ends up in your hands.

submarine is not just the richest soil. It is a new standard that not everyone understands yet. And if you are reading this, your data is most likely worth being first — because this is no longer a conversation about competition. This is natural selection and evolution.

In the beginning was the word.

And your data is worth being the beginning of something larger.

---

## What is actually inside

| Principle | What it means |
|---|---|
| **Sovereignty** | Your data lives on your hardware. Not "encrypted in our cloud." On your machine. |
| **Model-agnostic** | Not a feature of a model. A layer above models. Switch labs tomorrow — context comes with you. |
| **Zero marginal cost** | No LLM calls power the memory. Embeddings run locally. $0 per recall. |
| **Depth over volume** | Not trying to store more. Trying to understand more deeply. |
| **Embedded vector store** | LanceDB under the hood. Runs anywhere your code runs. No external service required. |

### Architecture at a glance

submarine organizes memory into three layers:

- **Soul** — Persistent context. Identity, principles, project constants. Does not decay.
- **Core** — How you work. Active decisions, open projects, evolving strategies.
- **Cortex** — What is happening. Operational facts of this week, this hour. Fades naturally.

The system generates a single document — the **Crystal** — that carries distilled context to any model. One file. Any model. Full depth.

### What makes it different

- **Causal ranking** — every decision is linked to where it came from
- **Contradiction detection** — notices when you change your mind, treats it as signal
- **Immune system** — protects load-bearing truths from careless overwrites
- **Purposeful forgetting** — the irrelevant fades, the important consolidates
- **Event-driven updates** — context refreshes on events, not schedules

### What this isn't

submarine is not a chat memory plugin, not a thread summariser, not a vector database wrapper. It is a layered cognitive substrate with immune gates, causal structure, and purposeful forgetting. The difference shows up over months of use, not in a single demo.

---

## Configuration

submarine organizes memory into layers. The top layer — Soul — holds persistent context that does not decay.

You define it in `SOUL.md`. This can be anything: your role, project context, team conventions, product principles — whatever should persist across every session.

A minimal example:

```md
# SOUL.md

Role: {your role or project context}

## Persistent context
- {fact or principle 1}
- {fact or principle 2}

## Preferences
{communication style, output format, constraints}
```

See `templates/SOUL-TEMPLATE.md` for a full structure, or design your own. The format is open.

---

## Quick start

### Requirements

- Node.js 22+
- [Ollama](https://ollama.com/) with the **bge-m3** embedding model (`ollama pull bge-m3`)
- ~200 MB disk space
- Any machine you own

### Install

```bash
git clone https://github.com/DenAB-NVS/submarine.git
cd submarine
npm install
```

### Configure

```bash
cp submarine.config.example.json submarine.config.json
# Edit config: set your embedding model, layer weights, server port
```

Authentication is **off by default**. If you want to require an API key, copy `.env.example` to `.env`, uncomment `SUBMARINE_API_KEY`, set a strong value, and include `-H "X-API-Key: <your-key>"` on every request below.

### Run

```bash
node index.mjs
```

submarine starts on port 3100 by default. Health check:

```bash
curl http://localhost:3100/api/v1/health
```

### First Crystal

```bash
curl http://localhost:3100/api/v1/crystal
```

Paste the Crystal into any model's system prompt or context window. The Crystal carries your full context to any model in a single document.

For detailed setup including prerequisites, API reference, and integration examples, see [docs/QUICKSTART.md](docs/QUICKSTART.md).


## Current state

| Metric | Value |
|---|---|
| Version | 1.0.5 |
| Tests | 46/46 structural passing (4 runtime tests require live data) |
| Memory layers | 3 active (Soul, Core, Cortex) |
| Embeddings | BGE-M3, local, 1024-dim |
| Efficiency gains | 21–37x on measured tasks (internal dynamic architecture — available to strategic partners under direct demonstration) |
| License | AGPL-3.0 |
| Cloud dependency | None |
| Cost per recall | $0 |

---

## Who is this for

- **Knowledge workers** tired of re-explaining themselves to every new AI session
- **Developers** who want a sovereign memory layer they control end-to-end
- **Teams** where accumulated context is a competitive advantage
- **Anyone** who believes the most personal dataset of their life should not be a guest in another company's house

---

## What we share — and what we keep

submarine is a complete, working foundation. Everything in this repository is production-ready, free, and yours to run. It is not a demo or a reduced version — it is a full system with its own integrity.

What you see here is not everything we have built.

Beyond this public foundation, we operate a deeper system — several orders of magnitude more capable along the dimensions that matter most: depth of memory, precision of recall, behavioral coherence across time. That system is not for public release. It is not for sale as a product.

We are direct about this because clarity matters more than marketing.

If you are building something where accumulated memory is the advantage, and the public foundation is not enough for what you are solving — we are open to strategic partnerships. Access to the deeper system comes through alignment, not through a checkout page.

Not clients. Not users. **Partners** — aligned with the direction this project is taking.

---

## License

submarine core is AGPL-3.0 — free, copyleft. Your modifications stay open. Your data stays yours.

Commercial extensions for proprietary integrations, closed-source forks, or enterprise SLAs are available under a separate licence. Contact via the email below.

---

## Contact

**D. Ashford** — Author of submarine
- Email: [ashford.dev@proton.me](mailto:ashford.dev@proton.me)
- Project: [causalmemory.org](https://causalmemory.org)

Strategic partnerships that align with the project's direction — the conversation starts here.

---

*submarine — sovereign AI memory. Open source. Local-first. Yours.*
