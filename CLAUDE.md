# Claudito - Project Context

Claude Code intelligent agent manager - TypeScript HTTP server with jQuery + Tailwind.css UI. Features Ralph Loop iterative development pattern and roadmap-based automation.

## Project Structure

```
src/
  index.ts          # Entry point (config + server instantiation only)
  config/           # Configuration loading
  server/           # Express server + WebSocket integration
  routes/           # API route handlers
  services/         # Business logic (ProjectService, RoadmapParser, InstructionGenerator, ClaudeOptimizationService)
  repositories/     # Data persistence (Project, Conversation, Settings)
  agents/           # Agent management (Agent interface, ClaudeBinary, AnthropicSdkAgent, OpencodeAgent, AgentManager)
  websocket/        # WebSocket server for real-time updates
  utils/            # Logger, error handling, retry utilities
public/
  vendor/           # Third-party assets (jQuery, Tailwind - NO CDN)
  js/               # Frontend JavaScript with WebSocket client
  css/              # Custom styles
test/
  unit/             # Unit tests
doc/
  ROADMAP.md        # Project milestones
  MERMAID_EXAMPLES.md # Mermaid.js diagram examples and reference
```

## Data Storage Structure

All data lives under `CLAUDITO_HOME` (defaults to `$HOME/.claudito/`). Project data
is centralized here — **not** in the project root — so several instances can share a
project path without fighting over it:
```
projects/
  index.json                      # [{ id, name, path }] - project registry
  {projectId}/
    status.json                   # ProjectStatus object
    conversations/
      {conversationId}.json       # Conversation with messages
    ralph/                        # Ralph Loop task state
settings.json                     # Global settings + agentPromptTemplate
pids.json                         # Tracked child process ids
```

Legacy installs kept project data in `{project-root}/.claudito/`. It is migrated to
the centralized layout on first read and the legacy folder is **left in place** on
purpose — deleting it would strip that project's history from every other instance.

## Multi-Instance Operation (3 users, 3 ports)

Three PM2 apps — `claudito-4000` / `4001` / `4002` — one per user. Each gets its own
`PORT`, `CLAUDITO_HOME` and credentials from `ecosystem.config.js` (gitignored;
`ecosystem.config.example.js` is the template). Sessions are isolated because the
cookie name carries the port (`claudito_session_4000`).

**PM2 must always be driven elevated.** The `PM2 Resurrect (boot)` scheduled task
runs at `RunLevel=Highest`, so the daemon owns `\\.\pipe\rpc.sock` as Administrator.
A normal-privilege `pm2` dies with `connect EPERM \\.\pipe\rpc.sock` — that is what
left all three instances down and unnoticed on 2026-07-30. Never type bare `pm2`:

```
npm run pm2 -- list                  # elevated pm2 wrapper (scripts/pm2.ps1)
npm run instances:start              # build + start all + save + health check
npm run instances:restart            # validation gate, then restart all
npm run instances:check              # health only, no recovery
npm run guards:install               # register watchdog task + git hooks (once)
npm run validate:instances           # ecosystem.config invariants
```

`scripts/watchdog.ps1` (Task Scheduler, every 5 min) re-checks every port and revives
dead instances into `logs/watchdog.log`.

### Invariants enforced by `npm run validate:instances`

Violating any of these has already broken production once, so the gate fails hard:

- exactly one instance claims the legacy `~/.claudito` (otherwise the original user's
  project list comes up empty)
- `PORT` unique, `CLAUDITO_HOME` unique and absolute
- `CLAUDITO_HOME` outside the repo (a gitignored dir under the worktree is one
  `git clean -xdf` away from deleting user data)
- app name is exactly `claudito-{PORT}`
- no `CHANGE_ME`-style placeholder passwords
- `ecosystem.config.js` / `.env` are not tracked by git

### Hardening that must not be regressed

- **`/api/fs` is confined to registered project paths** (`createFsPathPolicy`).
  `browse`/`browse-with-files`/`drives` stay open so the folder picker works, but
  `read`/`write`/`delete`/`mkdir`/`move` return `403 FS_PATH_NOT_ALLOWED` outside
  those roots. Widen it with `CLAUDITO_FS_ROOTS` (path-delimiter separated), not
  by removing the guard — the instances run as one elevated Windows account, so
  an unrestricted path meant any user could read or delete anything on the host.
