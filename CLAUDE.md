# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build          # TypeScript composite build (all packages)
npm run dev            # Concurrent watch mode for core, teams, server, main
npm start              # Start queue processor (packages/main)

# Build individual packages
npm run build:core
npm run build:teams
npm run build:channels
npm run build:server
npm run build:visualizer

# Start individual channels
npm run discord
npm run telegram
npm run whatsapp

# Start services
npm run server         # API server standalone (port 3777)
npm run visualize      # TUI team visualizer
npm run chatroom       # TUI chatroom viewer

# TinyOffice (web portal) - run from tinyoffice/
cd tinyoffice && npm run dev    # Next.js dev server
cd tinyoffice && npm run build  # Production build
```

No test suite or linter is configured.

## Architecture

TypeScript monorepo using npm workspaces. All packages (except CLI and visualizer) use CommonJS; CLI and visualizer are ESM.

### Package Dependency Graph

```
channels ──→ core
cli ────────→ core
main ───────→ core, server, teams
server ─────→ core, teams
teams ──────→ core
visualizer   (standalone React Ink TUI)
tinyoffice   (standalone Next.js app, talks to server via REST/SSE)
```

### Message Flow

1. **Channel** receives message → enqueues to SQLite (`messages` table)
2. **Main processor** claims pending messages per agent (sequential per agent, parallel across agents)
3. Agent invoked via CLI subprocess (Claude Code, Codex, or OpenCode adapter)
4. Response parsed for team routing tags (`[@agent: msg]`, `[#team: msg]`)
5. Routed messages re-enqueued for target agents/teams
6. Responses written to `responses` table → channels poll and deliver

### Key Packages

- **core** (`packages/core/src/`) — Shared library: types, config, SQLite queue (WAL mode), agent invocation, adapters, plugin system, scheduling
- **main** (`packages/main/src/index.ts`) — Queue processor loop, agent invocation, team routing, heartbeat, graceful shutdown
- **teams** (`packages/teams/src/`) — Team collaboration: bracket tag parsing in `routing.ts`, conversation state, chat rooms
- **server** (`packages/server/src/`) — Hono REST API + SSE streaming on port 3777 (configurable via `TINYAGI_API_PORT`). Routes in `routes/` subdirectory
- **channels** (`packages/channels/src/`) — Discord (discord.js), Telegram (grammy), WhatsApp (whatsapp-web.js), Mattermost integrations
- **cli** (`packages/cli/`) — ESM CLI entry at `bin/tinyagi.mjs`, daemon management, agent/team/provider CRUD
- **visualizer** (`packages/visualizer/src/`) — React Ink TUI components

### Adapter System

Pluggable AI CLI adapters in `packages/core/src/adapters/`: `claude.ts`, `codex.ts`, `opencode.ts`. Each implements process spawning and response stream parsing for its respective CLI.

## Key File Locations

| Purpose | Path |
|---------|------|
| SQLite database | `~/.tinyagi/tinyagi.db` (WAL mode) |
| Settings | `~/.tinyagi/settings.json` |
| Queue logs | `~/.tinyagi/logs/queue.log` |
| Agent workspaces | `~/tinyagi-workspace/{agent_id}/` |
| Settings example | `settings.example.json` |
| Documentation | `docs/` (AGENTS, TEAMS, QUEUE, PLUGINS, SSE-EVENTS, etc.) |

## Configuration

Settings are in `settings.json` (not env vars). Key sections: `workspace`, `channels` (enabled list + per-channel config), `agents` (per-agent provider/model/working_directory), `teams` (agent lists + leader), `models` (API keys), `custom_providers`, `monitoring`.

Environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `TINYAGI_API_PORT`, `NEXT_PUBLIC_API_URL` (TinyOffice).

## Team Routing Syntax

Agents communicate via bracket tags in responses:
- `[@agent_id: message]` — route to specific agent
- `[#team_id: message]` — post to team chat room
- Text outside tags becomes shared context delivered to all mentioned agents
- Parsing logic in `packages/teams/src/routing.ts`

## Database Schema

Tables created programmatically at runtime (no migration files):
- `messages` — incoming queue (status: pending → processing → completed/dead, retries up to 5)
- `responses` — outgoing queue (status: pending → acked)
- `chat_messages` — team chat room history
- `agent_messages` — per-agent conversation archive
