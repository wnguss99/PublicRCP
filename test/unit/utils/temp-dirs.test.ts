import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getInstanceTempDir,
  getInstanceTempDirPath,
  pruneStaleInstanceTempDirs,
  pruneAbandonedTempFiles,
} from '../../../src/utils/temp-dirs';

jest.mock('fs');
jest.mock('os');

jest.mock('../../../src/utils/logger', () => ({
  getLogger: (): unknown => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

function dirent(name: string, isDir = true): fs.Dirent {
  return { name, isDirectory: () => isDir } as fs.Dirent;
}

describe('instance temp directories', () => {
  const mcpRoot = path.join('/tmp', 'claudito-mcp');
  const archiveRoot = path.join('/tmp', 'claudito-archives');

  beforeEach(() => {
    jest.resetAllMocks();
    mockOs.tmpdir.mockReturnValue('/tmp');
  });

  describe('getInstanceTempDir', () => {
    it('should scope the directory to this process so instances never collide', () => {
      mockFs.existsSync.mockReturnValue(true);

      expect(getInstanceTempDir('claudito-mcp')).toBe(path.join(mcpRoot, String(process.pid)));
    });

    it('should create the directory when missing', () => {
      mockFs.existsSync.mockReturnValue(false);

      getInstanceTempDir('claudito-archives');

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        path.join(archiveRoot, String(process.pid)),
        { recursive: true },
      );
    });

    it('getInstanceTempDirPath should not create anything', () => {
      expect(getInstanceTempDirPath('claudito-mcp')).toBe(path.join(mcpRoot, String(process.pid)));
      expect(mockFs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('pruneStaleInstanceTempDirs', () => {
    // Every restart creates a new PID-named folder. Eleven piled up in two hours
    // before anything pruned them, and a factory reset only removed the current
    // PID's folder.
    it('should remove directories of processes that no longer exist', () => {
      const deadPid = 999999999;
      mockFs.existsSync.mockImplementation((p) => p === mcpRoot);
      mockFs.readdirSync.mockReturnValue([dirent(String(deadPid))] as never);

      const removed = pruneStaleInstanceTempDirs();

      expect(removed).toEqual([path.join(mcpRoot, String(deadPid))]);
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        path.join(mcpRoot, String(deadPid)),
        { recursive: true, force: true },
      );
    });

    it('should never remove a live instance directory', () => {
      mockFs.existsSync.mockImplementation((p) => p === mcpRoot);
      mockFs.readdirSync.mockReturnValue([dirent(String(process.pid))] as never);

      expect(pruneStaleInstanceTempDirs()).toEqual([]);
      expect(mockFs.rmSync).not.toHaveBeenCalled();
    });

    it('should remove loose files left by the old shared-folder layout', () => {
      mockFs.existsSync.mockImplementation((p) => p === mcpRoot);
      mockFs.readdirSync.mockReturnValue([dirent('mcp-Legacy-123.json', false)] as never);

      expect(pruneStaleInstanceTempDirs()).toEqual([path.join(mcpRoot, 'mcp-Legacy-123.json')]);
    });

    it('should ignore directories that are not PID-shaped', () => {
      mockFs.existsSync.mockImplementation((p) => p === mcpRoot);
      mockFs.readdirSync.mockReturnValue([dirent('not-a-pid')] as never);

      expect(pruneStaleInstanceTempDirs()).toEqual([]);
      expect(mockFs.rmSync).not.toHaveBeenCalled();
    });

    it('should not throw when the root cannot be read', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockImplementation(() => {
        throw new Error('EPERM');
      });

      expect(() => pruneStaleInstanceTempDirs()).not.toThrow();
    });

    it('should not throw when readdir returns something unexpected', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(undefined as never);

      expect(() => pruneStaleInstanceTempDirs()).not.toThrow();
    });

    it('should survive a failing delete', () => {
      mockFs.existsSync.mockImplementation((p) => p === mcpRoot);
      mockFs.readdirSync.mockReturnValue([dirent('999999999')] as never);
      mockFs.rmSync.mockImplementation(() => {
        throw new Error('locked');
      });

      expect(pruneStaleInstanceTempDirs()).toEqual([]);
    });
  });
});

describe('pruneAbandonedTempFiles', () => {
  // A 1.7 MB conversation temp file from a month earlier was still in the data
  // dir: every interrupted write-temp-then-rename leaked one and nothing swept.
  const dataDir = '/data';
  const hourMs = 60 * 60 * 1000;

  beforeEach(() => {
    jest.resetAllMocks();
    mockOs.tmpdir.mockReturnValue('/tmp');
  });

  function file(name: string): fs.Dirent {
    return { name, isDirectory: () => false } as fs.Dirent;
  }

  it('should remove an abandoned temp file', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([file('status.json.tmp')] as never);
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() - 2 * hourMs } as never);

    const removed = pruneAbandonedTempFiles(dataDir);

    expect(removed).toEqual([path.join(dataDir, 'status.json.tmp')]);
  });

  it('should leave an in-flight temp file alone', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([file('status.json.tmp')] as never);
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as never);

    expect(pruneAbandonedTempFiles(dataDir)).toEqual([]);
    expect(mockFs.rmSync).not.toHaveBeenCalled();
  });

  it('should ignore files that are not .tmp', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([file('status.json')] as never);

    expect(pruneAbandonedTempFiles(dataDir)).toEqual([]);
    expect(mockFs.rmSync).not.toHaveBeenCalled();
  });

  it('should do nothing when the data dir does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    expect(pruneAbandonedTempFiles(dataDir)).toEqual([]);
  });

  it('should not throw when a directory cannot be read', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation(() => {
      throw new Error('EPERM');
    });

    expect(() => pruneAbandonedTempFiles(dataDir)).not.toThrow();
  });
});
