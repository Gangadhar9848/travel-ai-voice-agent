# Holiday Assistant — AI travel agent (voice + text)

A prototype AI travel agent that helps customers find and book **flight + hotel packages** and
**activities**, by chat or by voice. It reads the customer's mood, matches destinations with real
scoring data, searches packages and flights, adds GetYourGuide activities, and remembers members
between visits.

> **Prototype / learning project.** The repository contains no customer data and no API keys.

| | |
|---|---|
| **Front end** | React (Vite) — chat, mood quiz, cards, 🎤 voice, Agent log page |
| **Back end** | Node.js (Express) — agent loop, tools, guardrails, tracing, memory |
| **Brain** | `gpt-6-luna` on Microsoft Foundry (OpenAI-compatible Chat Completions, tool calling) |
| **Voice** | `gpt-live-1` on Microsoft Foundry (full-duplex voice, client delegation) |
| **Activities** | GetYourGuide Partner API |
| **Data** | Excel workbook → JSON (customers, destinations, packages, flights, mood quiz) |

---

## Architecture

### System overview

```mermaid
flowchart LR
  subgraph Browser["Browser · React"]
    UI["Chat window<br/>cards · quiz · captions"]
    MIC["🎤 Mic + speaker<br/>PCM16 24 kHz"]
    LOG["Agent log page<br/>#log"]
  end

  subgraph Server["Node server"]
    CHAT["/api/chat<br/>SSE stream"]
    VOICE["/api/voice<br/>WebSocket bridge"]
    TURN["runTurn()<br/>one customer turn"]
    AGENT["runAgent()<br/>LLM → tools → LLM"]
    TOOLS["Tools<br/>quiz · matchmaker · packages<br/>flights · activities"]
    RULES["Rulebook<br/>prompts/*.md + profile + memory"]
    GUARD["Guardrails"]
    TRACE["Tracer"]
    MEM["Memory"]
    DATA[("JSON data<br/>from Excel")]
  end

  subgraph Cloud["Cloud"]
    LUNA["Foundry<br/>gpt-6-luna"]
    LIVE["Foundry<br/>gpt-live-1"]
    GYG["GetYourGuide API"]
  end

  UI -->|typed message| CHAT --> TURN
  MIC <-->|audio| VOICE <-->|audio + delegation| LIVE
  VOICE -->|delegated request| TURN
  TURN --> GUARD
  TURN --> AGENT
  AGENT --> RULES
  AGENT <-->|stream + tool calls| LUNA
  AGENT --> TOOLS --> DATA
  TOOLS --> GYG
  TURN --> TRACE --> LOG
  TURN --> MEM
```

### One turn: what happens to a message

Every message — typed, spoken or from the test runner — goes through the same `runTurn()`:

```mermaid
flowchart LR
  IN["Customer message"] --> G1["Input guard<br/>card numbers · length · rate limit"]
  G1 --> A["runAgent()<br/>loop guard: no repeats, max 6 tool calls"]
  A <--> L["gpt-6-luna"]
  A <--> T["Tools"]
  A --> G2["Output guard<br/>invented prices · other customers' data · cards"]
  G2 --> OUT["Answer<br/>text or speech"]
  G2 -. background .-> M["Memory update<br/>luna writes a summary"]
  G1 & A & G2 -. every step .-> TR["Trace → logs + Agent log"]
```

### Typed message (text chat)

```mermaid
sequenceDiagram
  participant B as Browser
  participant S as Node server
  participant L as gpt-6-luna
  participant T as Tools / data

  B->>S: POST /api/chat (conversation + customerId + conversationId)
  S->>S: input guard, build rulebook (md files + catalog + profile + memory)
  S->>L: rulebook + conversation + tool menu (stream)
  L-->>S: tool call: search_packages({destination:"Barcelona", nights:4})
  S->>T: run the tool (filter packages.json)
  S-->>B: {ui: package cards}
  S->>L: same conversation + tool result
  L-->>S: text answer (streamed)
  S-->>B: {token} … word by word
  S->>S: output guard, trace saved, memory updated in background
```

### Spoken message (voice, client delegation)

GPT-Live-1 is the ears and the voice. It cannot call tools, so it **delegates** to the same agent
used by the text chat:

```mermaid
sequenceDiagram
  participant B as Browser 🎤
  participant S as Node server
  participant V as gpt-live-1
  participant A as runTurn() + luna + tools

  B->>S: audio chunks (WebSocket /api/voice)
  S->>V: session.input_audio.append
  V-->>S: session.input_transcript.delta ("hotels in Barcelona")
  V-->>S: says "let me check…" + session.delegation.created {id}
  S->>A: transcript so far (voice mode: short spoken answers)
  A-->>B: cards on screen
  A-->>S: answer text
  S->>V: session.commentary.append {delegation_id, content}
  V-->>S: session.output_audio.delta + output_transcript.delta
  S-->>B: speech + captions
```

### Data pipeline

```mermaid
flowchart LR
  X["Excel workbook<br/>server/data/raw/*.xlsx"] -->|npm run import| J[("JSON files<br/>customers · destinations<br/>packages · flights · quiz")]
  J --> C["Login + profile"]
  J --> M["match_destinations<br/>quiz weights × destination scores"]
  J --> P["search_packages / find_flights"]
  J --> R["Destination catalog<br/>in the rulebook"]
```

