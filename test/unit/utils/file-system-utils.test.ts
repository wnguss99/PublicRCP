import * as fs from 'fs';
import {
  atomicWriteFile,
  ensureDirectoryExists,
  ensureDirectoryExistsAsync,
  readFileWithFallback,
  deleteFileIfExists,
  safeReadDir,
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
    it('should write to temp file then rename', async () => {
      mockFsPromises.writeFile.mockResolvedValue();
      mockFsPromises.rename.mockResolvedValue();

      await atomicWriteFile('/test/file.json', '{"data":true}');

      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        '/test/file.json.tmp', '{"data":true}', 'utf-8'
      );
      expect(mockFsPromises.rename).toHaveBeenCalledWith(
        '/test/file.json.tmp', '/test/file.json'
      );
    });

    it('should use custom encoding', async () => {
      mockFsPromises.writeFile.mockResolvedValue();
      mockFsPromises.rename.mockResolvedValue();

      await atomicWriteFile('/test/file.bin', 'data', 'ascii');

      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        '/test/file.bin.tmp', 'data', 'ascii'
      );
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
