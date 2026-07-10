import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ZipArchive } from 'archiver';

export interface ArchiveResult {
  zipPath: string;
  filename: string;
  fileCount: number;
  totalSize: number;
}

export async function createZipArchive(filePaths: string[], archiveName?: string): Promise<ArchiveResult> {
  const validFiles = filePaths.filter(f => fs.existsSync(f) && fs.statSync(f).isFile());
  if (validFiles.length === 0) {
    throw new Error('No valid files found to archive');
  }

  const name = archiveName || `claudito-files-${Date.now()}`;
  const filename = name.endsWith('.zip') ? name : `${name}.zip`;
  const zipPath = path.join(os.tmpdir(), 'claudito-archives', filename);

  const dir = path.dirname(zipPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const result = await new Promise<ArchiveResult>((resolve, reject) => {
    let totalSize = 0;

    output.on('close', () => {
      resolve({ zipPath, filename, fileCount: validFiles.length, totalSize });
    });

    archive.on('error', reject);
    archive.pipe(output);

    for (const filePath of validFiles) {
      const stat = fs.statSync(filePath);
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

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

export function needsSplit(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_ATTACHMENT_SIZE;
}

export function splitArchive(archivePath: string): SplitResult {
  const fileSize = fs.statSync(archivePath).size;
  const totalParts = Math.ceil(fileSize / MAX_ATTACHMENT_SIZE);
  const parts: string[] = [];

  const buf = fs.readFileSync(archivePath);
  for (let i = 0; i < totalParts; i++) {
    const start = i * MAX_ATTACHMENT_SIZE;
    const end = Math.min(start + MAX_ATTACHMENT_SIZE, fileSize);
    const partPath = `${archivePath}.${String(i + 1).padStart(3, '0')}`;
    fs.writeFileSync(partPath, buf.subarray(start, end));
    parts.push(partPath);
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
