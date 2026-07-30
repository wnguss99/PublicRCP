import path from 'path';

// Mock fs before importing the module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock os
jest.mock('os', () => ({
  homedir: jest.fn().mockReturnValue('/mock/home'),
}));

import { getDataDirectory } from '../../../src/utils/paths';
import fs from 'fs';
import os from 'os';

describe('paths utilities', () => {
  const originalHome = process.env.CLAUDITO_HOME;

  beforeEach(() => {
    jest.clearAllMocks();
    // The test harness sets CLAUDITO_HOME globally (so no test writes into a live
    // instance's data dir). These cases cover the homedir fallback, so clear it.
    delete process.env.CLAUDITO_HOME;
  });

  afterAll(() => {
    if (originalHome === undefined) {
      delete process.env.CLAUDITO_HOME;
    } else {
      process.env.CLAUDITO_HOME = originalHome;
    }
  });

  describe('CLAUDITO_HOME override', () => {
    it('should use CLAUDITO_HOME instead of the home directory', () => {
      // This is what separates the per-port instances from each other.
      process.env.CLAUDITO_HOME = path.join('/instances', 'user2');
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      expect(getDataDirectory()).toBe(path.join('/instances', 'user2'));
      expect(os.homedir).not.toHaveBeenCalled();
    });

    it('should create the CLAUDITO_HOME directory when missing', () => {
      process.env.CLAUDITO_HOME = path.join('/instances', 'user3');
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      getDataDirectory();

      expect(fs.mkdirSync).toHaveBeenCalledWith(path.join('/instances', 'user3'), { recursive: true });
    });

    it('should fall back to the home directory when CLAUDITO_HOME is empty', () => {
      process.env.CLAUDITO_HOME = '';
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      expect(getDataDirectory()).toBe(path.join('/mock/home', '.claudito'));
    });
  });

  describe('getDataDirectory', () => {
    it('should return path to .claudito in home directory', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const result = getDataDirectory();

      expect(result).toBe(path.join('/mock/home', '.claudito'));
    });

    it('should create directory if it does not exist', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      getDataDirectory();

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join('/mock/home', '.claudito'),
        { recursive: true }
      );
    });

    it('should not create directory if it already exists', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      getDataDirectory();

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should use os.homedir to get home directory', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      getDataDirectory();

      expect(os.homedir).toHaveBeenCalled();
    });

    it('should handle different home directory paths', () => {
      (os.homedir as jest.Mock).mockReturnValue('/users/testuser');
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const result = getDataDirectory();

      expect(result).toBe(path.join('/users/testuser', '.claudito'));
    });

    it('should return consistent path on multiple calls', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const result1 = getDataDirectory();
      const result2 = getDataDirectory();

      expect(result1).toBe(result2);
    });
  });
});
