/**
 * Shell Service
 * Manages shell/terminal sessions for projects using node-pty
 */

import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import { EventEmitter } from 'events';
import { platform } from 'os';
import * as path from 'path';
import { getLogger, Logger } from '../utils/logger';

export interface ShellSession {
  id: string;
  projectId: string;
  pty: IPty;
  cwd: string;
  projectPath: string;
  createdAt: number;
}

export interface ShellServiceEvents {
  data: (sessionId: string, data: string) => void;
  exit: (sessionId: string, code: number | null) => void;
  error: (sessionId: string, error: string) => void;
}

export interface SessionOptions {
  cols?: number;
  rows?: number;
}

export interface ShellService {
  createSession(projectId: string, cwd: string, options?: SessionOptions): ShellSession;
  getSession(sessionId: string): ShellSession | undefined;
  getSessionByProject(projectId: string): ShellSession | undefined;
  write(sessionId: string, data: string): boolean;
  resize(sessionId: string, cols: number, rows: number): void;
  killSession(sessionId: string): void;
  killAllSessions(): void;
  on<K extends keyof ShellServiceEvents>(
    event: K,
    listener: ShellServiceEvents[K]
  ): void;
  off<K extends keyof ShellServiceEvents>(
    event: K,
    listener: ShellServiceEvents[K]
  ): void;
}

/**
 * Get the appropriate shell command for the current platform
 */
function getShellCommand(): { shell: string; args: string[] } {
  const isWindows = platform() === 'win32';

  if (isWindows) {
    return {
      shell: 'powershell.exe',
      args: []
    };
  }

  return {
    shell: process.env.SHELL || '/bin/bash',
    args: ['-i']
  };
}

/**
 * Check if a path is within the allowed project directory
 *
 * A prefix test is not containment: `D:\repos\proj-secrets` "starts with"
 * `D:\repos\proj`, so a cd into a sibling directory that merely shares a name
 * prefix was treated as inside the project and the forced cd back never fired.
 * Compare path segments the way routes/filesystem.ts isPathInside does.
 */
