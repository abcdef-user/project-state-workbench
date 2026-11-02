# Project State Workbench

Project State Workbench keeps project state in a form that can survive between conversations. Tasks, acceptance criteria, decisions, artifact observations, and operation results live in a local SQLite-backed workspace. People inspect and edit that state in a browser workbench; AI clients register and read it through MCP tools.

It does not scan a folder and infer the whole project. Opening a directory only exposes whatever structured state has already been recorded for that workspace.

This repository integrates version `0.1.1`, with kernel `0.5.1` and Windows workbench `1.3.3`. This is an initial source release; interfaces may evolve.

## Quick Start

Node.js `24.2.0` or newer is required. The development environment was tested with `24.18.1`.

```powershell
npm ci --ignore-scripts
npm start
```

On Windows, `npm start` launches the local backend and opens the system browser at `127.0.0.1:8769` by default. You can also double-click `启动工作台.cmd`. The launcher avoids an occupied port and reuses an existing instance for the same data directory. If Node.js is missing, it reports the problem instead of downloading a runtime.

On other systems, run `npm run serve` in the foreground and open the URL printed by the process. The folder picker, desktop entry, and WSL integration remain Windows-specific; full cross-platform support is not claimed.

## Shared State for People and AI

The MCP entry point is:

```text
node server/src/mcp-server.js
```

Set `PROJECT_STATE_ROOT` to a stable state directory in the MCP host. The `storageRoot` in `workbench/workbench.json` must point to the same directory. Start from `workbench/workbench.example.json`; the live configuration is local and should not be committed. Differently configured copies may create separate databases, so do not assume they share records by default.

After the user explicitly enables sharing for the current conversation, an AI client calls `project_open_session`. The returned token is held in memory and scopes subsequent reads and writes; `project_close_session` ends that access. `actorId` labels a declared collaborator and is not an authenticated identity. The server also cannot establish that a model obtained genuine consent; that depends on host controls and collaboration discipline.

Available tools cover sessions, surface reads, batched updates, task claims and completion, artifact observations, operation results, decisions, and history. Batch calls reduce round trips, while version checks surface concurrent edits. See [AI collaboration](docs/ai-collaboration.md).

## Workbench and Storage

The workbench edits tasks, acceptance criteria, discussions and decisions, principles, and settings, and shows event history. It polls every 15 seconds while visible; it is not a push-based real-time system. It also exports a readable state mirror into the project directory. That mirror contains recorded content and remains private project data.

Each workspace has its own SQLite store for tasks, claims, decisions, file-hash observations, operation results, and event history. WSL processes use native Linux paths and their own database files; a combined view does not mean a shared database.

Optional read-only viewing can forward only the viewer port `8770` through Tailscale Serve. Never expose the editor port `8769`, and do not enable public Funnel by default. The viewer checks the user identity inserted by Serve, permits a GET whitelist, and blocks writes. The trust boundary is loopback plus correct Serve configuration, not cryptographic proof that every header came from Serve. Same-user local processes are not treated as an isolated adversary. TLS depends on the Serve setup.

## Privacy Boundaries

The software has no built-in cloud sync, model calls, API-key requirement, analytics telemetry, or third-party frontend CDN. Installing dependencies, using GitHub, and optionally using Tailscale still contact third parties. SQLite databases and logs are not encrypted at rest by default. Release source excludes user databases, chat logs, project directories, private configuration, accounts, real network addresses, bundled Node runtimes, and old installers.

Read [Privacy](PRIVACY.md), [Security](SECURITY.md), and [Private Viewing](docs/private-viewing.md) before exposing a workspace beyond the local machine.

## Repository Layout

```text
core/                Host-neutral SQLite kernel
server/              MCP stdio server and JSON CLI
dsh/                 Optional DeepSeek Harness adapter
workbench/app/       Local web workbench and Windows entry points
docs/                Usage, architecture, and collaboration notes
```

## Validation Status

On Windows, 65 core/MCP/real-Harness tests, 22 workbench checks and 19 read-only checks passed. The dependency audit reported no known vulnerabilities at check time. See [RELEASE_CHECKS.md](RELEASE_CHECKS.md) for limits and reproduction commands.

## More Documentation

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [AI collaboration](docs/ai-collaboration.md)
- [Private read-only viewing](docs/private-viewing.md)
- [Contributing](CONTRIBUTING.md)

The project uses the MIT license in `LICENSE`. Development is led by the user's organization with Codex and DeepSeek assistance; DeepSeek contributed to the frontend and documentation. This does not imply official partnership or security certification by Apple, OpenAI, DeepSeek, or Tailscale.


Use `npm run stop` to stop the verified instance for the configured data directory before changing its configuration. Restarting with `npm start` reuses a running instance. MCP responses may be forwarded by the AI host to its selected model provider; local persistence does not by itself keep AI context on-device. See [release checks](RELEASE_CHECKS.md) for the verified scope.
