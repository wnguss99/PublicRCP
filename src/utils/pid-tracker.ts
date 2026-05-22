import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getDataDirectory } from './paths';
import { getLogger, Logger } from './logger';

export interface TrackedProcess {
  pid: number;
  projectId: string;
  startedAt: string;
}

export interface PidTracker {
  addProcess(pid: number, projectId: string): void;
  removeProcess(pid: number): void;
  getTrackedProcesses(): TrackedProcess[];
  cleanupOrphanProcesses(): Promise<OrphanCleanupResult>;
}

export interface OrphanCleanupResult {
  foundCount: number;
  killedCount: number;
  killedPids: number[];
  failedPids: number[];
  skippedPids: number[]; // PIDs that were reused by different processes
}

interface PidFileSystem {
  readFileSync(filePath: string): string;
  writeFileSync(filePath: string, data: string): void;
  existsSync(filePath: string): boolean;
}

const defaultFs: PidFileSystem = {
  readFileSync: (filePath) => fs.readFileSync(filePath, 'utf-8'),
  writeFileSync: (filePath, data) => fs.writeFileSync(filePath, data, 'utf-8'),
  existsSync: (filePath) => fs.existsSync(filePath),
};

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getProcessCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      // Windows: use wmic to get command line
      const output = execSync(
        `wmic process where processid=${pid} get commandline /format:list`,
        { encoding: 'utf-8', timeout: 5000, windowsHide: true }
      );
      const match = output.match(/CommandLine=(.+)/);
      return match && match[1] ? match[1].trim() : null;
    } else {
      // Unix: use ps to get command line
      const output = execSync(`ps -p ${pid} -o args=`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return output.trim() || null;
    }
  } catch {
    return null;
  }
}

function isClaudeProcess(pid: number): boolean {
  const cmdLine = getProcessCommandLine(pid);

  if (!cmdLine) {
    return false;
  }

  // Check if the command line contains "claude" (case-insensitive)
  // This matches: claude, claude.cmd, @anthropic/claude-code, etc.
  const lowerCmd = cmdLine.toLowerCase();
  return lowerCmd.includes('claude') || lowerCmd.includes('anthropic');
}

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export class FilePidTracker implements PidTracker {
  private readonly filePath: string;
  private readonly fileSystem: PidFileSystem;
  private readonly logger: Logger;
  private processes: TrackedProcess[] = [];

  constructor(fileSystem: PidFileSystem = defaultFs) {
    this.fileSystem = fileSystem;
    this.filePath = path.join(getDataDirectory(), 'pids.json');
    this.logger = getLogger('PidTracker');
    this.loadFromFile();
  }

  private loadFromFile(): void {
    try {
      if (this.fileSystem.existsSync(this.filePath)) {
        const content = this.fileSystem.readFileSync(this.filePath);
        this.processes = JSON.parse(content) as TrackedProcess[];
      }
    } catch {
      this.logger.warn('Failed to load PID file, starting fresh');
      this.processes = [];
    }
  }

  private saveToFile(): void {
    try {
      this.fileSystem.writeFileSync(
        this.filePath,
        JSON.stringify(this.processes, null, 2)
      );
    } catch (error) {
      this.logger.error('Failed to save PID file', { error });
    }
  }

  addProcess(pid: number, projectId: string): void {
    // Remove any existing entry for this PID (shouldn't happen but be safe)
    this.processes = this.processes.filter((p) => p.pid !== pid);

    this.processes.push({
      pid,
      projectId,
      startedAt: new Date().toISOString(),
    });

    this.saveToFile();
    this.logger.debug('Tracking process', { pid, projectId });
  }

  removeProcess(pid: number): void {
    const before = this.processes.length;
    this.processes = this.processes.filter((p) => p.pid !== pid);

    if (this.processes.length !== before) {
      this.saveToFile();
      this.logger.debug('Stopped tracking process', { pid });
    }
  }

  getTrackedProcesses(): TrackedProcess[] {
    return [...this.processes];
  }

  cleanupOrphanProcesses(): Promise<OrphanCleanupResult> {
    const result: OrphanCleanupResult = {
      foundCount: 0,
      killedCount: 0,
      killedPids: [],
      failedPids: [],
      skippedPids: [],
    };

    const stillRunning: TrackedProcess[] = [];

    for (const proc of this.processes) {
      if (isProcessRunning(proc.pid)) {
        result.foundCount++;

        // Verify this PID is actually a Claude process (PIDs can be reused)
        if (!isClaudeProcess(proc.pid)) {
          this.logger.info('PID reused by different process, skipping', {
            pid: proc.pid,
            projectId: proc.projectId,
          });
          result.skippedPids.push(proc.pid);
          continue;
        }

        this.logger.info('Found orphan Claude process, attempting to kill', {
          pid: proc.pid,
          projectId: proc.projectId,
        });

        if (killProcess(proc.pid)) {
          result.killedCount++;
          result.killedPids.push(proc.pid);
          this.logger.info('Killed orphan process', { pid: proc.pid });
        } else {
          result.failedPids.push(proc.pid);
          stillRunning.push(proc);
          this.logger.warn('Failed to kill orphan process', { pid: proc.pid });
        }
      }
    }

    // Update the file with only still-running processes we couldn't kill
    this.processes = stillRunning;
    this.saveToFile();

    return Promise.resolve(result);
  }
}

let sharedPidTracker: PidTracker | null = null;

export function getPidTracker(): PidTracker {
  if (!sharedPidTracker) {
    sharedPidTracker = new FilePidTracker();
  }
  return sharedPidTracker;
}
