import * as path from 'path';

/**
 * Get home directory with cross-platform support
 */
export function getHomeDirectory(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    throw new Error('Unable to determine home directory');
  }
  return homeDir;
}

/**
 * Get home directory with fallback
 */
export function getHomeDirectoryOrDefault(defaultPath = ''): string {
  return process.env.HOME || process.env.USERPROFILE || defaultPath;
}

/**
 * Generate cache key from parts
 */
export function generateCacheKey(...parts: string[]): string {
  return parts.join(':');
}

/**
 * Extract filename from path
 */
export function extractFilename(filePath: string): string {
  return path.basename(filePath);
}

/**
 * Extract filename without extension
 */
export function extractFilenameWithoutExt(filePath: string): string {
  const filename = path.basename(filePath);
  const ext = path.extname(filename);
  return filename.slice(0, -ext.length);
}

/**
 * Normalize path separators for cross-platform compatibility
 */
export function normalizePath(inputPath: string): string {
  return inputPath.replace(/\\/g, '/');
}

/**
 * Join paths with normalized separators
 */
export function joinPath(...segments: string[]): string {
  return normalizePath(path.join(...segments));
}