import fs from 'fs';
import os from 'os';
import path from 'path';
import { getLogger } from './logger';

const logger = getLogger('workspace-trust');

/**
 * Marks project directories as trusted in the Claude CLI's config.
 *
 * Why this exists
 * ---------------
 * Claude Code shows a trust dialog the first time it runs in a directory. It
 * can only be accepted interactively, and claudito always spawns the CLI with
 * `--print`. In an untrusted directory the CLI keeps running but prints
 *
 *   Ignoring N permissions.allow entries from .claude/settings.json:
 *   this workspace has not been trusted.
 *
 * to stderr — which claudito surfaces in the chat, so it reads as an error —
 * and, more importantly, it drops that project's permission allow-rules, so
 * tools that should be auto-approved start prompting instead.
 *
 * A person can fix this by running `claude` interactively in the directory
 * once. That is not available to the 4001/4002 users: their projects live on
 * the host machine, so someone would have to walk to it. Doing it here means a
 * colleague can add a project remotely and have it work.
 *
 * What this does and does not decide
 * ----------------------------------
 * The trust dialog guards against opening a directory whose `.claude/settings
 * .json` grants permissions you never agreed to. In claudito a project only
 * exists because someone typed its path in and added it — that act is the trust
 * decision, and this records it. It does NOT widen anything beyond the project's
 * own settings file: claudito's own permission layer (allowRules/denyRules/
 * permissionOverrides) still applies on top and is unaffected.
 *
 * The practical consequence worth knowing: if you clone someone else's
 * repository and add it as a project, its `.claude/settings.json` allow-rules
 * take effect without a separate prompt. Read that file before adding
 * repositories you did not write.
 */

interface ClaudeConfig {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean } & Record<string, unknown>>;
  [key: string]: unknown;
}

export function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * The CLI keys `projects` by the working directory with forward slashes, and it
 * matches that key exactly — `D:/x` and `d:/x` are separate entries in a real
 * config. Normalising only the separators (not the case) keeps the key aligned
 * with the cwd we actually spawn with.
 */
export function toTrustKey(projectPath: string): string {
  return projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Records `projectPath` as trusted. Returns true when the file was changed.
 *
 * Never throws: a failure here degrades to the old warning, which is far better
 * than blocking an agent from starting. The three instances share one config
 * file, so the write is atomic (temp + rename) to avoid a torn file if two
 * users add a project at the same moment.
 */
export function ensureWorkspaceTrusted(projectPath: string): boolean {
  if (!projectPath) return false;

  const configPath = getClaudeConfigPath();
  const key = toTrustKey(projectPath);

  try {
    if (!fs.existsSync(configPath)) {
      // No config yet means the CLI has never run as this user. Creating a
      // half-formed config could confuse first-run setup, so leave it alone.
      return false;
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    let config: ClaudeConfig;

    try {
      config = JSON.parse(raw) as ClaudeConfig;
    } catch {
      // The config also holds auth state and MCP servers. Rewriting a file we
      // cannot parse risks destroying it, so back off entirely.
      logger.warn('Claude config is not valid JSON; leaving workspace trust unchanged', { configPath });
      return false;
    }

    const projects = config.projects ?? {};
    const entry = projects[key];

    if (entry?.hasTrustDialogAccepted === true) {
      return false;
    }

    projects[key] = { ...(entry ?? {}), hasTrustDialogAccepted: true };
    config.projects = projects;

    const tmpPath = `${configPath}.claudito.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpPath, configPath);

    logger.info('Marked workspace as trusted for the Claude CLI', { key });
    return true;
  } catch (error) {
    logger.warn('Could not update workspace trust; the CLI may ignore project permission rules', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
