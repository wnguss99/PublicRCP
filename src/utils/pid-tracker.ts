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
  /** Optional so existing test doubles keep working; enables atomic saves. */
  renameSync?(oldPath: string, newPath: string): void;
}

const defaultFs: PidFileSystem = {
  readFileSync: (filePath) => fs.readFileSync(filePath, 'utf-8'),
  writeFileSync: (filePath, data) => fs.writeFileSync(filePath, data, 'utf-8'),
  existsSync: (filePath) => fs.existsSync(filePath),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
};

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProcessDetail {
  commandLine: string | null;
  /** Process creation time in epoch ms, when the platform reports it. */
  createdAtMs: number | null;
}

/**
 * A PID may have been recycled onto an unrelated process since we recorded it.
 * We record `startedAt` at spawn time, so the OS-reported creation time of our
 * own process is within seconds; anything further apart is a different process.
 */
const PID_REUSE_TOLERANCE_MS = 60 * 1000;

function getProcessDetail(pid: number): ProcessDetail {
  try {
    if (process.platform === 'win32') {
      // NOT wmic: it is removed from Windows 11 24H2+ (this host has no wmic at
      // all), which made every lookup fail, every orphan look like a reused PID,
      // and orphaned Claude processes accumulate forever. CIM is always present.
      const script =
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
        'if ($null -eq $p) { exit 1 }; ' +
        "Write-Output ('CREATED=' + $p.CreationDate.ToUniversalTime().ToString('o')); " +
        "Write-Output ('CMD=' + $p.CommandLine)";

      const output = execSync(
        `powershell.exe -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: 10000, windowsHide: true }
      );

      return parseProcessDetail(output);
    }

    // Unix: elapsed seconds is portable enough on Linux and avoids date parsing.
    const output = execSync(`ps -p ${pid} -o etimes=,args=`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const trimmed = output.trim();

    if (!trimmed) {
      return { commandLine: null, createdAtMs: null };
    }

    const match = trimmed.match(/^(\d+)\s+([\s\S]*)$/);

    if (!match) {
      return { commandLine: trimmed, createdAtMs: null };
    }

    const elapsedSeconds = Number(match[1]);
    const createdAtMs = Number.isFinite(elapsedSeconds) ? Date.now() - elapsedSeconds * 1000 : null;

    return { commandLine: (match[2] || '').trim() || null, createdAtMs };
  } catch {
    return { commandLine: null, createdAtMs: null };
  }
}

function parseProcessDetail(output: string): ProcessDetail {
  const createdMatch = output.match(/CREATED=(.+)/);
  const cmdMatch = output.match(/CMD=([\s\S]*)/);

  let createdAtMs: number | null = null;

  if (createdMatch && createdMatch[1]) {
    const parsed = Date.parse(createdMatch[1].trim());
    createdAtMs = Number.isNaN(parsed) ? null : parsed;
  }

  const commandLine = cmdMatch && cmdMatch[1] ? cmdMatch[1].trim() : '';

  return { commandLine: commandLine || null, createdAtMs };
}

function looksLikeClaude(commandLine: string): boolean {
  // Matches: claude, claude.cmd, @anthropic/claude-code, and the cmd.exe wrapper
  // Windows spawns around it.
  const lowerCmd = commandLine.toLowerCase();
  return lowerCmd.includes('claude') || lowerCmd.includes('anthropic');
}

export interface OwnershipVerdict {
  isOwn: boolean;
  /** Why we decided that, for logging — skips used to be silent and unexplainable. */
  reason: string;
}

/**
 * Decide whether the live process at `pid` is still the one we spawned.
 *
 * Creation time is the decisive signal: we wrote `startedAt` at spawn time, so
 * our own process matches within seconds, and a recycled PID does not. It is
 * checked first and on its own — the command line is only a fallback for when
 * the platform gives us no creation time.
 *
 * Requiring the command line to *also* say "claude" was wrong: Windows spawns
 * the CLI behind a `cmd.exe` wrapper whose command line may not contain the
 * word, and a more privileged process hides it entirely. Every such process was
 * classified as a recycled PID and skipped forever, which is the leak this
 * function exists to prevent.
 */
function verifyOwnClaudeProcess(pid: number, trackedStartedAt: string): OwnershipVerdict {
  const detail = getProcessDetail(pid);
  const trackedMs = Date.parse(trackedStartedAt);

  if (detail.createdAtMs !== null && !Number.isNaN(trackedMs)) {
    const driftMs = Math.abs(detail.createdAtMs - trackedMs);

    if (driftMs > PID_REUSE_TOLERANCE_MS) {
      return { isOwn: false, reason: `creation time drift ${Math.round(driftMs / 1000)}s — PID reused` };
    }

    return { isOwn: true, reason: `creation time matches (${Math.round(driftMs / 1000)}s drift)` };
  }

  if (detail.commandLine !== null) {
    return looksLikeClaude(detail.commandLine)
      ? { isOwn: true, reason: 'command line looks like Claude (no creation time available)' }
      : { isOwn: false, reason: 'command line is not Claude (no creation time available)' };
  }

  return { isOwn: false, reason: 'could not read creation time or command line' };
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
      const data = JSON.stringify(this.processes, null, 2);

      // Atomic when available: a truncated pids.json is unparseable, the tracker
      // starts empty, and orphan Claude processes then leak unnoticed.
      if (this.fileSystem.renameSync) {
        const tempPath = `${this.filePath}.tmp`;
        this.fileSystem.writeFileSync(tempPath, data);
        this.fileSystem.renameSync(tempPath, this.filePath);
        return;
      }

      this.fileSystem.writeFileSync(this.filePath, data);
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

        // Verify this PID is still the Claude process we spawned (PIDs get reused)
        const verdict = verifyOwnClaudeProcess(proc.pid, proc.startedAt);

        if (verdict.isOwn === false) {
          this.logger.info('Skipping tracked PID — not our process', {
            pid: proc.pid,
            projectId: proc.projectId,
            reason: verdict.reason,
          });
          result.skippedPids.push(proc.pid);
          continue;
        }

        this.logger.info('Found orphan Claude process, attempting to kill', {
          pid: proc.pid,
          projectId: proc.projectId,
          reason: verdict.reason,
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
