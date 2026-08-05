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
- **`atomicWriteFile` retries the rename and uses a unique temp name.** Windows
  refuses a rename over a file any process still holds open — Defender and the search
  indexer both do, for milliseconds — and 176 conversation saves were lost to
  `EPERM ... rename '<file>.json.tmp' -> '<file>.json'` because the callers only log
  the failure. The write had already succeeded; only the swap was blocked. Transient
  codes (EPERM/EACCES/EBUSY) are retried with backoff, anything else fails straight
  away, and the temp path carries pid + counter so two overlapping writes to one file
  cannot share a temp file and publish a mix of both.
- **A refusal the user caused must be an `AppError`.** `formatErrorResponse()` keeps
  the message only for `AppError` and replaces everything else with "An unexpected
  error occurred" — right for a crash, wrong for an expected refusal. A bare
  `throw new Error('Project with this path already exists')` is why "Add Project"
  looked like it crashed and was retried eleven times. Throw `ConflictError` /
  `ValidationError`, and name the thing the user has to change.
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

### ExitPlanMode has two approval paths — they must never disagree

`ExitPlanMode` is gated twice, by design: claudito's own plan card
(`handleExitPlanMode` → `pendingPlans`) and the permission-prompt MCP server the
CLI calls. Answering one used to leave the other set, and `agent/send` rejected
every message with 400 until the process restarted. On 2026-08-01 that had hit
**five projects across two ports**, G1 among them.

- **A pending plan must never reject a message.** `handleSend` used to answer
  `400 PLAN_APPROVAL_PENDING` whenever `reconcilePendingPlan()` said the plan was
  live, and that made the lockout worse rather than better: "live" is *inferred*,
  and one of its signals is simply that the agent is idle — equally true of an
  agent that already moved on. When the inference was wrong every message came
  back 400 telling the user to press controls that were spent or had never
  rendered. The rejection was also redundant: `sendInput()` already routes the
  message into `handlePlanApprovalResponse()` ('yes' approves, 'no' rejects,
  anything else becomes plan feedback). Reconcile, then deliver. Do not
  reintroduce any rejection here — `agent.test.ts` asserts the code is gone.
- **The `sendInput` plan branch must not require `agent.isWaitingForInput`.**
  That was the second half of the deadlock: once the CLI's gate was answered the
  agent resumed, the flag went false, and the branch that could have consumed the
  plan was skipped while the entry stayed forever.
- **"Allow always" is refused for `ExitPlanMode`** (`ONE_SHOT_APPROVAL_TOOLS`).
  Remembering it made later prompts auto-approve with *no user-visible event at
  all*, so the card locked with nothing to click — the variant no event hook can
  catch, which is why the reconcile above is mandatory rather than a nicety.
- **The plan-feedback branch must persist the user's message**
  (`persistUserMessage()`). It bypasses `sendInput()`, so the text reached Claude
  but was never written to the conversation: the browser's optimistic append made
  it look saved, and it vanished on reload, leaving a reply with nothing
  prompting it. `'yes'`/`'no'` are synthetic button values and stay unpersisted.
- **`getFullStatus().hasPendingPlan` is a UI hint only.** It may set the
  placeholder and keep the plan card armed; it must never disable the composer or
  gate a send. See the composer invariant below.

### The chat composer must never stay disabled (2026-08-01, second incident)

The fix above disabled the composer from `state.activePromptType` instead of
enabling it unconditionally. That removed the only thing that had been
recovering leaked prompt locks, and turned every leak into a permanently
unusable chat input — recoverable only by restarting the server. Since claudito
is driven from a phone through Tailscale, that is a total loss of control.

**The invariant: the composer is never disabled. Not for a prompt, not while
sending, not during a restart — never.**

An earlier revision of this fix instead *bounded* how long a lock could hold the
input (liveness predicates, TTLs, a hard ceiling, a one-tap unlock button). Every
one of those still had a window where the user was stuck, and the button put the
job of noticing a bug on the person least able to diagnose it. Refusing to
disable at all has no window and needs no user action.