- **`/api/mcp/*` is loopback-only** (`isLoopbackRequest`). It cannot require a
  cookie because the Claude CLI calls it, so the host check is the only thing
  standing between the LAN and "approve any permission prompt / send mail".
- **`/api/health` only reveals operator detail to a logged-in caller.** The
  public shape is status/version/timestamp/port plus `claudeCli.installed`.
- **Sessions persist to `{CLAUDITO_HOME}/sessions.json`** and are keyed to a
  fingerprint of the current credentials, so restarts do not log everyone out
  but rotating a password still kills the sessions it issued.
- **Orphan Claude processes are identified by OS creation time**, not by grepping
  the command line for "claude" (`wmic` no longer exists on current Windows, and
  the CLI hides behind `cmd.exe`). Both earlier approaches silently skipped every
  orphan, leaking processes forever.
- **Docker containers are matched by the `claudito-project` label.** Matching by
  "first container returned by `docker ps`" attached agents to other projects' —
  and other users' — containers.
- **Tests must never write to the real data dir.** `test/env-setup.ts` redirects
  `CLAUDITO_HOME` per Jest worker; a test run was caught overwriting a live
  instance's `sessions.json`.
- **`defaultSpawner` must pass `options.env` through untouched.** It used to send
  `{...process.env, ...options.env}`, which resurrected every variable the caller
  deleted — silently voiding both `delete CLAUDECODE` and the ANTHROPIC_API_KEY
  guard. There is a regression test for this in `process-manager.test.ts`.
