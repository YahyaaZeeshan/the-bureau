# The Bureau

A virtual AI agent office where your digital team does your real work.
Walk around, click a character, talk to them, assign tasks, call meetings, take breaks — they're
wired to your actual tools (Jira, Zoom, web scraping, email, Hugging Face, GitHub, Spotify).

**Bring your own LLM** — works with Anthropic Claude, OpenAI GPT, Xiaomi MiMo, OpenRouter,
NVIDIA Nemotron, or any Anthropic-compatible API. Pick your provider and paste your API key in Settings.

## The Team

| Character | Role | Connected to | What they do |
|---|---|---|---|
| **Priya** | Project Manager | Jira, docs, web | Sprint planning, status updates, create/edit tickets, coordinate team |
| **Marco** | Research Analyst | Web scraping, GitHub, docs | Market research, competitor analysis, grant landscapes, technical surveys |
| **Dex** | Developer | HuggingFace, GitHub, shell, docs | Feasibility checks, prototype demos, model scouting |
| **Grace** | Outreach & Comms | Web scraping, email, docs | Find contacts, draft personalized emails, manage external communication |
| **Zola** | Personal Assistant | Zoom, Spotify, docs | Knowledge base, meeting notes, todos, morning briefs, office DJ |
| **You** | The Boss | — | Click the floor to walk, click characters to interact |

All agents share: a **knowledge base** (upload docs, PRDs, etc.), persistent **memory** (they learn
from you), **team chat** (they consult each other), per-agent **logs** and **workspaces**. Agents can
produce Word docs, spreadsheets, and presentations. Meetings have live **speech transcription** with
speaker diarization and auto-generated meeting notes.

## Quick Start

### Prerequisites

- **Node.js** 20+ (tested on 22/24)
- **ffmpeg** on PATH (for meeting transcription)
- An LLM API key (Anthropic, OpenAI, OpenRouter, MiMo, etc.)

### Install

```bash
git clone https://github.com/YOUR_USERNAME/the-bureau.git
cd the-bureau
npm install
cp .env.example .env      # edit .env for optional integrations
npm run dev                # starts server (4317) + web (5180)
```

Open **http://localhost:5180**.

### Configure your LLM

1. Click the **gear icon** in the top bar
2. Select your **Provider** (Anthropic, OpenAI, MiMo, OpenRouter, Nemotron, or Custom)
3. Paste your **API Key**
4. The Base URL and Model auto-fill from the preset (editable)
5. Click **Done** — agents are ready

No server restart needed. Switching providers takes effect immediately.

### Supported LLM Providers

| Provider | Base URL | Default Model | Notes |
|---|---|---|---|
| Anthropic Claude | (default) | claude-sonnet-4-20250514 | Direct API |
| OpenAI GPT | api.openai.com/v1 | gpt-4o | Via Anthropic SDK |
| Xiaomi MiMo | token-plan-sgp.xiaomimimo.com | mimo-v2.5-pro | Anthropic-compatible proxy |
| OpenRouter | openrouter.ai/api/v1 | anthropic/claude-sonnet-4 | Multi-model gateway |
| NVIDIA Nemotron | integrate.api.nvidia.com/v1 | llama-3.1-nemotron-70b | Sign up at build.nvidia.com |
| Custom | (you provide) | (you provide) | Any Anthropic-compatible endpoint |

## How to Use

- **Click the floor** — your avatar walks there (scroll = zoom)
- **Click a character** — chat, assign tasks, edit persona/tools/look, view logs
- **Meeting** — pick attendees, everyone walks to the meeting room. Use `@Name` to address one person
- **Recording** — record meetings with your mic, get AI-transcribed notes with speaker diarization
- **Break** — everyone heads to the break room for AI-powered chatter (Groq, near-free)
- **Panel** — Chat, Meeting, Knowledge Base, Inbox, Routines, Logs, Drafts, Team

### Approval Model

Reading is free; **acting needs you**. Creating/editing Jira issues, sending emails, writing
knowledge-base docs, cloning repos, and running shell commands all pop an approval toast.
Toggle auto-approve in Settings if you trust the agents fully.

## Optional Integrations (.env)

All integrations are optional. Missing credentials don't break anything — the agent just tells you what's not connected.

| Integration | Env Vars | Used by |
|---|---|---|
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Priya |
| Zoom | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | Zola |
| Email (SMTP) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Grace |
| Groq | `GROQ_API_KEY` (free at [console.groq.com](https://console.groq.com)) | Break-room chatter, fallback |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` + one-time auth | Zola (DJ, needs Premium) |
| HuggingFace | `HF_TOKEN` | Dex (model search) |
| GitHub | `GITHUB_TOKEN` | Dex, Marco (raises API rate limits) |

## Customizing Agents

### Edit in the UI

Double-click any character → **Edit**. Change their name, title, prompt, sprite, and toolsets. Changes take effect immediately.

### Add / Remove Agents

**Add**: POST to `/api/personas` with a persona JSON object.
**Remove**: DELETE to `/api/personas/:id`.

Or edit `data/personas.json` directly (restart server after manual edits).

### Agent Playbooks

Drop markdown files in `data/agent-docs/`:
- `_common.md` — rules all agents share
- `_project.md` — company/project context all agents see
- `<agent-id>.md` — per-agent playbook (e.g. `pm.md`, `researcher.md`)

### Per-Agent Toolsets

Available toolset tags: `jira`, `docs`, `web`, `scrape`, `email`, `hf`, `github`, `bash`, `zoom`, `spotify`, `reach`.

## Data Layout

```
knowledge-base/         shared docs — editable in UI, readable by all agents
data/logs/              per-agent JSONL activity logs
data/memory/            per-agent persistent memory
data/drafts/            email/document drafts
data/workspaces/        per-agent scratch directories
data/agent-docs/        agent playbooks (markdown)
data/personas.json      editable agent configs (also via UI)
data/settings.json      LLM provider + office settings
data/deliverables/      work products awaiting boss review
```

## Architecture

```
the-bureau/
  server/               Express + WebSocket backend (TypeScript, ESM)
    src/
      agents.ts          Agent runtime — session management, tool routing
      mimoAgent.ts       Anthropic SDK agent loop (works with any compatible API)
      settings.ts        Multi-provider LLM config + office settings
      meetings.ts        Meeting orchestration + auto-notes
      mimoTools.ts       Tool definitions (Jira, docs, web, email, etc.)
      sherpa.ts          Local STT + speaker diarization (sherpa-onnx)
      integrations.ts    Groq, web scraping, Zoom, email, HuggingFace
  web/                   React + Vite frontend
    src/
      game/              Pixel-art canvas engine (characters, pathfinding, rooms)
      ui/                React UI (TopBar, Dock, Chat, KB, Settings, etc.)
```

## License

MIT. Character sprites by [JIK-A-4 Metro City pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).
Inspired by [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents).
