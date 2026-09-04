import * as fs from 'fs';
import {
  atomicWriteFile,
  ensureDirectoryExists,
  ensureDirectoryExistsAsync,
  readFileWithFallback,
  deleteFileIfExists,
  safeReadDir,
  RENAME_ATTEMPTS,
} from '../../../src/utils/file-system-utils';

jest.mock('fs', () => ({
  promises: {
    writeFile: jest.fn(),
    rename: jest.fn(),
    access: jest.fn(),
    mkdir: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
    readdir: jest.fn(),
  },
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  rmdirSync: jest.fn(),
  renameSync: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  getLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockFsPromises = fs.promises as jest.Mocked<typeof fs.promises>;

describe('file-system-utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('atomicWriteFile', () => {
    /**
     * The temp name carries pid + counter rather than a fixed `<file>.tmp`, so two
     * overlapping writes to the same file cannot share one temp path and publish a
     * mix of both. Assert the shape, not an exact string.
     */
    it('should write to a unique temp file then rename onto the target', async () => {
      mockFsPromises.writeFile.mockResolvedValue();
      mockFsPromises.rename.mockResolvedValue();

      await atomicWriteFile('/test/file.json', '{"data":true}');

      const [tempPath, contents, encoding] = mockFsPromises.writeFile.mock.calls[0]!;
      expect(String(tempPath)).toMatch(/^\/test\/file\.json\.\d+\.\d+\.tmp$/);
      expect(contents).toBe('{"data":true}');
      expect(encoding).toBe('utf-8');

      expect(mockFsPromises.rename).toHaveBeenCalledWith(tempPath, '/test/file.json');
    });

    /**
     * 176 conversation saves were lost to `EPERM ... rename '<file>.json.tmp' ->
     * '<file>.json'` on these instances. Windows blocks the swap while any process
     * holds the destination open (Defender, the indexer), the callers only log the
     * failure, and the message never reached disk — it simply disappeared on the
     * next reload. The write had already succeeded; only the swap was blocked, for
     * an instant.
     */
    it('retries a rename blocked by a transient Windows lock', async () => {
      mockFsPromises.writeFile.mockResolvedValue();
      const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
      mockFsPromises.rename
        .mockRejectedValueOnce(eperm)
        .mockRejectedValueOnce(eperm)
        .mockResolvedValue(undefined);

      await expect(atomicWriteFile('/test/file.json', 'x')).resolves.toBeUndefined();

      expect(mockFsPromises.rename).toHaveBeenCalledTimes(3);
      // The data must not be deleted while retries are still possible.
      expect(mockFsPromises.unlink).not.toHaveBeenCalled();
    });

    it('gives up and cleans the temp file if the lock never clears', async () => {
      mockFsPromises.writeFile.mockResolvedValue();
      const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
      mockFsPromises.rename.mockRejectedValue(eperm);
      mockFsPromises.unlink.mockResolvedValue();

      jest.useFakeTimers();

      try {
        const write = atomicWriteFile('/test/file.json', 'x');
        const assertion = expect(write).rejects.toThrow('EPERM');
        await jest.runAllTimersAsync();
        await assertion;
      } finally {
        jest.useRealTimers();
      }

      expect(mockFsPromises.rename).toHaveBeenCalledTimes(RENAME_ATTEMPTS);
      expect(mockFsPromises.unlink).toHaveBeenCalled();
    });

    /**
     * The budget used to be 5 attempts on a 20ms linear backoff — 200ms in
     * total — and on 2026-08-31 a conversation save burned all five and lost
     * the write. That file is ~5 MB; Defender holds a handle for as long as it
     * takes to scan it, which is nowhere near 200ms.
     */
    it('outlasts far more consecutive locks than the old 5-attempt budget', async () => {
      mockFsPromises.writeFile.mockResolvedValue();
      const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
      mockFsPromises.rename.mockReset();

      for (let i = 0; i < RENAME_ATTEMPTS - 1; i++) {
        mockFsPromises.rename.mockRejectedValueOnce(eperm);
      }
      mockFsPromises.rename.mockResolvedValue(undefined);

      jest.useFakeTimers();

      try {
        const write = atomicWriteFile('/test/file.json', 'x');
        await jest.runAllTimersAsync();
        await expect(write).resolves.toBeUndefined();
      } finally {
        jest.useRealTimers();
      }

      expect(mockFsPromises.rename).toHaveBeenCalledTimes(RENAME_ATTEMPTS);
      // The data survives every retry — deleting it early is the loss itself.
      expect(mockFsPromises.unlink).not.toHaveBeenCalled();
    });

    it('keeps enough patience to be worth the wait', () => {
      // Guards the constant against being trimmed back to something that
      // cannot outlast a virus scan of a multi-megabyte file.
      expect(RENAME_ATTEMPTS).toBeGreaterThanOrEqual(8);
    });

    it('does not retry an error that will never clear', async () => {
      mockFsPromises.writeFile.mockResolvedValue();
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockFsPromises.rename.mockRejectedValue(enoent);
      mockFsPromises.unlink.mockResolvedValue();

      await expect(atomicWriteFile('/test/file.json', 'x')).rejects.toThrow('ENOENT');

      // Retrying a permanent failure only delays reporting it.
      expect(mockFsPromises.rename).toHaveBeenCalledTimes(1);
    });

    it('should use custom encoding', async () => {
      mockFsPromises.writeFile.mockResolvedValue();
      mockFsPromises.rename.mockResolvedValue();

      await atomicWriteFile('/test/file.bin', 'data', 'ascii');

      const [tempPath, , encoding] = mockFsPromises.writeFile.mock.calls[0]!;
      expect(String(tempPath)).toMatch(/^\/test\/file\.bin\.\d+\.\d+\.tmp$/);
      expect(encoding).toBe('ascii');
    });
  });

  describe('ensureDirectoryExists', () => {
    it('should do nothing when directory exists', () => {
      const mockFileSystem = {
        readFileSync: jest.fn(),
        writeFileSync: jest.fn(),
        existsSync: jest.fn().mockReturnValue(true),
        mkdirSync: jest.fn(),
        rmdirSync: jest.fn(),
        renameSync: jest.fn(),
        readdirSync: jest.fn().mockReturnValue([]),
      };

      ensureDirectoryExists('/existing/dir', mockFileSystem);

      expect(mockFileSystem.existsSync).toHaveBeenCalledWith('/existing/dir');
      expect(mockFileSystem.mkdirSync).not.toHaveBeenCalled();
    });

    it('should create directory when it does not exist', () => {
      const mockFileSystem = {
        readFileSync: jest.fn(),
        writeFileSync: jest.fn(),
        existsSync: jest.fn().mockReturnValue(false),
        mkdirSync: jest.fn(),
        rmdirSync: jest.fn(),
        renameSync: jest.fn(),
        readdirSync: jest.fn().mockReturnValue([]),
      };

      ensureDirectoryExists('/new/dir', mockFileSystem);

      expect(mockFileSystem.mkdirSync).toHaveBeenCalledWith(
        '/new/dir', { recursive: true }
      );
    });

    it('should use default filesystem when none provided', () => {
      mockFs.existsSync.mockReturnValue(true);

      ensureDirectoryExists('/some/dir');

      expect(mockFs.existsSync).toHaveBeenCalledWith('/some/dir');
    });
  });

  describe('ensureDirectoryExistsAsync', () => {
    it('should do nothing when directory exists', async () => {
      mockFsPromises.access.mockResolvedValue();

      await ensureDirectoryExistsAsync('/existing/dir');

      expect(mockFsPromises.access).toHaveBeenCalledWith('/existing/dir');
      expect(mockFsPromises.mkdir).not.toHaveBeenCalled();
    });

    it('should create directory when access fails', async () => {
      mockFsPromises.access.mockRejectedValue(new Error('ENOENT'));
      mockFsPromises.mkdir.mockResolvedValue(undefined);

      await ensureDirectoryExistsAsync('/new/dir');

      expect(mockFsPromises.mkdir).toHaveBeenCalledWith(
        '/new/dir', { recursive: true }
      );
    });
  });

  describe('readFileWithFallback', () => {
    it('should return parsed content on success', async () => {
      mockFsPromises.readFile.mockResolvedValue('{"key":"value"}');

      const result = await readFileWithFallback('/test/file.json', {});

      expect(result).toEqual({ key: 'value' });
    });

    it('should use custom parser', async () => {
      mockFsPromises.readFile.mockResolvedValue('hello');
      const parser = (data: string) => data.toUpperCase();

      const result = await readFileWithFallback('/test/file', '', parser);

      expect(result).toBe('HELLO');
    });

    it('should return fallback for ENOENT', async () => {
      const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      mockFsPromises.readFile.mockRejectedValue(enoentError);

      const result = await readFileWithFallback('/missing.json', { default: true });

      expect(result).toEqual({ default: true });
    });

    it('should return fallback for other errors', async () => {
      mockFsPromises.readFile.mockRejectedValue(new Error('EPERM'));

      const result = await readFileWithFallback('/test/file.json', []);

      expect(result).toEqual([]);
    });
  });

  describe('deleteFileIfExists', () => {
    it('should return true on successful deletion', async () => {
      mockFsPromises.unlink.mockResolvedValue();

      const result = await deleteFileIfExists('/test/file.txt');

      expect(result).toBe(true);
      expect(mockFsPromises.unlink).toHaveBeenCalledWith('/test/file.txt');
    });

    it('should return false for ENOENT', async () => {
      const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      mockFsPromises.unlink.mockRejectedValue(enoentError);

      const result = await deleteFileIfExists('/missing.txt');

      expect(result).toBe(false);
    });

    it('should throw for other errors', async () => {
      const error = new Error('EPERM');
      mockFsPromises.unlink.mockRejectedValue(error);

      await expect(deleteFileIfExists('/test/file.txt')).rejects.toThrow('EPERM');
    });
  });

  describe('safeReadDir', () => {
    it('should return directory contents on success', async () => {
      (mockFsPromises.readdir as jest.Mock).mockResolvedValue(
        ['file1.txt', 'file2.txt']
      );

      const result = await safeReadDir('/test/dir');

      expect(result).toEqual(['file1.txt', 'file2.txt']);
    });

    it('should return null for ENOENT', async () => {
      const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      mockFsPromises.readdir.mockRejectedValue(enoentError);

      const result = await safeReadDir('/missing/dir');

      expect(result).toBeNull();
    });

    it('should throw for other errors', async () => {
      const error = new Error('EACCES');
      mockFsPromises.readdir.mockRejectedValue(error);

      await expect(safeReadDir('/test/dir')).rejects.toThrow('EACCES');
    });
  });
});