export function isPathWithinProject(targetPath: string, projectPath: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  const rel = path.relative(normalize(projectPath), normalize(targetPath));

  // '' is the project root itself, which counts as inside.
  if (rel === '') {
    return true;
  }

  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Detect current directory from shell output
 * Returns the detected directory or null if not detected
 */
function detectDirectoryFromOutput(
  output: string,
  isWindows: boolean
): string | null {
  if (isWindows) {
    // PowerShell prompt: PS C:\path>
    const psMatch = output.match(/PS\s+([A-Za-z]:\\[^>]*?)>/);
    if (psMatch && psMatch[1]) {
      return psMatch[1];
    }

    // CMD prompt: C:\path>
    const cmdMatch = output.match(/([A-Za-z]:\\[^>\r\n]*?)>/);
    if (cmdMatch && cmdMatch[1]) {
      return cmdMatch[1];
    }
  } else {
    // Bash prompt patterns: user@host:~/path$ or ~/path$
    const bashMatch = output.match(/:([~/][^$#]*?)[$#]\s*$/m);
    if (bashMatch && bashMatch[1]) {
      let dir: string = bashMatch[1];

      // Expand ~ to home directory
      if (dir.startsWith('~')) {
        dir = path.join(process.env.HOME || '', dir.slice(1));
      }
      return dir;
    }
  }

  return null;
}

export class DefaultShellService extends EventEmitter implements ShellService {
  private sessions: Map<string, ShellSession> = new Map();
  private projectSessions: Map<string, string> = new Map();
  private readonly logger: Logger;
  private sessionCounter = 0;
  private readonly isWindows = platform() === 'win32';

  constructor() {
    super();
    this.logger = getLogger('shell-service');
  }

  createSession(
    projectId: string,
    cwd: string,
    options?: SessionOptions
  ): ShellSession {
    const existingSessionId = this.projectSessions.get(projectId);

    if (existingSessionId) {
      this.killSession(existingSessionId);
    }

    const sessionId = `shell-${projectId}-${Date.now()}-${++this.sessionCounter}`;
    const { shell, args } = getShellCommand();
    const cols = options?.cols || 80;
    const rows = options?.rows || 24;

    this.logger.withProject(projectId).info('Creating shell session with PTY', {
      sessionId,
      shell,
      args,
      cwd,
      cols,
      rows
    });

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CLAUDITO_PROJECT_ROOT: cwd
      } as Record<string, string>
    });

    this.logger.withProject(projectId).info('PTY process spawned', {
      sessionId,
      pid: ptyProcess.pid
    });

    const session: ShellSession = {
      id: sessionId,
      projectId,
      pty: ptyProcess,
      cwd,
      projectPath: cwd,
      createdAt: Date.now()
    };

    this.sessions.set(sessionId, session);
    this.projectSessions.set(projectId, sessionId);
    this.setupPtyHandlers(session);

    return session;
  }

  private setupPtyHandlers(session: ShellSession): void {
    const { pty: ptyProcess, id: sessionId, projectId } = session;

    ptyProcess.onData((data: string) => {
      this.logger.withProject(projectId).debug('PTY data', {
        sessionId,
        length: data.length,
        preview: data.substring(0, 100)
      });

      // Check for directory escape
      this.checkDirectoryRestriction(session, data);

      this.emit('data', sessionId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.logger.withProject(projectId).info('Shell session exited', {
        sessionId,
        code: exitCode
      });
      this.cleanupSession(sessionId);
      this.emit('exit', sessionId, exitCode);
    });
  }

  /**
   * Monitor output for directory changes and enforce restriction
   */
  private checkDirectoryRestriction(session: ShellSession, data: string): void {
    const detectedDir = detectDirectoryFromOutput(data, this.isWindows);

    if (!detectedDir) {
      return;
    }

    if (!isPathWithinProject(detectedDir, session.projectPath)) {
      this.logger.withProject(session.projectId).warn('Directory escape detected', {
        detected: detectedDir,
        allowed: session.projectPath
      });

      // Force back to project root
      const cdCommand = this.isWindows
        ? `cd "${session.projectPath}"\r`
        : `cd "${session.projectPath}"\n`;

      // Small delay to let the prompt appear first
      setTimeout(() => {
        try {
          session.pty.write(cdCommand);
        } catch {
          // Session may have been killed
        }
      }, 50);
    }
  }

  getSession(sessionId: string): ShellSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByProject(projectId: string): ShellSession | undefined {
    const sessionId = this.projectSessions.get(projectId);

    if (!sessionId) {
      return undefined;
    }

    return this.sessions.get(sessionId);
  }

  write(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);

    if (!session) {
      this.logger.warn('Write failed: session not found', { sessionId });
      return false;
    }

    try {
      this.logger.withProject(session.projectId).debug('Writing to PTY', {
        sessionId,
        dataLength: data.length,
        dataPreview: JSON.stringify(data.substring(0, 50))
      });
      session.pty.write(data);
      return true;
    } catch (err) {
      this.logger.withProject(session.projectId).error('Failed to write to PTY', {
        sessionId,
        error: (err as Error).message
      });
      return false;
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);

    if (!session) {
      this.logger.warn('Resize failed: session not found', { sessionId });
      return;
    }

    try {
      session.pty.resize(cols, rows);
      this.logger.withProject(session.projectId).debug('PTY resized', {
        sessionId,
        cols,
        rows
      });
    } catch (err) {
      this.logger.withProject(session.projectId).error('Failed to resize PTY', {
        sessionId,
        error: (err as Error).message
      });
    }
  }

  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    this.logger.info('Killing shell session', { sessionId });

    try {
      session.pty.kill();
    } catch {
      // Process may already be dead
    }

    this.cleanupSession(sessionId);
  }

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);

    if (session) {
      this.projectSessions.delete(session.projectId);
    }

    this.sessions.delete(sessionId);
  }

  killAllSessions(): void {
    this.logger.info('Killing all shell sessions', {
      count: this.sessions.size
    });

    for (const sessionId of this.sessions.keys()) {
      this.killSession(sessionId);
    }
  }
}

let shellServiceInstance: ShellService | null = null;

export function createShellService(): ShellService {
  if (!shellServiceInstance) {
    shellServiceInstance = new DefaultShellService();
  }
  return shellServiceInstance;
}

export function getShellService(): ShellService | null {
  return shellServiceInstance;
}

export function getOrCreateShellService(): ShellService {
  return createShellService();
}