- **`ComposerGate.apply()` only ever writes `disabled = false`**, and it runs on
  every watchdog tick, so it repairs a composer that anything else disabled.
  `test/frontend/composer-single-owner.test.js` fails the build if *any* file —
  the gate included — disables the composer, greys it out, or makes it read-only
  or pointer-events-none. Six independent writers, each releasing only on its own
  event, is what produced both incidents; there is now zero.
- **Blocking an action never means blocking the input.** If something must not
  run yet (send already in flight, permission-mode switch mid-restart), refuse it
  in `sendMessage()` with a toast. A silent `return` is the invisible twin of the
  dead-input bug — the app appears to ignore the user.
- **Tracked operations bound the *flags*, not the input.** `hold(reason, {isLive,
  ttlMs})` exists because `messageSending` / `agentStarting` / `isModeSwitching` /
  `isRalphLoopRunning` make code paths return early; `onLockReaped` clears them
  when the operation goes stale. TTLs stay capped (`MAX_TTL_MS`).
- **`hasAnswerableControl()` keeps `state.activePromptType` honest.** Answering a
  card disables its buttons, so a resolved or replayed card reports false and the
  stale "answer above" hint is retired. It no longer gates usability.
- **Rendering must never arm prompt state.** `renderAskUserQuestion()` used to,
  and it runs during replay, so reopening a conversation with an old answered
  question re-armed it. Live arming belongs to `appendMessage()`, inside the
  selected-project branch — a background project's question must not affect the
  project on screen — and `restorePromptState()` handles reload.
- **The watchdog is independent of the WebSocket and the status poll**, and also
  ticks on `visibilitychange` / `focus` / `online` / `pageshow`, because a phone
  freezes background timers and drops sockets constantly.
- **The plan gate no longer rejects a send at all** (see above), so there is no
  rejection for the UI to react to. `showPlanRecoveryCard()` existed only to
  repair the card after a 400 and was removed with it.
- **A pending prompt owns the placeholder** (`promptPlaceholderText()`), which is
  now the only signal that something is waiting. `updateInputHint()` must keep
  deferring to it — it runs on every `agent_status` and would otherwise erase it.
- No global `$.ajaxSetup` timeout: operation TTLs already bound in-flight state,
  while a blanket timeout would abort slow-but-legitimate calls (repo clone,
  docker pull, one-off agents).

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

### An empty conversation must be a fact, never a failed request (2026-08-05)

Refreshing looked like it deleted the whole history. It never did — the messages
were intact on disk every time (measured on the real file: 1862 messages,
4.9 MB, and `GET /conversation` returned all of them). Two things presented that
as deletion:

- `selectProject()` set `state.conversations[projectId] = []` **before** the
  reload, throwing away the last known good view. The cache is keyed by
  projectId, so the stale-data worry it was guarding against could not happen
  anyway; all it achieved was destroying the fallback.
- `loadConversationHistory()` had only a `.done()` handler. One request carries
  the entire conversation — several megabytes — and the UI is driven from a phone
  over Tailscale, so it does fail. When it did, nothing ran at all: the emptied
  cache rendered the reassuring `No conversation yet`, with no error, no retry,
  and no way to tell that from real data loss.

- **`No conversation yet` is a claim about the data and may only be shown when
  the load succeeded.** `state.conversationLoadErrors[projectId]` distinguishes
  "loaded, genuinely empty" from "never loaded", and the failure state says so
  and offers a retry. Read it defensively (`(state.conversationLoadErrors || {})`)
  — a throw inside `renderConversation()` is itself the blanking bug, because
  `$conv.empty()` runs first.
- **A failed load must not destroy what is on screen.** Keep the project's own
  cached messages and re-render them; showing slightly stale history beats
  showing none.
