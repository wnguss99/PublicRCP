/**
 * Run Process Manager
 * Manages spawning, monitoring, and stopping run configuration processes using node-pty
 */

import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import { EventEmitter } from 'events';
import * as path from 'path';
import { platform } from 'os';
import { getLogger, Logger } from '../../utils/logger';
import { RunConfigurationService } from './types';
import {
  RunProcessManager,
  RunProcessStatus,
  RunProcessState,
} from './run-process-types';

interface ManagedProcess {
  configId: string;
  projectId: string;
  pty: IPty;
  state: RunProcessState;
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  error: string | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

export interface RunProcessManagerDependencies {
  runConfigurationService: RunConfigurationService;
}

export class DefaultRunProcessManager
  extends EventEmitter
  implements RunProcessManager
{
  private readonly processes: Map<string, Map<string, ManagedProcess>> = new Map();
  private readonly configService: RunConfigurationService;
  private readonly logger: Logger;
  private readonly isWindows = platform() === 'win32';

  constructor(deps: RunProcessManagerDependencies) {
    super();
    this.configService = deps.runConfigurationService;
    this.logger = getLogger('run-process-manager');
  }

  async start(
    projectId: string,
    projectPath: string,
    configId: string,
  ): Promise<RunProcessStatus> {
    const config = await this.configService.getById(projectId, configId);

    if (!config) {
      throw new Error(`Run configuration not found: ${configId}`);
    }

    // Stop existing process if running
    const existing = this.getProcess(projectId, configId);

    // Cancel a pending auto-restart first, whatever the state.
    //
    // stop() was the only place that cleared restartTimer, and start() only calls
    // stop() for a running/starting process. After a crash the entry sits in
    // 'errored' with a timer armed, so starting it by hand inside the restart
    // delay left that timer running: it fired, spawned a *second* pty and
    // overwrote the map entry, and the process the user started became untracked —
    // stop/stopAll/shutdown could no longer kill it, and it kept its port until
    // the machine was rebooted.
    this.cancelPendingRestart(existing);

    if (existing && (existing.state === 'running' || existing.state === 'starting')) {
      await this.stop(projectId, configId);
    }

    // Handle pre-launch chain
    if (config.preLaunchConfigId) {
      await this.startPreLaunchChain(projectId, projectPath, config.preLaunchConfigId);
    }

    return this.spawnProcess(projectId, projectPath, configId);
  }

  private async startPreLaunchChain(
    projectId: string,
    projectPath: string,
    configId: string,
  ): Promise<void> {
    const config = await this.configService.getById(projectId, configId);

    if (!config) return;

    // Recursive: handle nested pre-launch
    if (config.preLaunchConfigId) {
      await this.startPreLaunchChain(projectId, projectPath, config.preLaunchConfigId);
    }

    const existing = this.getProcess(projectId, configId);

    if (existing && existing.state === 'running') {
      return; // Already running
    }

    await this.spawnProcess(projectId, projectPath, configId);
    await this.waitForRunning(projectId, configId, 30000);
  }

  private async waitForRunning(
    projectId: string,
    configId: string,
    timeoutMs: number,
  ): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const proc = this.getProcess(projectId, configId);

      if (!proc || proc.state === 'errored' || proc.state === 'stopped') {
        throw new Error(`Pre-launch config ${configId} failed to start`);
      }

      if (proc.state === 'running') return;

      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(`Pre-launch config ${configId} timed out after ${timeoutMs}ms`);
  }

  private async spawnProcess(
    projectId: string,
    projectPath: string,
    configId: string,
  ): Promise<RunProcessStatus> {
    const config = await this.configService.getById(projectId, configId);

    if (!config) {
      throw new Error(`Run configuration not found: ${configId}`);
    }

    const cwd = path.resolve(projectPath, config.cwd || '.');
    const shell = config.shell || this.getDefaultShell();

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...config.env,
      CLAUDITO_RUN_CONFIG: config.name,
      CLAUDITO_PROJECT_ROOT: projectPath,
    };

    const spawnArgs = this.buildSpawnArgs(config.command, config.args);

    this.logger.info('Spawning run config process', {
      projectId,
      configId,
      command: config.command,
      cwd,
    });

