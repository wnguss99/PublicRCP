# Fork changes

This document lists what this fork modifies compared to upstream
[comfortablynumb/claudito](https://github.com/comfortablynumb/claudito).

## 1. Windows `.cmd` spawn fix

Upstream fails on Windows with `spawn EINVAL` (or `ENOENT`) when launching the
`claude` CLI, because Node.js cannot directly spawn `.cmd` / `.ps1` launchers.

### `src/agents/process-manager.ts`
- Added `resolveWindowsCommand()` helper that walks `PATH` + `PATHEXT` to find
  the absolute `.cmd` path for a bare command (e.g. `claude` → `C:\...\claude.CMD`).
- `spawn(...)` now uses `shell: this.isWindows` and the resolved absolute path,
  so cmd.exe handles `.cmd` execution while Node still auto-quotes args (parens
  and wildcards in `--allowedTools` survive intact).

### `src/services/github-cli-service.ts`
- `DefaultCommandRunner.exec` / `spawn` now pass `shell: true` on Windows so
  `claude --version` / `claude auth status` detection works.

## 2. Fixed credentials via `.env`

Upstream auto-generates a new `Username` / `Password` on every restart, which
makes mobile use (where you type the password) painful.

### `package.json`
- `start` script now uses `node -r dotenv/config dist/index.js`, so a project-
  local `.env` is loaded before the server boots.
- `dotenv` added to `dependencies`.

### `.env` (gitignored)
Create your own with:
```
CLAUDITO_USERNAME=admin
CLAUDITO_PASSWORD=admin
PORT=4000
```

The upstream env-var contract is unchanged — see `src/services/auth-service.ts`.

## 3. Korean + English font stack

Upstream uses `'Monaco', 'Menlo', 'Ubuntu Mono'` (macOS / Linux fonts) which
render badly on Windows and have no Korean fallback.

### `public/css/styles.css`
- Added CSS variables to `:root`:
  - `--claudito-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', '맑은 고딕', system-ui, sans-serif`
  - `--claudito-font-mono: Consolas, 'Cascadia Code', 'D2Coding', 'Malgun Gothic', '맑은 고딕', 'Courier New', monospace`
- `html, body` now apply the sans stack.
- Nine hardcoded `font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace`
  declarations replaced with `var(--claudito-font-mono)`.

### `public/index.html`, `public/login.html`
- Inline `<style>` `body` font-family extended with Korean fallbacks
  (`'Malgun Gothic'`, `'맑은 고딕'`).

## 4. `.gitignore` hardening

- Added `/.bkit/` (local audit log directory that contains absolute paths).

## License

Same as upstream — MIT. Original `LICENSE` file is preserved.