- **Every render of ~1800 messages costs ~1000 nodes / ~20k DOM elements /
  1.8 MB of HTML** (measured). The payload size is the real aggravator here and
  is still unpaged — if this returns, page the history rather than making the
  single request bigger.

### A message must never be silently lost or refused (2026-08-03 audit)

Every "the chat doesn't work" report so far has been one of three shapes: the
composer was disabled, the send was refused with nothing the user could do, or the
answer never appeared. The first is impossible by construction (see below); these
rules close the other two.

- **Nothing refuses a send silently.** Every early `return` in `sendMessage()` /
  `sendOneOffMessage()` shows a toast. A silent return reads as "the app ignores
  me", which is undiagnosable from the outside and worse than a visible error.
- **A stale idea of whether the agent is running must self-heal, in both
  directions.** The client's `project.status` is a cached belief and was wrong in
  every incident here, so the server tags the two disagreements and the client
  acts on them instead of surfacing an error the user can only answer by retyping:
  `AGENT_NOT_RUNNING` (send → start the agent with the same message) and
  `AGENT_ALREADY_RUNNING` (start → deliver it to the running agent). Match on the
  **code**, never the sentence.
- **One recovery hop, ever, and "no hop" is not the same as "already echoed".**
  Those two handoffs are exact opposites, so a server flapping between states would
  bounce the same message forever; each direction refuses to hand off a second time.
  But the echo differs by direction: `doSendMessage` appends optimistically, while
  `startInteractiveAgentWithMessage` appends only on success — so coming *from* the
  start path nothing is on screen yet. `doSendMessage(message, noHop, skipEcho)`
  keeps them separate. Conflating them hid the user's own message while the agent
  answered it.
- **The composer keeps its text unless the server accepted it.** Only `.done()`
  clears. `sendOneOffMessage()` used to clear before the request went out, so a
  failed send destroyed what the user had written.
- **A WebSocket reconnect reloads the conversation.** Re-subscribing restores the
  stream but nothing replays what was missed, so the reply to the last message
  could sit on the server while the chat looked frozen. That is what made
  "switching project and back" appear to fix things — that path reloads history.
  `onopen` now does it for a reconnect (not the first connect, which already loads).
- **A dropped socket must not cost the turn's output.** `agent_message` goes only to
  subscribers, while `agent_status` on re-subscribe reports the turn as finished. So
  a reaped socket produced exactly this report: the chat stopped mid-answer and
  jumped to "Waiting for your input" with no completion, and the real output
  appeared only after a refresh. Two fixes together: the heartbeat tolerates
  `HEARTBEAT_MAX_MISSED_PONGS` (2, ~60s) instead of reaping on one missed pong, and
  the client reloads history on reconnect so a reap is no longer lossy.
- **Message dedup keys on identity, never on `timestamp + type`.**
  `Utils.messageIdentity()` adds the tool id or the content, because timestamps are
  millisecond precision and parallel tool calls collide inside one millisecond — the
  second message was dropped from the view while the server stored both, which again
  looks like a stall that a refresh "fixes". `utils.js` is loaded by `index.html` for
  this (it previously existed for tests only, so anything reaching for `Utils` in the
  browser silently got `undefined`); it registers via `root.X =` because that is the
  pattern the validation gate uses to recognise a global.
- **A silent wait must announce itself — but only a real one.** `rate_limit_event`
  is *not* a throttling signal: it is periodic quota status, and 98 of them were
  logged across a few days of normal work, every one with an empty payload, while
  the runs finished fine. Announcing each told users their usage had run out twice
  during a task that succeeded — a false alarm about the one thing they cannot check
  themselves, which is worse than silence. `handleRateLimitEvent()` therefore speaks
  only when `retry_after_ms` reports an actual pause, and suppresses repeats inside
  a wait it already announced. When adding a notice for any "the agent is waiting on
  something invisible" event, verify against real payloads first that the event
  means what its name suggests.

