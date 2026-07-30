import * as fs from 'fs';
import { FileSystem } from '../repositories';
import { getLogger } from './logger';

const logger = getLogger('file-system-utils');

/**
 * Atomic file write operation - writes to temp file then renames
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tempPath, data, encoding);
  await fs.promises.rename(tempPath, filePath);
  logger.debug('Atomic file write completed', { filePath });
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