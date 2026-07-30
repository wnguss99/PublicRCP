import fs from 'fs';
import os from 'os';
import path from 'path';
import { getLogger } from './logger';

/**
 * Per-instance scratch directories under the OS temp dir.
 *
 * With one claudito instance per port, three processes write MCP configs and zip
 * archives at the same time, so each keeps its own PID-named subdirectory instead
 * of sharing one folder. The consequence — and the reason this module exists — is
 * that every restart leaves its old directory behind: eleven of them piled up in
 * two hours of restarts, and the factory-reset wipe only ever removed the current
 * PID's folder. Nothing pruned the rest.
 */
const TEMP_KINDS = ['claudito-mcp', 'claudito-archives'] as const;

export type InstanceTempKind = (typeof TEMP_KINDS)[number];

function rootFor(kind: InstanceTempKind): string {
  return path.join(os.tmpdir(), kind);
}

/**
 * The current process's scratch directory for `kind`, created if missing.
 */
export function getInstanceTempDir(kind: InstanceTempKind): string {
  const dir = path.join(rootFor(kind), String(process.pid));

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return dir;
}

/** Path only — does not create anything. Used by the wipe path. */
export function getInstanceTempDirPath(kind: InstanceTempKind): string {
  return path.join(rootFor(kind), String(process.pid));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete scratch directories belonging to processes that no longer exist, plus
 * the loose files left in the roots by the pre-per-instance layout.
 *
 * Directories of *live* PIDs are never touched — a sibling instance is using its
 * own, and the wipe/startup of one instance must not disturb another.
 */
export function pruneStaleInstanceTempDirs(): string[] {
  const logger = getLogger('temp-dirs');
  const removed: string[] = [];

  for (const kind of TEMP_KINDS) {
    const root = rootFor(kind);

    if (!fs.existsSync(root)) {
      continue;
    }

    let entries: fs.Dirent[] = [];

    try {
      const listed = fs.readdirSync(root, { withFileTypes: true });
      // Housekeeping must never be able to break its caller — a factory reset
      // that throws here would abort the whole wipe.
      entries = Array.isArray(listed) ? listed : [];
    } catch (error) {
      logger.warn('Could not read temp root', { root, error: String(error) });
      continue;
    }

    for (const entry of entries) {
      const target = path.join(root, entry.name);

      if (typeof entry?.isDirectory === 'function' && entry.isDirectory()) {
        const pid = Number(entry.name);

        // Anything that is not a PID-shaped name is not ours to interpret.
        if (!Number.isInteger(pid) || pid <= 0) {
          continue;
        }

        if (pid === process.pid || isPidAlive(pid)) {
          continue;
        }
      }

      // Loose files in the root are leftovers from the shared-folder layout.
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch (error) {
        logger.warn('Could not remove stale temp entry', { target, error: String(error) });
      }
    }
  }

  if (removed.length > 0) {
    logger.info('Pruned stale instance temp directories', { count: removed.length });
  }

  return removed;
}

/** A real temp file lives for milliseconds; anything this old was abandoned. */
const ABANDONED_TEMP_AGE_MS = 60 * 60 * 1000;

/**
 * Delete abandoned `*.tmp` files under the data directory.
 *
 * Status, index, settings and conversation writes all go through
 * write-temp-then-rename. When a write is interrupted the temp file survives, and
 * nothing ever cleaned it up — a 1.7 MB conversation temp file from a month
 * earlier was still sitting in the data dir. Only files older than
 * ABANDONED_TEMP_AGE_MS are touched so an in-flight write is never disturbed.
 */
export function pruneAbandonedTempFiles(dataDir: string): string[] {
  const logger = getLogger('temp-dirs');
  const removed: string[] = [];
  const cutoff = Date.now() - ABANDONED_TEMP_AGE_MS;

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) {
      return;
    }

    let entries: fs.Dirent[] = [];

    try {
      const listed = fs.readdirSync(dir, { withFileTypes: true });
      entries = Array.isArray(listed) ? listed : [];
    } catch {
      return;
    }

    for (const entry of entries) {
      const target = path.join(dir, entry.name);

      try {
        if (entry.isDirectory()) {
          walk(target, depth + 1);
          continue;
        }

        if (!entry.name.endsWith('.tmp')) {
          continue;
        }

        if (fs.statSync(target).mtimeMs > cutoff) {
          continue;
        }

        fs.rmSync(target, { force: true });
        removed.push(target);
      } catch {
        // Skip anything we cannot inspect or delete.
      }
    }
  };

  if (!fs.existsSync(dataDir)) {
    return removed;
  }

  walk(dataDir, 0);

  if (removed.length > 0) {
    logger.info('Removed abandoned temp files', { count: removed.length });
  }

  return removed;
}