**A session must not expire while it is being used** (2026-08-03). Sessions were a
hard 7 days from login and `validateSession()` never extended them, so an active
user was logged out mid-work simply because a week had passed since signing in —
and the person that strands is the remote one who cannot reach the machine.
`touchSession()` slides the expiry forward on every authenticated request or WS
handshake (throttled to one store write per hour), and the auth middleware
re-issues the cookie with the new `Max-Age`, because the browser cookie has its own
lifetime and would otherwise expire on the original schedule. Only genuine
inactivity for the full window ends a session now. Credentials are pinned in `.env`
(`CLAUDITO_USERNAME`/`CLAUDITO_PASSWORD`) — leave them set, since without them
`getOrGenerateCredentials()` invents a random password on boot, which changes the
credential fingerprint, drops every session, and locks everyone out.

**Context usage counts the cached prompt** (2026-08-03). The bottom-right bar sat at
0% forever and compaction always arrived unannounced, because three things were
wrong at once: `totalTokens` was `input + output`, which with Claude Code's caching
excludes essentially the whole context (measured: input 2, cache_read 635,007 — the
old sum said 117); the denominator was hard-coded to 200k, and `limits` is never
supplied so it could not be configured away; and the UI guard `!percentUsed` is true
at 0, so a real 0% never rendered and a post-compact drop left the old value on
screen. The CLI reports the model id but never the window size, so
`resolveMaxContextTokens()` infers it and promotes to the 1M tier when observed usage
exceeds the assumed one — exceeding the window without compacting is proof the
assumption was wrong, which beats displaying a percentage known to be false.

**A `/compact` that changed nothing on the bar is the bar's fault, not compaction's**
(2026-08-03). Usage is only ever recomputed from a `usage` payload on an assistant
message (`handleAssistantMessage` / `handleMessageStart` / `handleMessageDelta`).
A compaction turn emits `status_change(compacting)` → `compact_boundary` →
`system/init` → `result` and **no assistant message at all**, so nothing
recalculated and the pre-compaction figure stayed on screen — `/compact` looked
like a no-op after it had worked. The "Done." the user sees is claudito's own
synthetic line from `handleResult` (`!turnHasEmittedText`), which is the same fact
that means no usage arrived.

- **`emitCompactionMessage()` is the single funnel for all three compaction
  events and now marks the stored usage `awaitingRefresh`.** It is the only place
  that knows the context shrank; it used to do nothing about the numbers.
- **Do not invent a post-compaction size.** The CLI reports that a boundary was
  crossed, never the new total. The UI shows an empty track and `–` until the next
  turn measures it — a filled grey bar would read as "context is full", the
  opposite of what happened. `updateContextUsage()` clears the flag on any real
  measurement.
- **Read `usage` before the empty-content guard.** `handleAssistantMessage` used
  to `return` on `!message.content` *before* reading usage, so a tool-only turn
  threw its usage away with the empty body.

**Concurrency is per instance, not shared** (checked 2026-08-03): the limit lives in
each process's `agents` map with a default of **5** (`MAX_CONCURRENT_AGENTS` is not
set in `ecosystem.config.js`), so three users on three ports never queue each other
— it only binds when one instance runs 6+ projects, and then it says so
(`Maximum concurrent agents limit (5) reached…`). The genuinely shared resources are
the single Claude subscription and `~/.claude*`, which is why rate limits are the
real contention point.

### The permission mode the user picked is theirs (2026-08-05)

A project set to Accept Edits kept turning up in Plan. Not a bug — `handleEnterPlanMode`
restarts the agent with `--permission-mode plan` whenever Claude calls the
`EnterPlanMode` tool — but the surrounding behaviour was indefensible in two ways.

- **The switch must be visible.** The notice was `hidden: true`, so the mode changed
  under the user with nothing to explain it. It now says what happened, why, and that
  approving the plan returns to Accept Edits.
