# TripMate AI — Multi-Agent Travel Planner

A travel-planning assistant built as a **multi-agent system with LangGraph**. A supervisor agent checks each request with an input guardrail, routes it to specialist agents (flights, hotels, weather, budget) that use live tools through **MCP**, and an itinerary agent writes a draft. A **human-in-the-loop** step pauses the graph so you can approve the draft or ask for changes, as many times as you like, before the final plan is written. Progress is saved in **PostgreSQL**, so a paused plan survives page reloads and server restarts.

## Features

- **Supervisor + guardrail**: blocks non-travel or harmful requests and picks only the agents a request needs.
- **Specialist agents with live data (MCP)**
  - Flights: AviationStack live departure board (free plan friendly)
  - Hotels: Tavily web search
  - Weather: custom OpenWeather MCP server (`custom_weather_mcp_server.py`)
  - Budget: cost breakdown and feasibility check
- **Human-in-the-loop**: approve the draft, or request changes and review the revision again.
- **LLM fallback chain** ([llm_chain.py](llm_chain.py)): Groq `gpt-oss-120b` → `gpt-oss-20b` → `qwen3.8-27b` → local Ollama `qwen3:8b` → `llama3.2:3b`. If a model is rate-limited or fails, the next one answers; with no internet LLM, it runs fully local.
- **Persistent threads**: LangGraph PostgreSQL checkpointer (Supabase or any Postgres).
- **Web app**: FastAPI + a responsive, accessible UI with light/dark themes, live status, plan table of contents, agent research tabs, copy and PDF export.

## Architecture

```
            ┌──────────────┐
 request ──▶│  Supervisor  │── blocked ──▶ guardrail response
            │ + guardrail  │
            └──────┬───────┘
                   │ selected agents
   ┌───────────┬───┴────────┬────────────┐
   ▼           ▼            ▼            ▼
 Flights     Hotels      Weather      Budget        (MCP tools)
   └───────────┴─────┬──────┴────────────┘
                     ▼
              Itinerary agent ──▶ Human approval ──approve──▶ Final agent
                     ▲                  │
                     └──── revise ──────┘
```

## Tech stack

Python 3.11 · LangGraph · LangChain · MCP (`langchain-mcp-adapters`) · Groq · Ollama · FastAPI · PostgreSQL (`langgraph-checkpoint-postgres`, `psycopg_pool`) · vanilla JS/CSS frontend

## Getting started

### 1. Requirements

- **Python 3.11** (the version used by the Dockerfile)
- A **PostgreSQL** database: a free [Supabase](https://supabase.com) project, or local Postgres in Docker
- Optional: [Ollama](https://ollama.com) for local fallback models (`ollama pull qwen3:8b` and `ollama pull llama3.2:3b`)

### 2. Install

```powershell
py -3.11 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt uv
```

(`uv` provides `uvx`, which the flight agent uses to launch the AviationStack MCP server.)

### 3. Configure

Copy the template and fill in your keys:

```powershell
Copy-Item .env.example .env
```

| Variable | Used by | Get it from |
|---|---|---|
| `GROQ_API_KEY` | All agents (cloud LLMs) | https://console.groq.com/keys |
| `DATABASE_URL` | Saving plan progress | Supabase → **Connect** → **Session pooler** URI, or local Postgres |
| `TAVILY_API_KEY` | Hotel agent | https://app.tavily.com |
| `AVIATION_STACK_API_KEY` | Flight agent | https://aviationstack.com/signup/free |
| `OPENWEATHER_API_KEY` | Weather agent | https://home.openweathermap.org/api_keys |

Optional: `GROQ_MODELS`, `OLLAMA_MODELS`, `OLLAMA_BASE_URL` change the model fallback order (see [.env.example](.env.example)).

**Database notes**

- With Supabase, use the **Session pooler** connection string (port 5432). The direct connection is IPv6-only on the free plan.
- Some networks (college/office Wi-Fi) block database ports 5432/6543. If the app can't connect, try another network.
- Local Postgres in Docker:
  ```powershell
  docker run -d --name tripmate-db -e POSTGRES_USER=tripmate -e POSTGRES_PASSWORD=tripmate -e POSTGRES_DB=tripmate -p 5432:5432 postgres:17
  ```
  then `DATABASE_URL=postgresql://tripmate:tripmate@localhost:5432/tripmate`.

The app creates its tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`) on first start.

### 4. Run

```powershell
.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000.

### Docker

```powershell
docker build -t tripmate-ai .
docker run --env-file .env -p 8000:8000 tripmate-ai
```

Secrets are passed at runtime and never copied into the image. To reach a database on your own machine from the container, use `host.docker.internal` instead of `localhost` in `DATABASE_URL`.

## API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/travel` | Start a new plan. Body: `{ "message": "..." }`. Returns a draft awaiting approval. |
| `POST` | `/api/travel/approve` | Body: `{ "thread_id": "...", "approved": true }` for the final plan, or `{ "approved": false, "feedback": "..." }` for a revised draft. |
| `GET` | `/api/travel/{thread_id}` | Current state of a plan, including a draft still awaiting approval. |
| `GET` | `/health` | Status and the active LLM fallback chain. |

## Project structure

```
app.py                       FastAPI app and API routes
backend.py                   LangGraph graph: supervisor, agents, HITL, checkpointer
llm_chain.py                 LLM fallback chain (Groq → Ollama)
mcp_client.py                MCP client for Tavily, AviationStack and weather tools
custom_weather_mcp_server.py OpenWeather MCP server (started automatically over stdio)
templates/index.html         Page markup
static/style.css             Design system and styles
static/script.js             Frontend logic
Dockerfile, .dockerignore    Container build
.env.example                 Configuration template
```

## Free-tier notes

- **Groq** free tier allows about 8,000 tokens per minute per model. Prompts are kept compact, and the fallback chain moves to the next model when one is rate-limited.
- **AviationStack** free plan allows 100 requests per month and only the live departure board. Each plan uses one request; when the quota is used up, the flight agent clearly falls back to general guidance.
- AI plans can contain mistakes. Check prices, schedules and visa rules before booking.

## Acknowledgements

Built on an open-source prototype by [entbappy](https://github.com/entbappy/Multi-Agent-System-using-LangGraph-MCP-Supervisor-Guardrails-HITL), used under the Apache License 2.0 ([LICENSE](LICENSE)).
