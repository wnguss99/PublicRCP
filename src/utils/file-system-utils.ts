import * as fs from 'fs';
import { FileSystem } from '../repositories';
import { getLogger } from './logger';

const logger = getLogger('file-system-utils');

/**
 * Windows fails a rename over an existing file while any process still holds a
 * handle to it — Defender, the search indexer and backup agents all open a file
 * moments after it is written. The error is transient and clears in milliseconds.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * How long the retry loop is willing to wait for a Windows lock to clear.
 *
 * This was 5 attempts with a 20ms linear backoff — 200ms of total patience —
 * and on 2026-08-31 a conversation save exhausted all five and lost the write
 * anyway. 200ms was never enough: the file in question is ~5 MB, and Defender
 * holds a handle for as long as it takes to scan that, which is far longer.
 *
 * Exponential with a ceiling instead, so the common case (one blocked attempt,
 * cleared in milliseconds) is still fast while a real scan gets seconds rather
 * than a fifth of one. Worst case is bounded at roughly six seconds; saves are
 * coalesced and awaited off the request path, so waiting beats losing the data.
 */
export const RENAME_ATTEMPTS = 10;
const RENAME_BACKOFF_BASE_MS = 25;
const RENAME_BACKOFF_MAX_MS = 1500;

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * Half fixed, half jittered. Four instances coalesce saves into the same data
 * directory, and a purely fixed schedule makes them retry in lockstep — each
 * collision then reproduces itself on every subsequent attempt.
 */
function renameBackoffMs(attempt: number): number {
  const ceiling = Math.min(RENAME_BACKOFF_BASE_MS * 2 ** (attempt - 1), RENAME_BACKOFF_MAX_MS);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Atomic file write operation - writes to temp file then renames.
 *
 * Retries the rename, because without it this silently lost user data: 176 saves
 * failed with `EPERM ... rename '<conversation>.json.tmp' -> '<conversation>.json'`
 * across these instances, and the callers only log the failure — so those messages
 * never reached disk and vanished on the next reload. The write itself had already
 * succeeded; only the swap was blocked, and only for an instant.
 *
 * The temp file also carries the pid and a counter. It used to be a fixed
 * `<file>.tmp`, so two overlapping writes to the same file shared one temp path and
 * could publish a half-written mix of both.
 */
let tempCounter = 0;

export async function atomicWriteFile(
  filePath: string,
  data: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${++tempCounter}.tmp`;

  await fs.promises.writeFile(tempPath, data, encoding);

  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rename(tempPath, filePath);
      logger.debug('Atomic file write completed', { filePath, attempt });
      return;
    } catch (err) {
      const lastAttempt = attempt === RENAME_ATTEMPTS;

      if (!isTransientRenameError(err) || lastAttempt) {
        // Do not leave the temp file behind for pruneAbandonedTempFiles to find.
        await fs.promises.unlink(tempPath).catch(() => undefined);

        if (lastAttempt && isTransientRenameError(err)) {
          logger.error('Atomic write gave up after repeated transient failures', {
            filePath,
            attempts: RENAME_ATTEMPTS,
            code: (err as NodeJS.ErrnoException).code,
          });
        }

        throw err;
      }

      logger.warn('Atomic write rename blocked, retrying', {
        filePath,
        attempt,
        code: (err as NodeJS.ErrnoException).code,
      });

      await delay(renameBackoffMs(attempt));
    }
  }
}

/**
 * Ensure directory exists, create if not
 */
export function ensureDirectoryExists(dirPath: string, fileSystem?: FileSystem): void {
  const fs = fileSystem || defaultFileSystem;
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.debug('Created directory', { dirPath });
  }
}

/**
 * Ensure directory exists asynchronously
 */
export async function ensureDirectoryExistsAsync(dirPath: string): Promise<void> {
  try {
    await fs.promises.access(dirPath);
  } catch {
    await fs.promises.mkdir(dirPath, { recursive: true });
    logger.debug('Created directory', { dirPath });
  }
}

/**
 * Check if file exists with fallback
 */
export async function readFileWithFallback<T>(
  filePath: string,
  fallback: T,
  parser: (data: string) => T = JSON.parse
): Promise<T> {
  try {
    const data = await fs.promises.readFile(filePath, 'utf-8');
    return parser(data);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      logger.debug('File not found, returning fallback', { filePath });
    } else {
      logger.warn('Error reading file, returning fallback', {
        filePath,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return fallback;
  }
}

/**
 * Delete file if exists
 */
export async function deleteFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.unlink(filePath);
    logger.debug('Deleted file', { filePath });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Get directory contents with error handling
 */
export async function safeReadDir(
  dirPath: string
): Promise<string[] | null> {
  try {
    return await fs.promises.readdir(dirPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      logger.debug('Directory not found', { dirPath });
      return null;
    }
    throw error;
  }
}

// Default file system implementation for backward compatibility
const defaultFileSystem: FileSystem = {
  readFileSync: (p: string, encoding: BufferEncoding) =>
    fs.readFileSync(p, encoding),
  writeFileSync: (p: string, data: string) =>
    fs.writeFileSync(p, data),
  existsSync: (p: string) =>
    fs.existsSync(p),
  mkdirSync: (p: string, options: { recursive: boolean }) =>
    fs.mkdirSync(p, options),
  rmdirSync: (p: string, options: { recursive: boolean }) =>
    fs.rmdirSync(p, options),
  renameSync: (old: string, newPath: string) =>
    fs.renameSync(old, newPath),
  readdirSync: (p: string) =>
    fs.readdirSync(p),
};