import * as fs from 'fs';
import { randomBytes } from 'crypto';
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
  /** Unique path on disk. */
  zipPath: string;
  /** Friendly name the recipient sees — may repeat across sends. */
  filename: string;
  fileCount: number;
  totalSize: number;
  /** Paths that could not be read, so the caller can tell the user. */
  skipped: string[];
}

export async function createZipArchive(filePaths: string[], archiveName?: string): Promise<ArchiveResult> {
  const fileStats: { filePath: string; stat: fs.Stats }[] = [];
  const skipped: string[] = [];

  for (const f of filePaths) {
    try {
      const stat = fs.statSync(f);

      if (stat.isFile()) {
        fileStats.push({ filePath: f, stat });
      } else {
        skipped.push(f);
      }
    } catch {
      // Silently dropping these meant a user could ask for three files, get two,
      // and never be told. Report them back instead.
      skipped.push(f);
    }
  }

  if (fileStats.length === 0) {
    throw new Error(`No valid files found to archive: ${filePaths.join(', ')}`);
  }

  const name = archiveName || `claudito-files-${Date.now()}`;
  const filename = name.endsWith('.zip') ? name : `${name}.zip`;

  // The on-disk name must be unique even though the name shown to the recipient
  // is not: archiveName defaults to the project name, so two sends for the same
  // project would land on the same path — the second overwriting the first while
  // the first is still being attached, and the first's cleanup deleting it.
  const unique = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const zipPath = path.join(getInstanceTempDir('claudito-archives'), `${unique}-${filename}`);

  const ZipArchive = loadZipArchive();
  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const result = await new Promise<ArchiveResult>((resolve, reject) => {
    let totalSize = 0;

    output.on('close', () => {
      resolve({ zipPath, filename, fileCount: fileStats.length, totalSize, skipped });
    });

    // Only 'close' was handled. A write-stream failure (full or read-only volume,
    // the file locked by antivirus) emits 'error' and never 'close', so this
    // promise never settled and the caller — an e-mail send with attachments —
    // hung forever with nothing to report.
    output.on('error', reject);

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

export interface SplitOptions {
  /**
   * Delete the source after splitting. Correct for a temp archive we created,
   * but NOT when the caller handed us a file the user owns — that would destroy
   * it just because they asked to email it.
   */
  deleteSource?: boolean;
  /** Where the parts go. Defaults to the source's directory. */
  outputDir?: string;
}

export async function splitArchive(
  archivePath: string,
  chunkSize = MAX_ATTACHMENT_SIZE,
  options: SplitOptions = {},
): Promise<SplitResult> {
  const { deleteSource = true, outputDir } = options;
  const fileSize = fs.statSync(archivePath).size;
  const totalParts = Math.ceil(fileSize / chunkSize);
  const parts: string[] = [];
  const partBase = outputDir ? path.join(outputDir, path.basename(archivePath)) : archivePath;

  try {
    for (let i = 0; i < totalParts; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileSize);
      const partPath = `${partBase}.${String(i + 1).padStart(3, '0')}`;

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

  if (deleteSource) {
    fs.unlinkSync(archivePath);
  }

  return { parts, totalParts, originalSize: fileSize };
}

/**
 * Extensions that may only ever be attached after being re-created as a zip.
 *
 * A `.7z` reached a recipient AES-encrypted (`Method = LZMA2:24 7zAES`) and
 * Windows 11's built-in extractor refuses encrypted archives outright — "이
 * 유형의 암호화된 보관에 대한 지원은 현재 사용할 수 없습니다". The blocker is the
 * encryption, not the container: an encrypted zip fails identically.
 *
 * Wrapping such a file in a zip does not help, because the encrypted member
 * survives inside it. The only thing that works is compressing the original
 * files instead, so these are refused rather than passed through or wrapped.
 */
export const ENCRYPTABLE_ARCHIVE_EXTS: ReadonlySet<string> = new Set(['.7z', '.rar']);

/**
 * True when a zip's first entry is flagged encrypted.
 *
 * Bit 0 of the general purpose bit flag in the local file header. Cheap enough
 * to run on every attachment, and it catches the case the extension cannot:
 * a `.zip` that is just as unopenable as the `.7z` this exists because of.
 */
export function isEncryptedZip(filePath: string): boolean {
  let fd: number | null = null;

  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(8);
    const read = fs.readSync(fd, header, 0, 8, 0);

    if (read < 8) {
      return false;
    }

    // Local file header signature. An empty archive starts with the end-of-
    // central-directory record instead, and has nothing to encrypt.
    if (header.readUInt32LE(0) !== 0x04034b50) {
      return false;
    }

    return (header.readUInt16LE(6) & 0x0001) !== 0;
  } catch {
    // Unreadable is not "encrypted" — the caller reports missing files itself.
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
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
