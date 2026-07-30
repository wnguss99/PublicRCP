import { FilePidTracker, TrackedProcess } from '../../../src/utils/pid-tracker';

// Mock dependencies
jest.mock('../../../src/utils/paths', () => ({
  getDataDirectory: jest.fn().mockReturnValue('/mock/data'),
}));

jest.mock('../../../src/utils/logger', () => ({
  getLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

// Create a mock file system for testing
function createMockFileSystem() {
  return {
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    existsSync: jest.fn(),
  };
}

describe('FilePidTracker', () => {
  let mockFs: ReturnType<typeof createMockFileSystem>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs = createMockFileSystem();
    mockFs.existsSync.mockReturnValue(false);
  });

  describe('constructor and initialization', () => {
    it('should create tracker with empty processes when file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const tracker = new FilePidTracker(mockFs);

      expect(tracker.getTrackedProcesses()).toEqual([]);
      expect(mockFs.existsSync).toHaveBeenCalled();
    });

    it('should load existing processes from file', () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
        { pid: 5678, projectId: 'project-2', startedAt: '2024-01-01T01:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      const tracker = new FilePidTracker(mockFs);

      expect(tracker.getTrackedProcesses()).toEqual(existingProcesses);
    });

    it('should handle invalid JSON in file gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const tracker = new FilePidTracker(mockFs);

      expect(tracker.getTrackedProcesses()).toEqual([]);
    });

    it('should handle file read error gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('File read error');
      });

      const tracker = new FilePidTracker(mockFs);

      expect(tracker.getTrackedProcesses()).toEqual([]);
    });
  });

  describe('addProcess', () => {
    it('should add a new process to tracking', () => {
      const tracker = new FilePidTracker(mockFs);

      tracker.addProcess(1234, 'project-1');

      const processes = tracker.getTrackedProcesses();
      expect(processes).toHaveLength(1);
      expect(processes[0]?.pid).toBe(1234);
      expect(processes[0]?.projectId).toBe('project-1');
      expect(processes[0]?.startedAt).toBeDefined();
    });

    it('should save to file after adding process', () => {
      const tracker = new FilePidTracker(mockFs);

      tracker.addProcess(1234, 'project-1');

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const writtenContent = mockFs.writeFileSync.mock.calls[0][1];
      const parsed = JSON.parse(writtenContent);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].pid).toBe(1234);
    });

    it('should replace existing entry for same PID', () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'old-project', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      const tracker = new FilePidTracker(mockFs);
      tracker.addProcess(1234, 'new-project');

      const processes = tracker.getTrackedProcesses();
      expect(processes).toHaveLength(1);
      expect(processes[0]?.projectId).toBe('new-project');
    });

    it('should allow multiple processes from different projects', () => {
      const tracker = new FilePidTracker(mockFs);

      tracker.addProcess(1234, 'project-1');
      tracker.addProcess(5678, 'project-2');
      tracker.addProcess(9012, 'project-1');

      const processes = tracker.getTrackedProcesses();
      expect(processes).toHaveLength(3);
    });

    it('should handle file write error gracefully', () => {
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('Write error');
      });

      const tracker = new FilePidTracker(mockFs);

      // Should not throw
      expect(() => tracker.addProcess(1234, 'project-1')).not.toThrow();

      // Process should still be in memory
      expect(tracker.getTrackedProcesses()).toHaveLength(1);
    });
  });

  describe('removeProcess', () => {
    it('should remove a tracked process', () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
        { pid: 5678, projectId: 'project-2', startedAt: '2024-01-01T01:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      const tracker = new FilePidTracker(mockFs);
      tracker.removeProcess(1234);

      const processes = tracker.getTrackedProcesses();
      expect(processes).toHaveLength(1);
      expect(processes[0]?.pid).toBe(5678);
    });

    it('should save to file after removing process', () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      const tracker = new FilePidTracker(mockFs);
      mockFs.writeFileSync.mockClear();

      tracker.removeProcess(1234);

      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should not save if PID was not tracked', () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      const tracker = new FilePidTracker(mockFs);
      mockFs.writeFileSync.mockClear();

      tracker.removeProcess(9999);

      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should handle removing from empty list', () => {
      const tracker = new FilePidTracker(mockFs);

      expect(() => tracker.removeProcess(1234)).not.toThrow();
      expect(tracker.getTrackedProcesses()).toEqual([]);
    });
  });

  describe('getTrackedProcesses', () => {
    it('should return a copy of the processes array', () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      const tracker = new FilePidTracker(mockFs);
      const processes = tracker.getTrackedProcesses();

      // Modify the returned array
      processes.push({ pid: 9999, projectId: 'modified', startedAt: 'now' });

      // Original should be unchanged
      expect(tracker.getTrackedProcesses()).toHaveLength(1);
    });
  });

  describe('cleanupOrphanProcesses', () => {
    let originalProcessKill: typeof process.kill;
    let mockExecSync: jest.Mock;

    beforeEach(() => {
      originalProcessKill = process.kill;
      process.kill = jest.fn();
      mockExecSync = require('child_process').execSync;
    });

    afterEach(() => {
      process.kill = originalProcessKill;
    });

    it('should return empty result when no processes are tracked', async () => {
      const tracker = new FilePidTracker(mockFs);

      const result = await tracker.cleanupOrphanProcesses();

      expect(result).toEqual({
        foundCount: 0,
        killedCount: 0,
        killedPids: [],
        failedPids: [],
        skippedPids: [],
      });
    });

    it('should not count processes that are not running', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      // Process is not running (kill(pid, 0) throws)
      (process.kill as jest.Mock).mockImplementation(() => {
        throw new Error('Process not found');
      });

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      expect(result.foundCount).toBe(0);
    });

    it('should kill orphan Claude processes', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      // Process is running
      (process.kill as jest.Mock)
        .mockImplementationOnce(() => true) // First call: check if running (pid, 0)
        .mockImplementationOnce(() => true); // Second call: kill (pid, SIGTERM)

      // Is a Claude process
      mockExecSync.mockReturnValue('CREATED=2024-01-01T00:00:00.0000000Z\nCMD=node claude --session-id abc123');

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      expect(result.foundCount).toBe(1);
      expect(result.killedCount).toBe(1);
      expect(result.killedPids).toContain(1234);
    });

    it('should skip processes that are not Claude processes', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      // Process is running
      (process.kill as jest.Mock).mockImplementation(() => true);

      // PID reused: the live process was created long after we recorded ours.
      mockExecSync.mockReturnValue('CREATED=2024-06-01T00:00:00.0000000Z\nCMD=node some-other-app');

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      expect(result.foundCount).toBe(1);
      expect(result.skippedPids).toContain(1234);
      expect(result.killedCount).toBe(0);
    });

    it('should kill our process even when the command line does not say claude', async () => {
      // Windows wraps the CLI in cmd.exe, whose command line may not contain the
      // word "claude". Creation time is what proves it is ours.
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      (process.kill as jest.Mock).mockImplementation(() => true);
      mockExecSync.mockReturnValue('CREATED=2024-01-01T00:00:00.0000000Z\nCMD=C:\\WINDOWS\\system32\\cmd.exe');

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      expect(result.killedPids).toContain(1234);
      expect(result.killedCount).toBe(1);
    });

    it('should track failed kills', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      // Process is running but kill fails
      (process.kill as jest.Mock)
        .mockImplementationOnce(() => true) // Check if running
        .mockImplementationOnce(() => {
          throw new Error('Permission denied');
        }); // Kill fails

      // Is a Claude process
      mockExecSync.mockReturnValue('CREATED=2024-01-01T00:00:00.0000000Z\nCMD=node claude');

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      expect(result.foundCount).toBe(1);
      expect(result.killedCount).toBe(0);
      expect(result.failedPids).toContain(1234);
    });

    it('should update file with only failed-to-kill processes', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
        { pid: 5678, projectId: 'project-2', startedAt: '2024-01-01T01:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      // Both processes running
      let callCount = 0;
      (process.kill as jest.Mock).mockImplementation(() => {
        callCount++;
        // First process: check passes, kill succeeds
        // Second process: check passes, kill fails
        if (callCount === 4) {
          throw new Error('Permission denied');
        }
        return true;
      });

      // Both are Claude processes. Creation time has to match each entry's
      // startedAt or the reuse guard treats the PID as recycled.
      mockExecSync.mockImplementation((cmd: string) => {
        const created = cmd.includes('5678') ? '2024-01-01T01:00:00.0000000Z' : '2024-01-01T00:00:00.0000000Z';
        return `CREATED=${created}\nCMD=node claude`;
      });

      const tracker = new FilePidTracker(mockFs);
      mockFs.writeFileSync.mockClear();

      await tracker.cleanupOrphanProcesses();

      // Should save with only the failed process
      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const savedContent = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
      expect(savedContent).toHaveLength(1);
      expect(savedContent[0]?.pid).toBe(5678);
    });

    it('should handle multiple processes with mixed results', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1000, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' }, // not running
        { pid: 2000, projectId: 'project-2', startedAt: '2024-01-01T01:00:00Z' }, // running, claude, killed
        { pid: 3000, projectId: 'project-3', startedAt: '2024-01-01T02:00:00Z' }, // running, not claude (skipped)
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      (process.kill as jest.Mock).mockImplementation((pid: number, _signal: string | number) => {
        if (pid === 1000) {
          throw new Error('Not running');
        }
        return true;
      });

      // 2000: creation time matches what we recorded => ours, killed.
      // 3000: created months later => the PID was recycled, skipped.
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('2000')) {
          return 'CREATED=2024-01-01T01:00:00.0000000Z\nCMD=node claude';
        }
        return 'CREATED=2024-06-01T00:00:00.0000000Z\nCMD=node other-app';
      });

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      expect(result.foundCount).toBe(2); // 2000 and 3000 are running
      expect(result.killedCount).toBe(1); // Only 2000 killed
      expect(result.killedPids).toEqual([2000]);
      expect(result.skippedPids).toEqual([3000]);
    });

    it('should detect Claude process by anthropic in command line', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      (process.kill as jest.Mock).mockImplementation(() => true);
      mockExecSync.mockReturnValue('CREATED=2024-01-01T00:00:00.0000000Z\nCMD=node @anthropic/claude-code');

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      expect(result.killedCount).toBe(1);
    });

    it('should handle null command line', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      (process.kill as jest.Mock).mockImplementation(() => true);
      mockExecSync.mockReturnValue(''); // Empty command line

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      // Should not be identified as Claude process
      expect(result.skippedPids).toContain(1234);
      expect(result.killedCount).toBe(0);
    });

    it('should skip a PID whose creation time does not match the tracked start', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      (process.kill as jest.Mock).mockImplementation(() => true);

      // The OS reports a process created a year later — the PID was recycled onto
      // something else, even though its command line mentions claude (which is
      // exactly what happens when another instance's agent lands on this PID).
      mockExecSync.mockReturnValue('CREATED=2025-01-01T00:00:00.0000000Z\nCMD=node claude');

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      expect(result.skippedPids).toContain(1234);
      expect(result.killedCount).toBe(0);
    });

    it('should kill by creation time when the command line is unreadable', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      (process.kill as jest.Mock).mockImplementation(() => true);

      // A more privileged process hides its command line. Creation time still
      // identifies it, so the orphan gets cleaned instead of leaking forever.
      mockExecSync.mockReturnValue('CREATED=2024-01-01T00:00:00.0000000Z\nCMD=');

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      expect(result.killedPids).toContain(1234);
      expect(result.killedCount).toBe(1);
    });

    it('should not shell out to wmic (removed in current Windows builds)', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      (process.kill as jest.Mock).mockImplementation(() => true);
      mockExecSync.mockReturnValue('CREATED=2024-01-01T00:00:00.0000000Z\nCMD=node claude');

      const tracker = new FilePidTracker(mockFs);
      await tracker.cleanupOrphanProcesses();

      const commands = mockExecSync.mock.calls.map((call) => String(call[0]));
      expect(commands.some((cmd) => cmd.includes('wmic'))).toBe(false);
    });

    it('should handle execSync timeout', async () => {
      const existingProcesses: TrackedProcess[] = [
        { pid: 1234, projectId: 'project-1', startedAt: '2024-01-01T00:00:00Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingProcesses));

      (process.kill as jest.Mock).mockImplementation(() => true);
      mockExecSync.mockImplementation(() => {
        throw new Error('Command timed out');
      });

      const tracker = new FilePidTracker(mockFs);
      const result = await tracker.cleanupOrphanProcesses();

      // Should not be identified as Claude process when command fails
      expect(result.skippedPids).toContain(1234);
    });
  });
});