- **Per-instance scratch dirs go through `src/utils/temp-dirs.ts`.** MCP configs
  and zip archives live in `%TEMP%/claudito-{mcp,archives}/<pid>/` so the three
  instances cannot collide. `pruneStaleInstanceTempDirs()` runs at startup and on
  wipe to delete folders of dead PIDs (never a live sibling's) — without it every
  restart leaked one folder forever, and the factory reset only cleared the
  current PID's.
- **The session cookie name is digits-only.** `PORT` is sanitised into
  `claudito_session_<digits>`; a stray space in `PORT` would otherwise produce an
  invalid cookie name and turn every request into a silent 401.

### "Invalid API key · Fix external API key" — the four guards

An `ANTHROPIC_API_KEY` the CLI cannot use (this host had the literal docs
placeholder `sk-ant-...`) makes **every chat fail** while `claude` still reports
itself logged in, because the CLI prefers that variable over the claude.ai
subscription. Four independent layers now cover it:

1. `describeUnusableApiKey()` + `dropUnusableApiKey()` strip it from the spawned
   CLI environment and log a warning (`src/agents/message-builder.ts`).
2. `defaultSpawner` no longer re-merges `process.env`, so step 1 actually sticks.
3. `npm run validate:instances` fails on an unusable key in the environment, and
   statically asserts that guards 1 and 2 are still present in the source.
4. `/api/health` reports `authWarning: "UNUSABLE_ANTHROPIC_API_KEY"` and the
   watchdog logs it as ERROR every 5 minutes — a green health check alone used to
   hide this completely.

Removing the variable for good needs the registry entry gone, not just
`SetEnvironmentVariable(..., $null)` (that leaves an empty value behind):
`Remove-ItemProperty HKCU:\Environment -Name ANTHROPIC_API_KEY`. Already-running
PM2 processes keep the old value until the daemon restarts.

### Caveats that are inherent, not bugs

- All three instances run as the **same OS account**. Any user can browse the whole
  filesystem and run Claude against any path. This is not a security boundary
  between colleagues — only a convenience separation of workspaces.
- `~/.claude.json` and `~/.claude/` (CLI credentials, MCP state) are shared by all
  three, as is the single Claude subscription.
- Two instances pointed at the same project path keep separate conversation
  histories (verified), but will run Claude concurrently in the same working
  tree. Avoid sharing a path.
- Slack Socket Mode: if two instances are configured with the *same* Slack app
  token, Slack delivers each event to only one of the connections, so commands
  land on an arbitrary instance. Give each instance its own app, or enable Slack
  on one only.
- `maxConcurrentAgents` is per instance (default 5), so three instances can drive
  15 concurrent Claude processes against one subscription.

## Key Interfaces

- **Infrastructure**: `ConfigLoader`, `HttpServer`, `ProjectWebSocketServer`, `EventManager` (in-memory event bus), `Logger` (with circular buffer)
- **Data**: `ProjectRepository` (status.json per project), `ConversationRepository` (per project/item), `SettingsRepository` (global settings + agentPromptTemplate)
- **Services**: `ProjectService`, `FilesystemService`, `GitService` (simple-git), `GitHubCLIService` (gh CLI wrapper), `RoadmapParser`, `RoadmapGenerator`, `InstructionGenerator`, `ClaudeOptimizationService` (edits files directly via Edit tool), `DataWipeService` (factory reset — wipes all Claudito data), `RunConfigurationService` (CRUD for run configs), `RunConfigImportService` (detects project files and suggests configs), `RunProcessManager` (node-pty process lifecycle with auto-restart), `InventifyService` (project idea generator using one-off agent + Ralph Loop)
- **Docker**: `DockerService` (CLI wrapper), `DockerCommandRunner` (testable command execution), `DockerProcessSpawner` (implements `ProcessSpawner` for Docker exec), `ContainerManager` (per-project container lifecycle, returns `EnsureContainerResult` with restart detection), `ImageManager` (image CRUD + variants)
- **Agents**: `Agent` (provider-agnostic interface), `ClaudeBinary` (Claude CLI implementation), `AnthropicSdkAgent` (Vercel AI SDK implementation, chat-only), `AgentManager` (multi-agent lifecycle: interactive + one-off, profile-aware factory)

## API Endpoints

All project routes prefixed with `/api/projects/:id`. Standard REST verbs (GET/POST/PUT/DELETE).

**Global**: `GET /api/health` (includes `shellEnabled`), `GET /api/agents/status`, `GET|PUT /api/settings`, `GET /api/settings/models`, `POST /api/settings/wipe-all-data`

**Integrations** (`/api/integrations`): `GET github/status`, `GET github/repos(?owner=&language=&limit=)`, `GET github/repos/search(?query=&language=&sort=&limit=)`, `POST github/clone` (body: repo, targetDir, branch?, projectName?), `GET github/issues(?repo=&state=&label=&assignee=&milestone=&limit=)`, `GET github/issues/:num(?repo=)`, `POST github/issues` (body: repo, title, body?, labels?, assignees?, milestone?), `POST github/issues/:num/close(?repo=)`, `POST github/issues/:num/comment(?repo=)` (body: body), `GET github/labels(?repo=)`, `GET github/milestones(?repo=)`, `GET github/collaborators(?repo=)`, `POST github/pr` (body: repo, title, body, base?, draft?), `GET github/pulls(?repo=&state=&limit=)`, `GET github/pulls/:num(?repo=)`

**Filesystem** (`/api/fs`): `drives`, `browse?path=`, `browse-with-files?path=`, `read?path=`, `PUT write`, `DELETE delete`

**Projects**: CRUD on `/api/projects` + `/:id`

**Roadmap** (`/:id/roadmap`): GET (content+parsed), `POST generate`, PUT (modify), `POST respond`, `PUT next-item`, `POST task` (add task), DELETE `task|milestone|phase`

**Agent** (`/:id/agent`): `POST interactive` (start session), `POST send`, `POST answer` (AskUserQuestion tool_result), `POST stop`, GET `status|context|loop|queue`, DELETE `queue(/:index)`

**One-Off Agents** (`/:id/agent/oneoff/:oneOffId`): `POST send|stop`, GET `status|context`

**Conversations** (`/:id`): GET `conversation|conversations(?limit=N)`, `PUT conversations/:conversationId` (rename)

**Config** (`/:id`): GET/PUT `claude-files|permissions|model`, GET `optimizations|debug`

**Git** (`/:id/git`): `POST generate-pr-description` (auto-generate PR title/body from conversation + diff), `GET user-name`

**Ralph Loop** (`/:id/ralph-loop`): GET (list), `POST start`, `/:taskId` GET|DELETE, `/:taskId/stop|pause|resume`

**Run Configurations** (`/:id/run-configs`): GET / (list), GET `/importable` (scan project files), POST / (create), PUT `/:configId` (update), DELETE `/:configId`, POST `/:configId/start`, POST `/:configId/stop`, GET `/:configId/status`

**Docker** (`/api/docker`): `GET /availability`, `GET /containers` (list all), `GET /containers/:projectId`, `POST /containers/:projectId/restart`, `GET /images` (list), `POST /images/build` (body: variantName, imageName?), `DELETE /images/:name`, `GET /variants`

**Per-Project Docker** (`/:id`): GET/PUT `docker` (dockerOverride toggle + dockerImage selector)

**Agent Profiles** (`/:id`): GET/PUT `agent-profile` (per-project profile override). Global profiles stored in settings (`agentProfiles` array)

**Inventify** (`/api/projects/inventify`): `POST /start` (body: projectTypes[], themes[], languages?[], technologies?[], customPrompt?) — brainstorms 5 project ideas, `GET /ideas` — returns pending ideas, `POST /suggest-names` (body: selectedIndex) — suggests 5 project names for selected idea, `GET /name-suggestions` — returns pending name suggestions, `POST /select` (body: selectedIndex, projectName) — picks an idea + name and builds it (creates directory + plan, registers project, starts Ralph Loop), `GET /build-result` — returns `{newProjectId, projectName}` after build completes (polled by frontend)

## WebSocket Messages

**Core**: `subscribe`/`unsubscribe`, `agent_message`, `agent_status`, `agent_waiting` (includes version + optional askUserQuestion data), `queue_change`, `roadmap_message`, `session_recovery`, `github_clone_progress`

**Ralph Loop**: `ralph_loop_status` (idle/worker_running/reviewer_running/completed/failed/paused), `ralph_loop_iteration`, `ralph_loop_output`, `ralph_loop_complete`, `ralph_loop_worker_complete`, `ralph_loop_reviewer_complete`, `ralph_loop_error`

**One-Off Agents**: `oneoff_message`, `oneoff_status`, `oneoff_waiting` (includes oneOffId, isWaiting, version)

**Run Configurations**: `run_config_output` (configId, data), `run_config_status` (configId, status)

## Ralph Loop

Implements Geoffrey Huntley's "Ralph Wiggum technique" - an iterative worker/reviewer pattern:
1. **Worker Phase**: Executes task with fresh context each iteration
2. **Reviewer Phase**: Reviews worker output and provides structured feedback
3. **Decision**: Approve (complete), reject (iterate), or fail (stop)
4. **Configurable**: Max iterations, worker/reviewer models, custom prompts
5. **Real-time**: Live output streaming and progress tracking

## Commands & Configuration

- `npm run dev` - Development with hot reload
- `npm run build` - Build TypeScript
- `npm start` - Run production build
- `npm test` - Run tests

**Environment Variables**: `PORT` (3000), `HOST` (0.0.0.0), `NODE_ENV`, `LOG_LEVEL`, `MAX_CONCURRENT_AGENTS` (3), `DEV_MODE`/`CLAUDITO_DEV_MODE` (enables experimental features like Git tab)

## Permissions & Modes

**Runtime modes** (changeable via UI, restarts agent with same session):
- **Accept Edits** (default): Auto-approve file edits
- **Plan**: Review plan before execution. `ExitPlanMode` shows Approve ("yes") / Request Changes (user input) / Reject ("no")

**Global** (`claudePermissions`): `dangerouslySkipPermissions`, `defaultMode` ('acceptEdits'|'plan'), `allowRules`/`denyRules` arrays (format: `Tool` or `Tool(specifier)`, e.g. "Read", "Bash(npm run:*)")

**Per-project** (`permissionOverrides` in status.json): `enabled`, `allowRules`, `denyRules`, `defaultMode`

## Session Management

Sessions use UUID v4 IDs: `--session-id {uuid}` (new) or `--resume {uuid}` (existing). Permission mode changes queue until idle, then restart with 1s delay. Unrecognized sessions auto-create fresh conversation with new UUID. When Claude calls `EnterPlanMode`, agent auto-restarts in plan mode and sends "Continue" so work proceeds without manual intervention.

## Features

**Server**: Graceful shutdown (SIGINT/SIGTERM), PID tracking (`$HOME/.claudito/pids.json`, orphans killed on startup), conversation statistics (duration, messages, tool calls, tokens), context usage persistence

**UI Tabs**: Agent Output (conversation + tool usage) and Project Files (tree view, multi-tab editor, Ctrl+S save, delete files/folders)
- **One-Off Agent Sub-Tabs**: Full rendering per tab, per-tab input/toolbar (Tasks, Search, Permission Mode, Model, Font Size), direct file editing
- **Claude Files Modal**: Edit CLAUDE.md files (global/project), markdown preview, optimize via one-off agent
- **Roadmap Management**: Checkbox selection, "Run Selected" auto-generates prompts, delete tasks/milestones/phases
- **Ralph Loop Tab**: Start/Pause/Resume/Stop controls, live output streaming, history view
- **Run Configs Tab**: Per-project named shell commands with xterm.js output, auto-restart, pre-launch chains, environment variables, import from project files (package.json, Cargo.toml, go.mod, Makefile, pyproject.toml)
- **GitHub Import**: Browse/search repos via `gh` CLI, clone and register as project with progress streaming
- **GitHub Issues**: Browse issues with state/label/assignee filters, view detail with comments, create new issues (with labels, assignees, milestones), "Start Working" (generates agent prompt), "Add to Roadmap" (creates task in milestone), close issues, add comments
- **GitHub PRs**: Create PRs with auto-generated title/description (from conversation + diff), list PRs, view PR detail with reviews/comments, "Fix PR Feedback" (generates agent prompt from review feedback)
- **Inventify**: Project idea generator — select project types + themes, optionally languages + technologies + custom instructions, agent brainstorms 5 ideas, user picks one, then agent creates detailed plan + directory with `doc/plan.md`, registers as Claudito project, auto-starts Ralph Loop to build it
- **Folder Browser**: "New Folder" button to create directories inline while browsing
- **Other**: Conversation history (view/rename, configurable limit), debug modal, mobile-responsive layout, Settings Danger Zone (wipe all data)

## Settings

`maxConcurrentAgents` (1-10), `agentPromptTemplate`, `appendSystemPrompt` (restarts all agents on change), `sendWithCtrlEnter`, `historyLimit` (5-100, default: 25), `promptTemplates`, `defaultModel` (default: claude-sonnet-4-6), `chromeEnabled` (toggle in toolbar, passes `--chrome`/`--no-chrome` to agents), `inventifyFolder` (parent directory for generated projects), `agentProfiles` (array of `AgentProfile` — provider + runtime config, selectable per-project)

**Prompt Templates**: Reusable prompts (Settings > Templates). Syntax: `${type:name}` or `${type:name:options}`. Types: `text`, `textarea`, `select:opt1,opt2`, `checkbox`

## Mermaid.js Support

Mermaid diagrams in ` ```mermaid ` code blocks render automatically in messages and plan content (dark theme). Use `/mermaid` skill via the bundled plugin (`claudito-plugin` directory, load with `claude --plugin-dir ./claudito-plugin`). See `doc/MERMAID_EXAMPLES.md` for syntax reference.

### State files are written atomically and recover themselves

Every file that would take data with it if half-written now uses
write-temp-then-rename, and every loader that could silently discard data now
preserves it:

| File | Failure it used to cause |
|---|---|
| `projects/index.json` | Non-atomic write + silent reset. `getProjectDataDir()` returns null for anything absent from the index, so an unreadable index made **every** project's conversations and ralph state unreachable — and the next save persisted the empty index. Now atomic, and a bad index is moved to `.corrupt` and **rebuilt from the `status.json` files on disk**. |
| `settings.json` | Non-atomic write + silent fallback to defaults, losing Slack/e-mail credentials, docker config and agent profiles. Now atomic, and the unreadable file is kept as `.corrupt`. |
| `sessions.json`, `pids.json` | Non-atomic; a truncated file logged everyone out / leaked orphan Claude processes. Both atomic now. |
| stray `*.tmp` | Nothing ever removed temp files from interrupted writes — a 1.7 MB conversation temp from a month earlier was still present. `pruneAbandonedTempFiles()` clears files older than an hour at startup (never an in-flight write). |

Keep new state files consistent with this: atomic write, and on a parse failure
preserve the original rather than overwriting it.
