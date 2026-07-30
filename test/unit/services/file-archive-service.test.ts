import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  needsSplit,
  splitArchive,
  cleanupArchive,
  MAX_ATTACHMENT_SIZE,
} from '../../../src/services/file-archive-service';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
}

function createTempFile(dir: string, sizeBytes: number, name = 'test.zip'): string {
  const filePath = path.join(dir, name);
  const buf = crypto.randomBytes(sizeBytes);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

describe('file-archive-service', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('needsSplit', () => {
    it('returns false for non-existent file', () => {
      expect(needsSplit(path.join(tmpDir, 'nope.zip'))).toBe(false);
    });

    it('returns false for file at exactly MAX_ATTACHMENT_SIZE', () => {
      const filePath = createTempFile(tmpDir, MAX_ATTACHMENT_SIZE);
      expect(needsSplit(filePath)).toBe(false);
    });

    it('returns false for file smaller than MAX_ATTACHMENT_SIZE', () => {
      const filePath = createTempFile(tmpDir, 100);
      expect(needsSplit(filePath)).toBe(false);
    });

    it('returns true for file larger than MAX_ATTACHMENT_SIZE', () => {
      const filePath = createTempFile(tmpDir, MAX_ATTACHMENT_SIZE + 1);
      expect(needsSplit(filePath)).toBe(true);
    });
  });

  describe('splitArchive', () => {
    const CHUNK = 100;

    it('splits file into correct number of parts', async () => {
      const filePath = createTempFile(tmpDir, 250, 'split-test.zip');
      const result = await splitArchive(filePath, CHUNK);

      expect(result.totalParts).toBe(3);
      expect(result.parts).toHaveLength(3);
      expect(result.originalSize).toBe(250);
    });

    it('part filenames use .001 .002 .003 pattern', async () => {
      const filePath = createTempFile(tmpDir, 250, 'naming.zip');
      const result = await splitArchive(filePath, CHUNK);

      expect(result.parts[0]).toMatch(/naming\.zip\.001$/);
      expect(result.parts[1]).toMatch(/naming\.zip\.002$/);
      expect(result.parts[2]).toMatch(/naming\.zip\.003$/);
    });

    it('deletes the original file after splitting', async () => {
      const filePath = createTempFile(tmpDir, 250, 'original.zip');
      await splitArchive(filePath, CHUNK);

      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('all parts exist on disk and total bytes match original', async () => {
      const filePath = createTempFile(tmpDir, 250, 'bytes.zip');
      const originalBuf = fs.readFileSync(filePath);
      const result = await splitArchive(filePath, CHUNK);

      let totalBytes = 0;
      const reassembled = Buffer.alloc(250);
      for (let i = 0; i < result.parts.length; i++) {
        const partPath = result.parts[i]!;
        expect(fs.existsSync(partPath)).toBe(true);
        const partBuf = fs.readFileSync(partPath);
        partBuf.copy(reassembled, i * CHUNK);
        totalBytes += partBuf.length;
      }

      expect(totalBytes).toBe(250);
      expect(reassembled.equals(originalBuf)).toBe(true);
    });

    it('handles file size that is exact multiple of chunk', async () => {
      const filePath = createTempFile(tmpDir, 200, 'exact.zip');
      const result = await splitArchive(filePath, CHUNK);

      expect(result.totalParts).toBe(2);
      expect(result.parts).toHaveLength(2);

      const part1Size = fs.statSync(result.parts[0]!).size;
      const part2Size = fs.statSync(result.parts[1]!).size;
      expect(part1Size).toBe(100);
      expect(part2Size).toBe(100);
    });

    it('handles file with only 1 byte over chunk boundary', async () => {
      const filePath = createTempFile(tmpDir, CHUNK + 1, 'boundary.zip');
      const result = await splitArchive(filePath, CHUNK);

      expect(result.totalParts).toBe(2);
      const part1Size = fs.statSync(result.parts[0]!).size;
      const part2Size = fs.statSync(result.parts[1]!).size;
      expect(part1Size).toBe(CHUNK);
      expect(part2Size).toBe(1);
    });

    it('single part when file equals chunk size', async () => {
      const filePath = createTempFile(tmpDir, CHUNK, 'single.zip');
      const result = await splitArchive(filePath, CHUNK);

      expect(result.totalParts).toBe(1);
      expect(result.parts).toHaveLength(1);
      expect(fs.statSync(result.parts[0]!).size).toBe(CHUNK);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('cleans up partial parts on error and preserves original', async () => {
      const filePath = createTempFile(tmpDir, 250, 'fail.zip');
      const readonlyDir = path.join(tmpDir, 'readonly');
      fs.mkdirSync(readonlyDir);
      const srcPath = path.join(readonlyDir, 'fail.zip');
      fs.copyFileSync(filePath, srcPath);

      const badPartPath = `${srcPath}.${String(3).padStart(3, '0')}`;
      fs.mkdirSync(badPartPath);

      await expect(splitArchive(srcPath, CHUNK)).rejects.toThrow();

      expect(fs.existsSync(srcPath)).toBe(true);

      const partCandidates = [
        `${srcPath}.001`,
        `${srcPath}.002`,
      ];
      for (const p of partCandidates) {
        expect(fs.existsSync(p)).toBe(false);
      }

      fs.rmdirSync(badPartPath);
    });

    it('throws on non-existent file', async () => {
      await expect(splitArchive(path.join(tmpDir, 'nope.zip'), CHUNK))
        .rejects.toThrow();
    });
  });

  describe('cleanupArchive', () => {
    it('deletes existing file', () => {
      const filePath = createTempFile(tmpDir, 10, 'cleanup.zip');
      cleanupArchive(filePath);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('does not throw for non-existent file', () => {
      expect(() => cleanupArchive(path.join(tmpDir, 'nope.zip'))).not.toThrow();
    });
  });
});
