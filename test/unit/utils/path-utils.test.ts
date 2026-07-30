import * as path from 'path';

import {
  getHomeDirectory,
  getHomeDirectoryOrDefault,
  generateCacheKey,
  extractFilename,
  extractFilenameWithoutExt,
  normalizePath,
  joinPath,
} from '../../../src/utils/path-utils';

describe('path-utils', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getHomeDirectory', () => {
    it('should return HOME when set', () => {
      process.env = { ...originalEnv, HOME: '/home/testuser', USERPROFILE: undefined };
      expect(getHomeDirectory()).toBe('/home/testuser');
    });

    it('should fall back to USERPROFILE when HOME is not set', () => {
      process.env = { ...originalEnv, HOME: undefined, USERPROFILE: 'C:\\Users\\test' };
      expect(getHomeDirectory()).toBe('C:\\Users\\test');
    });

    it('should throw when neither HOME nor USERPROFILE is set', () => {
      process.env = { ...originalEnv, HOME: undefined, USERPROFILE: undefined };
      expect(() => getHomeDirectory()).toThrow('Unable to determine home directory');
    });
  });

  describe('getHomeDirectoryOrDefault', () => {
    it('should return HOME when set', () => {
      process.env = { ...originalEnv, HOME: '/home/test' };
      expect(getHomeDirectoryOrDefault()).toBe('/home/test');
    });

    it('should return default when neither env var is set', () => {
      process.env = { ...originalEnv, HOME: undefined, USERPROFILE: undefined };
      expect(getHomeDirectoryOrDefault('/fallback')).toBe('/fallback');
    });

    it('should return empty string as default', () => {
      process.env = { ...originalEnv, HOME: undefined, USERPROFILE: undefined };
      expect(getHomeDirectoryOrDefault()).toBe('');
    });
  });

  describe('generateCacheKey', () => {
    it('should join parts with colons', () => {
      expect(generateCacheKey('a', 'b', 'c')).toBe('a:b:c');
    });

    it('should return single part as-is', () => {
      expect(generateCacheKey('solo')).toBe('solo');
    });
  });

  describe('extractFilename', () => {
    it('should extract filename from path', () => {
      expect(extractFilename('/home/user/file.txt')).toBe('file.txt');
    });

    it('should handle just filename', () => {
      expect(extractFilename('file.txt')).toBe('file.txt');
    });
  });

  describe('extractFilenameWithoutExt', () => {
    it('should remove extension', () => {
      expect(extractFilenameWithoutExt('/home/user/file.txt')).toBe('file');
    });

    it('should handle multiple dots', () => {
      expect(extractFilenameWithoutExt('archive.tar.gz')).toBe('archive.tar');
    });

    it('should handle no extension', () => {
      // path.extname('Makefile') is '', so slice(0, -0) returns ''
      expect(extractFilenameWithoutExt('Makefile')).toBe('');
    });
  });




  describe('normalizePath', () => {
    it('should convert backslashes to forward slashes', () => {
      expect(normalizePath('C:\\Users\\test\\file.txt')).toBe('C:/Users/test/file.txt');
    });

    it('should leave forward slashes unchanged', () => {
      expect(normalizePath('/home/user/file.txt')).toBe('/home/user/file.txt');
    });
  });

  describe('joinPath', () => {
    it('should join and normalize', () => {
      const result = joinPath('a', 'b', 'c.txt');
      expect(result).not.toContain('\\');
      expect(result).toContain('a/b/c.txt');
    });
  });
});
