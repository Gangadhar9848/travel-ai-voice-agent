# Architecture

1. [Components](#1-components)
2. [The agent loop](#2-the-agent-loop)
3. [Tools and data](#3-tools-and-data)
4. [Guardrails](#4-guardrails)
5. [Tracing and the Agent log](#5-tracing-and-the-agent-log)
6. [Tests (evals)](#6-tests-evals)
7. [Memory](#7-memory)
8. [Voice](#8-voice)
9. [Target: enterprise architecture on Azure](#9-target-enterprise-architecture-on-azure)

---

## 1. Components

```mermaid
flowchart TB
  subgraph Client["client/ · React (Vite, :5174)"]
    W["Welcome.jsx<br/>member login / guest"]
    C["Chat.jsx<br/>messages = parts: text | cards"]
    VC["voice.js<br/>AudioWorklet mic · playback"]
    LV["LogViewer.jsx"]
  end
  subgraph API["server/ · Express (:3002)"]
    IDX["index.js<br/>/api/chat · /api/identify · /api/logs · /api/memory · /api/quiz"]
    VB["voice.js<br/>/api/voice WebSocket"]
    TU["turn.js · runTurn()"]
    AG["agent.js · runAgent()"]
    LL["llm.js · streamChat()"]
    PR["prompts.js · buildSystemPrompt()"]
    GR["guardrails.js"]
    TR["trace.js"]
    ME["memory.js"]
    TL["tools/*"]
  end
  W --> IDX
  C -->|SSE| IDX
  VC -->|WebSocket| VB
  LV --> IDX
  IDX --> TU
  VB --> TU
  TU --> GR
  TU --> AG
  TU --> ME
  TU --> TR
  AG --> PR
  AG --> LL
  AG --> TL
  PR --> ME
```

The browser keeps the conversation and sends it with every message; the server is stateless
apart from logs and memory files. Cards never pass through the LLM: tools send them straight to the browser.

---

## 2. The agent loop

```mermaid
flowchart TD
  S["Build request:<br/>rulebook + conversation + tool menu"] --> L["Call gpt-6-luna (streaming)"]
  L --> D{"Reply type?"}
  D -->|text| E["Stream to customer · done"]
  D -->|tool call| G{"Loop guard:<br/>repeat? over 6 calls?"}
  G -->|blocked| N["Tell the LLM:<br/>use what you have"] --> L
  G -->|ok| R["Run the tool (our code)"]
  R --> U["Cards → browser"]
  R --> B["Result → conversation as role: tool"] --> L
```

- The LLM only **chooses** a tool and fills in its parameters (JSON Schema in `tools/index.js`).
- Our code **runs** the tool. At most 6 rounds per message.
- The rulebook (`prompts/*.md`, destination catalog, profile, memory) is sent with **every** request:
  the model keeps no state between calls.

---

## 3. Tools and data

| Tool | Reads | Returns |
|---|---|---|
| `show_mood_quiz` | quiz.json | 3 questions × 4 answers (card) |
| `match_destinations` | quiz.json, destinations.json, packages.json, profile | Top destinations with match %: Σ(mood weight × destination score), adjusted for season, budget, travel party and upcoming bookings |
| `search_packages` | packages.json | Hotels, stars, board, nights, price, availability |
| `find_flights` | flights.json | Flight departure dates (+ return date from nights) |
| `find_activities` | GetYourGuide `/1/tours` (fallback: packages.json) | Activities with photo, rating, price, link |

---

## 4. Guardrails

```mermaid
flowchart LR
  subgraph Input["Input guard — before the LLM"]
    I1["Rate limit<br/>20 / min"]
    I2["Card numbers<br/>pattern + Luhn → removed"]
    I3["Length<br/>max 1000 chars"]
  end
  subgraph Loop["Loop guard — in agent.js"]
    L1["Same tool + same args → blocked"]
    L2["Max 6 tool calls"]
  end
  subgraph Output["Output guard — before the customer"]
    O1["€ amounts must appear in tool results,<br/>conversation or memory"]
    O2["Other customers' IDs / emails → removed"]
    O3["Card numbers → removed"]
  end
  Input --> Loop --> Output
```

The md rules *ask* the model to behave; the guardrails *enforce* it in code. They are plain text checks —
no LLM, no tool calls. Text answers are corrected after streaming (`{replace}` event);
voice answers are checked before they are spoken. Limits are at the top of `guardrails.js`.

---

## 5. Tracing and the Agent log

One trace per customer turn, appended as one JSON line to `server/logs/YYYY-MM-DD.jsonl`:

```json
{ "channel": "voice", "conversation": "c_7f2a", "customer": "C00002 Anton",
  "input": "Show me hotels in Barcelona",
  "steps": [
    { "type": "llm",   "round": 1, "ms": 1200, "decision": "tool: search_packages" },
    { "type": "tool",  "name": "search_packages", "args": { "destination": "Barcelona" }, "ms": 8 },
    { "type": "llm",   "round": 2, "ms": 1800, "decision": "answer" },
    { "type": "guard", "name": "invented_price", "detail": "removed €199" }
  ],
  "tokens": { "total": 4830 }, "output": "…", "ms": 3100 }
```

Logs are for developers only — they are never sent back to the LLM.

---

## 6. Tests (evals)

```mermaid
flowchart LR
  C["evals/cases.json"] --> R["run-evals.js"]
  R --> T["runTurn()<br/>same path as customers"]
  T --> X["trace + answer"]
  X --> K{"compare with expect"}
  K --> P["✓ / ✗ + reason"]
  P --> F["evals/reports/*.json"]
```

Checks: `tools`, `anyTools`, `notTools`, `noTools`, `toolArgs`, `contains`, `notContains`, `containsAny`,
`containsAnyWord`, `maxRounds`, `maxSeconds`, `noInventedPrices`, `guards`, `noGuards`.
Cases with `"unit": "output"` test the output guard directly (no LLM, instant).
Tests never read or write real member memory.

---

## 7. Memory

```mermaid
sequenceDiagram
  participant C as Customer (member)
  participant T as runTurn()
  participant L as gpt-6-luna
  participant M as data/memory/C00002.json

  C->>T: message (conversationId c_7f2a)
  T->>M: load memory → last 3 past conversations + preferences
  T->>L: rulebook (incl. memory) + conversation
  L-->>T: answer
  T-->>C: answer
  T-)L: background: "update the summary" (no tools)
  L--)T: {summary, outcome, preferences}
  T-)M: save (max 5 conversations, retention 365 days)
```

Guests have no memory. `GET /api/memory/:id` shows it, `DELETE /api/memory/:id` erases it.

---

## 8. Voice

- Browser ⇄ `/api/voice` (our server) ⇄ `wss://<resource>/openai/v1/live/sessions` (gpt-live-1).
  The API key stays on the server.
- Audio: mono PCM16, 24 kHz, base64, about 100 ms chunks.
- Session start: instructions from `prompts/voice/live.md` + customer name, `delegation: { type: "client" }`.
- On `session.delegation.created`, the server runs `runTurn()` with `prompts/voice/backend-voice-mode.md`
  (short spoken answers), then sends `session.commentary.append` with the same `delegation_id`.
- Transcripts (`session.input_transcript.delta`, `session.output_transcript.delta`) become chat bubbles.

---

## 9. Target: enterprise architecture on Azure

How this prototype maps to a production setup. Not built — a roadmap.

```mermaid
flowchart LR
  U["Customers<br/>web · app · voice"] --> FD["Azure Front Door<br/>WAF"]
  FD --> SWA["Static Web Apps<br/>React client"]
  FD --> ACA["Container Apps<br/>agent API (many instances)"]

  subgraph Private["Private network (VNet + private endpoints)"]
    ACA --> APIM["API Management<br/>AI gateway: token quotas, logging, failover"]
    APIM --> F1["Foundry · gpt-6-luna<br/>EU region"]
    APIM --> F2["Foundry · backup region"]
    ACA --> LIVE["Foundry · gpt-live-1"]
    ACA --> CS["AI Content Safety<br/>prompt shields"]
    ACA --> COS[("Cosmos DB<br/>memory + sessions, TTL")]
    ACA --> SRCH["AI Search<br/>destination knowledge (RAG)"]
    ACA --> SYS["Booking systems<br/>booking · pricing · CDP"]
    ACA --> KV["Key Vault<br/>via Managed Identity"]
  end

  ACA -. OpenTelemetry .-> AI["Application Insights<br/>Foundry tracing"]
  GH["GitHub / Azure DevOps"] -->|CI/CD: tests + Foundry evals as a gate| ACA
  ENTRA["Entra ID / customer SSO"] --> FD
```

| Prototype | Enterprise |
|---|---|
| `.env` keys | Key Vault + Managed Identity |
| Direct Foundry calls | API Management AI gateway |
| JSON files | Booking & pricing APIs, Azure SQL / Cosmos DB, AI Search |
| Memory files | Cosmos DB (partition per customer, TTL retention, consent) |
| `.jsonl` logs | OpenTelemetry → Application Insights / Foundry tracing |
| Regex guardrails | Same checks + Azure AI Content Safety |
| `npm run eval` by hand | Foundry evaluations in CI/CD, release gate, production monitoring |
| md files on disk | Versioned prompts, reviewed via pull request or a central prompt store |