    const ptyProcess = pty.spawn(shell, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    });

    const managed: ManagedProcess = {
      configId,
      projectId,
      pty: ptyProcess,
      state: 'running',
      pid: ptyProcess.pid,
      startedAt: new Date().toISOString(),
      exitCode: null,
      restartCount: this.getProcess(projectId, configId)?.restartCount || 0,
      error: null,
      restartTimer: null,
    };

    this.setProcess(projectId, configId, managed);
    this.setupProcessHandlers(managed, config.autoRestart, config.autoRestartDelay, config.autoRestartMaxRetries, projectPath);
    this.emitStatus(projectId, configId);

    return this.buildStatus(managed);
  }

  private setupProcessHandlers(
    managed: ManagedProcess,
    autoRestart: boolean,
    autoRestartDelay: number,
    autoRestartMaxRetries: number,
    projectPath: string,
  ): void {
    const { pty: ptyProcess, projectId, configId } = managed;

    ptyProcess.onData((data: string) => {
      this.emit('output', projectId, configId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.logger.info('Run config process exited', {
        projectId,
        configId,
        exitCode,
      });

      managed.state = exitCode === 0 ? 'stopped' : 'errored';
      managed.exitCode = exitCode;
      managed.pid = null;

      if (exitCode !== 0) {
        managed.error = `Process exited with code ${exitCode}`;
      }

      this.emitStatus(projectId, configId);

      // Auto-restart on non-zero exit
      if (autoRestart && exitCode !== 0) {
        this.scheduleRestart(managed, autoRestartDelay, autoRestartMaxRetries, projectPath);
      }
    });
  }

  private scheduleRestart(
    managed: ManagedProcess,
    delay: number,
    maxRetries: number,
    projectPath: string,
  ): void {
    // 0 = unlimited
    if (maxRetries > 0 && managed.restartCount >= maxRetries) {
      this.logger.warn('Max restart retries reached', {
        projectId: managed.projectId,
        configId: managed.configId,
        restartCount: managed.restartCount,
      });
      return;
    }

    managed.restartTimer = setTimeout(() => {
      managed.restartCount++;
      this.logger.info('Auto-restarting run config', {
        projectId: managed.projectId,
        configId: managed.configId,
        attempt: managed.restartCount,
      });
      this.spawnProcess(managed.projectId, projectPath, managed.configId).catch(
        (err) => {
          this.logger.error('Failed to auto-restart', {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }, delay);
  }

  stop(projectId: string, configId: string): Promise<void> {
    const proc = this.getProcess(projectId, configId);

    if (!proc) return Promise.resolve();

    // Cancel any pending restart
    this.cancelPendingRestart(proc);

    if (proc.state !== 'running' && proc.state !== 'starting') {
      return Promise.resolve();
    }

    this.logger.info('Stopping run config process', {
      projectId,
      configId,
      pid: proc.pid,
    });

    try {
      proc.pty.kill();
    } catch {
      // Process may already be dead
    }

    proc.state = 'stopped';
    proc.pid = null;
    this.emitStatus(projectId, configId);

    return Promise.resolve();
  }

  async stopAll(projectId: string): Promise<void> {
    const projectProcesses = this.processes.get(projectId);

    if (!projectProcesses) return;

    const stopPromises = Array.from(projectProcesses.keys()).map((configId) =>
      this.stop(projectId, configId),
    );
    await Promise.all(stopPromises);
  }

  getStatus(projectId: string, configId: string): RunProcessStatus {
    const proc = this.getProcess(projectId, configId);

    if (!proc) {
      return {
        configId,
        state: 'stopped',
        pid: null,
        startedAt: null,
        uptimeMs: null,
        exitCode: null,
        restartCount: 0,
        error: null,
      };
    }

    return this.buildStatus(proc);
  }

  getAllStatuses(projectId: string): RunProcessStatus[] {
    const projectProcesses = this.processes.get(projectId);

    if (!projectProcesses) return [];

    return Array.from(projectProcesses.values()).map((proc) =>
      this.buildStatus(proc),
    );
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down all run config processes');

    for (const [projectId, projectProcesses] of this.processes) {
      for (const configId of projectProcesses.keys()) {
        await this.stop(projectId, configId);
      }
    }

    this.processes.clear();
  }

  private getProcess(projectId: string, configId: string): ManagedProcess | undefined {
    return this.processes.get(projectId)?.get(configId);
  }

  /** Disarm an auto-restart so it cannot spawn on top of a process started since. */
  private cancelPendingRestart(proc: ManagedProcess | undefined): void {
    if (!proc?.restartTimer) return;

    clearTimeout(proc.restartTimer);
    proc.restartTimer = null;
  }

  private setProcess(projectId: string, configId: string, proc: ManagedProcess): void {
    if (!this.processes.has(projectId)) {
      this.processes.set(projectId, new Map());
    }
    this.processes.get(projectId)!.set(configId, proc);
  }

  private buildStatus(proc: ManagedProcess): RunProcessStatus {
    let uptimeMs: number | null = null;

    if (proc.startedAt && proc.state === 'running') {
      uptimeMs = Date.now() - new Date(proc.startedAt).getTime();
    }

    return {
      configId: proc.configId,
      state: proc.state,
      pid: proc.pid,
      startedAt: proc.startedAt,
      uptimeMs,
      exitCode: proc.exitCode,
      restartCount: proc.restartCount,
      error: proc.error,
    };
  }

  private emitStatus(projectId: string, configId: string): void {
    const status = this.getStatus(projectId, configId);
    this.emit('status', projectId, configId, status);
  }

  private getDefaultShell(): string {
    if (this.isWindows) {
      return 'cmd.exe';
    }

    return process.env.SHELL || '/bin/sh';
  }

  private buildSpawnArgs(command: string, args: string[]): string[] {
    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;

    if (this.isWindows) {
      return ['/c', fullCommand];
    }

    return ['-c', fullCommand];
  }
}