- **A mode the server reports is display state; a mode the user picked is a
  preference.** `syncFromServer()` called `setModeForProject()`, so the automatic plan
  switch was written over the stored choice — the Accept Edits selection was gone, and
  switching project and back "restored" plan because plan was what had been saved.
  Only `applyModeChange()` (a user action) may write the preference. The display still
  follows the server, so the UI never claims a mode the agent is not running.
- **Rejecting a plan deliberately stays in plan mode.** The planning conversation
  continues, so plan is the right mode, and switching back would force another restart
  that discards the reply the user is waiting for.
- There is no "remember and restore the previous mode" machinery, and adding it would
  be dead weight: the domain is only `{acceptEdits, plan}`, so the mode before an
  automatic switch into plan can only have been `acceptEdits` — already the value used
  on approval. (The UI's Auto/Ask buttons are `approvalMode`, a different setting.)

### A project's status has exactly one owner (2026-08-03, G1)

G1 showed "Claude agent exited with code 1" and an Error badge, kept working
normally for the next eight minutes, and looked fine again after switching project
and back. Nothing had actually stopped: `status.json` was stuck on `error` while
the live agent was running, and the two are read by different paths.

- **`status.json` is a cache of live process state, never the display truth.**
  Both `GET /api/projects` and `GET /api/projects/:id` overlay
  `agentManager.getAgentStatus()`. `reconcilePersistedStatuses()` runs at startup
  to clear `running`/`error` left behind by a crash, since no agent can exist yet.
- **Never persist the status that was reported — derive it.**
  `syncPersistedStatus()` reads the current owner (`agents.get(projectId)`), so the
  result does not depend on which write happens last. The old code copied the
  reported value, and a dying agent's `error` landing after its replacement's
  `running` was stored permanently: a live agent only emits on *change*, so nothing
  ever corrected it.
- **An exit reconciles the flag.** No process running means `stopped`; the reason
  for the failure lives in the persisted `system` message, not in this field.
- **Only the current agent may touch project state.** `isCurrentAgent()` guards the
  status/waiting/plan/contextUsage listeners, and `handleAgentExit()` now runs
  `teardownAgentListeners()` — before, `setupAgentListeners()` attached eight
  listeners that were never removed, so a replaced agent kept writing project state
  from a dead process. The `exit` and `sessionNotFound` paths are deliberately not
  guarded: handling them is the dead agent's own job.
- **`system` messages are persisted** (`messageListener`), and so is the request
  that *starts* an agent when the user typed it (`persistInitialMessage`, set only
  by the HTTP route). Both were broadcast-only, so reloading erased the failure
  line and left a stored conversation whose first entry was Claude answering a
  question that was nowhere in it. Internal restarts pass synthetic prompts
  ('Continue', 'I approved the plan…') and must stay unpersisted.
- **The client keeps a 30 s reconcile poll when it believes the agent is not
  running.** Polling used to stop dead, so one missed `agent_status` frame — routine
  on a phone — stranded the badge on Error until the user switched project and
  back, which is precisely what re-subscribing fixed.

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

### Email is configured in conversation, per instance

`claudito-email` MCP serves three tools — `send_email`, `get_email_settings`,
`update_email_settings` — so a user can just say "보내는 주소를 …로 바꿔줘" and the
agent writes it into **that instance's** `settings.json`. Settings are per
`CLAUDITO_HOME`, so one port's user can never see or change another's.

- `EMAIL_MCP_TOOL_NAMES` is the single source for `--allowedTools`. A tool that is
  served but not allow-listed is silently unusable, so add new tools there.
- Email switches on automatically once smtpHost + smtpUser + smtpPassword +
  fromAddress are all present; that is what makes the mail icon appear. The
  browser caches settings, so the response tells the user to refresh.
- `get_email_settings` never returns the password, only whether one is stored.
- There is no mail *receiving*. `defaultRecipient` is the default `To:`.

### Attachment invariants

| Rule | Why |
|---|---|
| `splitArchive` must not delete a source it does not own | A user emailing their own 30 MB `.zip` had the file split **and deleted**. Callers pass `deleteSource: false` + `outputDir` for user-owned files. |
| Parts of a user-owned archive go to the instance temp dir | Otherwise `.001/.002` files litter the user's project folder. |
| Zip paths are unique, filenames are not | `archiveName` defaults to the project name, so two sends for one project collided — the second overwrote the first mid-attach, and the first's cleanup deleted it. The recipient still sees the friendly name. |
| Unreadable paths are reported, never dropped | A user asking for three files got two with no indication. `createZipArchive` returns `skipped` and the tool response warns. |
| MCP config filenames are unique per invocation | Two agents on one project shared the file; the first to stop unlinked it and the other lost its MCP servers mid-session. |

### Restarting is safe by construction — keep it that way

The server is only reachable remotely, so a failed restart means someone has to
travel to the office. Three layers, each verified by deliberately breaking the
build (2026-07-31):

1. **Validation gate refuses to restart broken code.** `npm run instances:restart`
   builds, checks frontend syntax/refs, and boots the compiled server on a spare
   port. On failure it exits without touching the running instances.
2. **Auto-rollback if the restart still fails.** `restart-safe.ps1` restores
   `.lkg/dist` and restarts again. Exit code `2` means "rolled back — your new
   code is the problem".
3. **The watchdog rolls back too.** A reboot into a broken `dist` never reaches
   `restart-safe`, so after two consecutive failed recovery cycles the watchdog
   restores `.lkg/dist` itself. At a 2-minute interval that is ~4 minutes to
   self-heal.

**A restart that did not replace the processes is a failure, not a success**
(2026-08-03). Ports 4000-4002 were held by instances started with elevated
privileges, so `pm2 restart` answered `[PM2][ERROR] Process N not found` for all
three and the new apps fell into `waiting` on EADDRINUSE. The old processes kept
answering `/api/health`, so the script reported "재시작 완료 — 전부 정상", exited
`0`, and refreshed known-good with a `dist` that had never been loaded. Had that
build been broken, the rollback snapshot would now hold the broken build — the
safety net silently disarmed. Three rules keep it honest:

- **A non-zero `pm2 restart` exit aborts immediately.** Printing it in red and
  carrying on was the same bug in slower motion. Nothing was replaced, so
  stopping leaves the running instances untouched — the safest outcome.
- **Health is 200 *and* a changed listener PID.** `Get-PortOwners` reads the
  owning PID via `Get-NetTCPConnection`, which works even when the other process
  is elevated. HTTP alone cannot distinguish a new process from an old one still
  serving.
- **Exit `3` means "responding, but the same process as before".** No rollback:
  the new code was never loaded, so reverting `dist` would fix nothing and
  updating known-good would be dangerous.

**The known-good snapshot must only ever be taken after a restart proved healthy.**
Snapshotting *before* the restart looks equivalent and is not: a previous failed
gate run already overwrote `dist` via `npm run build`, while the running
instances kept answering from the code in memory. The health check said "fine"
and a broken `dist` was saved as known-good — the rollback then restored the
broken build and took all three ports down. Process health is not disk health.

### Anything that boots the compiled server must set its own `CLAUDITO_HOME`

**`npm run validate` was killing the live agents** (2026-08-04). Its boot smoke
test spawned `dist/index.js` with only `PORT`/`HOST`/`NODE_ENV`, so
`getDataDirectory()` fell back to `~/.claudito` — port 4000's *real* data
directory. `ExpressHttpServer.start()` then ran `cleanupOrphanProcesses()`, read
that home's `pids.json`, and sent `SIGTERM` → 1 s → `SIGKILL` to every PID in it.
Those PIDs were not orphans; they were the Claude processes running right then.

So every validate run silently killed the user's agents. What they saw was several
projects flipping to an Error badge with `Claude agent exited with code 1`, having
done nothing themselves. The log fingerprint is unmistakable once you know it:

- exits **one second apart in sequence** (the SIGTERM→sleep→SIGKILL loop), not
  simultaneously
- `code: 1, signal: null` — a Windows force-kill reports a code, never a signal
- the dying processes' lifetimes are all *different* (17 h, 17 h, 2.5 h), so it
  cannot be a per-process timeout — one global event killed them
- **only port 4000**, because it owns `~/.claudito`; 4001/4002 have their own
  homes and recorded zero occurrences
- no CLI stderr at all, and no `Server started` near the event, so neither the CLI
  nor a restart caused it
- the `Killing orphan process` lines are missing from the instance log because the
  smoke server writes them to the validate run's own stdout

Step 0 of `validate.mjs` already fails any ecosystem instance that omits
`CLAUDITO_HOME` ("인스턴스끼리 데이터를 공유해 버린다"). The one process breaking
that rule was the gate's own smoke server. It now gets an `mkdtempSync` home that
is removed afterwards, and step 0 statically asserts the spawn still passes
`CLAUDITO_HOME` — anchored on `spawn(process.execPath`, **not** on the function
name, because the check's own source contains that name and `indexOf` would find
itself first and silently pass.

`npm start` has the same shape (no `CLAUDITO_HOME` → `~/.claudito`); that is
intended for a single-instance run, but do not use it on this host while the PM2
instances are up.

**Never run destructive tests against the live ports.** Verifying these paths
means real downtime for three remote users. Announce it first, or exercise the
failure on a scratch port.

### Invariants added while hardening the restart path (2026-08-01)

| Rule | What it prevents |
|---|---|
| **`dist` and `.lkg/dist` are swapped, never deleted-then-copied.** `Copy-DirectorySafely` copies to `.staging`, renames the target to `.old`, renames `.staging` into place, then drops `.old`. On failure it renames `.old` back. | `Remove-Item dist; Copy-Item .lkg\dist dist` left a multi-second window with **no** usable `dist`. Dying there — in code that only runs during an outage — meant no instance could boot and no remote fix was possible. |
| **The function is deliberately duplicated in `restart-safe.ps1` and `watchdog.ps1`.** | A shared include is one moved file away from disabling the watchdog, which is the last line of defence. Keep the two copies identical if either changes. |
| **`pm2` exit codes are checked, never `\| Out-Null`.** | A pm2 that did nothing (EPERM) still looked like a success, because the health check passed against the *old* process still holding the port. |
| **The watchdog refuses to run unelevated** unless `-CheckOnly`. | Without it every pm2 call failed silently and the watchdog only produced the illusion of monitoring — exactly the 2026-07-30 failure. The guard sits ahead of log rotation and every pm2 call. |
| **Health checks retry; they never probe once after a fixed sleep.** | `start-instances.ps1` and the watchdog's post-restart check reported healthy-but-slow instances as FAIL. In the watchdog that inflated the consecutive-failure counter and could trigger a rollback nothing was wrong with. |
| **Rollback restarts each port by name, not `pm2 restart all`.** | `all` is all-or-nothing and hides which port failed. After a `dist` swap every port must restart — healthy ones are still serving the broken build from memory. |
| **The boot smoke test asks the OS for a free port.** | Hardcoded 4099 turned an unrelated port collision into "the new code does not boot", blocking deploys during no actual fault. |
| **Shutdown has a 15 s `unref()`ed force-exit timer** (`src/index.ts`). | A wedged Claude CLI made `stopAllAgents()` hang forever, so the old process kept the port and the restart failed with `EADDRINUSE`. PM2 SIGKILLs on its own; a manual or dev run had no backstop. `unref()` is required — without it every clean exit would wait 15 s. |
| **A corrupt `sessions.json` is renamed to `.corrupt`,** matching `settings.json` and `projects/index.json`. | The file used to be dropped silently, destroying the only evidence of why an instance logged everyone out.
