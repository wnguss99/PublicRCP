import * as fs from 'fs';
import * as path from 'path';
import type { ZipArchive as ZipArchiveCtor } from 'archiver';
import { getInstanceTempDir } from '../utils/temp-dirs';

/**
 * archiver v8 is ESM-only ("type": "module") while this project builds to
 * CommonJS. Node 22.12+/24 resolves `require()` of an ESM graph fine, so the
 * runtime is happy — but a top-level `import` makes Jest's CJS transformer parse
 * the package, and every suite that transitively reaches this module dies with
 * "Cannot use import statement outside a module". Keeping the value import lazy
 * (the type import above is erased at compile time) means only code that
 * actually zips something pulls the package in.
 */
function loadZipArchive(): typeof ZipArchiveCtor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const archiver = require('archiver') as { ZipArchive: typeof ZipArchiveCtor };
  return archiver.ZipArchive;
}

export interface ArchiveResult {
  zipPath: string;
  filename: string;
  fileCount: number;
  totalSize: number;
}

export async function createZipArchive(filePaths: string[], archiveName?: string): Promise<ArchiveResult> {
  const fileStats: { filePath: string; stat: fs.Stats }[] = [];
  for (const f of filePaths) {
    try {
      const stat = fs.statSync(f);
      if (stat.isFile()) fileStats.push({ filePath: f, stat });
    } catch {
      // skip missing files
    }
  }
  if (fileStats.length === 0) {
    throw new Error('No valid files found to archive');
  }

  const name = archiveName || `claudito-files-${Date.now()}`;
  const filename = name.endsWith('.zip') ? name : `${name}.zip`;
  const zipPath = path.join(getInstanceTempDir('claudito-archives'), filename);

  const ZipArchive = loadZipArchive();
  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const result = await new Promise<ArchiveResult>((resolve, reject) => {
    let totalSize = 0;

    output.on('close', () => {
      resolve({ zipPath, filename, fileCount: fileStats.length, totalSize });
    });

    archive.on('error', reject);
    archive.pipe(output);

    for (const { filePath, stat } of fileStats) {
      totalSize += stat.size;
      archive.file(filePath, { name: path.basename(filePath) });
    }

    void archive.finalize();
  });

  return result;
}

export interface SplitResult {
  parts: string[];
  totalParts: number;
  originalSize: number;
}

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

export function needsSplit(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_ATTACHMENT_SIZE;
}

export async function splitArchive(archivePath: string, chunkSize = MAX_ATTACHMENT_SIZE): Promise<SplitResult> {
  const fileSize = fs.statSync(archivePath).size;
  const totalParts = Math.ceil(fileSize / chunkSize);
  const parts: string[] = [];

  try {
    for (let i = 0; i < totalParts; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileSize);
      const partPath = `${archivePath}.${String(i + 1).padStart(3, '0')}`;

      await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(archivePath, { start, end: end - 1 });
        const writeStream = fs.createWriteStream(partPath);
        readStream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        readStream.on('error', reject);
      });

      parts.push(partPath);
    }
  } catch (err) {
    for (const p of parts) {
      try { fs.unlinkSync(p); } catch { /* best-effort */ }
    }
    throw err;
  }

  fs.unlinkSync(archivePath);
  return { parts, totalParts, originalSize: fileSize };
}

export function cleanupArchive(zipPath: string): void {
  try {
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }
  } catch {
    // best-effort cleanup
  }
}