More diagrams, including a target **enterprise architecture on Azure**, are in
[docs/architecture.md](docs/architecture.md).

---

## Agent harness

Everything around the model that makes it reliable:

| Part | File | What it does |
|---|---|---|
| **Rulebook** | `server/prompts/*.md` | Persona, mood, booking flow, rules, member vs guest, when to use which tool. Re-read on every message — edit and save, no restart. |
| **Tools** | `server/src/tools/` | `show_mood_quiz`, `match_destinations`, `search_packages`, `find_flights`, `find_activities` |
| **Agent loop** | `server/src/agent.js` | Calls the LLM, runs requested tools, feeds results back, repeats (max 6 rounds) |
| **Tracing** | `server/src/trace.js` | Records every LLM round, tool call, guardrail and token count → `server/logs/*.jsonl` + Agent log page |
| **Tests (evals)** | `server/evals/cases.json`, `server/scripts/run-evals.js` | Test conversations checked automatically: tool choice, arguments, wording, no invented prices, guardrails, memory |
| **Guardrails** | `server/src/guardrails.js`, `server/src/turn.js` | Input: card numbers removed, length cut, rate limit. Loop: no repeated or excess tool calls. Output: invented prices, other customers' data and card numbers removed. |
| **Memory** | `server/src/memory.js` | Members only: luna keeps a short summary per conversation; the last 3 are added to the rulebook on the next visit. `GET/DELETE /api/memory/:id`. |

---

## Getting started

**Requirements:** Node.js 18+, a Microsoft Foundry (or OpenAI-compatible) deployment with tool calling,
optionally a `gpt-live-1` deployment for voice and a GetYourGuide API key.

```bash
git clone <this repo>
cd travel-ai-voice-agent
npm run install:all
cp server/.env.example server/.env     # then fill in your endpoints and keys
```

**Data:** put your Excel workbook in `server/data/raw/` and run

```bash
npm --prefix server run import
```

Without it, the app starts with two made-up sample customers (`C90001`, `C90002`) but no packages or
flights. The workbook needs the sheets `Customer_Data`, `booking_data`, `Destination_Master`,
`Holiday_Inventory`, `Flight_Inventory` and `Quiz_Attribute_Mapping`.

**Run** (from the project folder — starts server and client):

```bash
npm run dev
```

Open http://localhost:5174 · Agent log: http://localhost:5174/#log · Health: http://localhost:3002/api/health

### Configuration (`server/.env`)

| Variable | Meaning |
|---|---|
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | The brain (e.g. `https://<resource>.openai.azure.com/openai/v1`, `gpt-6-luna`) |
| `LLM_REASONING_EFFORT` | `none` — required by some models to use tools on `/chat/completions` |
| `LIVE_ENDPOINT`, `LIVE_API_KEY`, `LIVE_MODEL`, `LIVE_VOICE` | Voice (`gpt-live-1`) |
| `GYG_API_KEY`, `GYG_LANGUAGE`, `GYG_CURRENCY` | GetYourGuide activities (falls back to package data without a key) |
| `MEMORY_RETENTION_DAYS` | How long member memory is kept (default 365) |

### Scripts

| Command | Where | What |
|---|---|---|
| `npm run dev` | project folder | Start server + client |
| `npm run eval` | `server/` | Run all test conversations (`-- member` to filter, `--repeat 3` to repeat) |
| `npm run import` | `server/` | Excel → JSON |

---

## Project structure

```
travel-ai-voice-agent/
├── client/                    React app (port 5174)
│   └── src/
│       ├── Welcome.jsx        login (email / customer ID) or guest
│       ├── Chat.jsx           chat, cards, 🎤 voice, conversation ID
│       ├── voice.js           mic capture + audio playback
│       ├── LogViewer.jsx      Agent log (#log)
│       └── cards/             quiz, matches, packages, activities
├── server/                    Node API (port 3002)
│   ├── prompts/               the rulebook (md) + voice/ rules
│   ├── src/
│   │   ├── index.js           routes: /api/chat, /api/logs, /api/memory, /api/identify
│   │   ├── voice.js           GPT-Live-1 bridge + delegation
│   │   ├── turn.js            one turn: guards → agent → guards → memory
│   │   ├── agent.js           agent loop + loop guard
│   │   ├── llm.js             streaming Chat Completions client
│   │   ├── guardrails.js      input / output checks
│   │   ├── trace.js           tracer
│   │   ├── memory.js          member memory
│   │   └── tools/             tool definitions + implementations
│   ├── evals/cases.json       test conversations
│   ├── scripts/               import-excel.js, run-evals.js
│   └── data/                  JSON data (generated, not committed) + raw/
└── docs/architecture.md       diagrams incl. enterprise target on Azure
```

---

## Security and privacy notes

- **Never commit `server/.env`.** It is in `.gitignore`.
- Logs (`server/logs/`) and member memory (`server/data/memory/`) contain personal data and are not committed.
  Before real use: retention limits, access control, consent and a privacy review (GDPR).
- Card numbers are removed before they reach the LLM or the logs, but payments must never happen in the chat.
- The login is a demo (email or customer ID, no password). A real deployment needs proper authentication.
