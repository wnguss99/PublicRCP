import fs from 'fs';
import path from 'path';
import { generateUUID, getLogger, Logger } from '../utils';
import { PendingOperationsTracker, WriteQueueManager } from '../utils/operation-tracking';
import {
  RalphLoopState,
  RalphLoopRepository,
  IterationSummary,
  ReviewerFeedback,
} from '../services/ralph-loop/types';
import { ProjectPathResolver } from './interfaces';

/**
 * File system interface for Ralph Loop persistence
 */
export interface RalphLoopFileSystem {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, data: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  mkdir(dirPath: string): Promise<void>;
  readdir(dirPath: string): Promise<string[]>;
  unlink(filePath: string): Promise<void>;
  rmdir(dirPath: string): Promise<void>;
}

const defaultFileSystem: RalphLoopFileSystem = {
  readFile: (filePath) => fs.promises.readFile(filePath, 'utf-8'),
  writeFile: async (filePath, data) => {
    const tempPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tempPath, data, 'utf-8');
    await fs.promises.rename(tempPath, filePath);
  },
  exists: async (filePath) => {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  mkdir: async (dirPath) => {
    await fs.promises.mkdir(dirPath, { recursive: true });
  },
  readdir: async (dirPath) => {
    try {
      return await fs.promises.readdir(dirPath);
    } catch {
      return [];
    }
  },
  unlink: (filePath) => fs.promises.unlink(filePath),
  rmdir: (dirPath) => fs.promises.rm(dirPath, { recursive: true, force: true }),
};

// ProjectPathResolver is now imported from interfaces.ts to avoid duplication

export interface FileRalphLoopRepositoryConfig {
  projectPathResolver: ProjectPathResolver;
  fileSystem?: RalphLoopFileSystem;
}

/**
 * Generate a unique task ID
 */
export function generateTaskId(): string {
  return generateUUID();
}

/**
 * File-based Ralph Loop repository
 *
 * Stores data in: {CLAUDITO_HOME}/projects/{projectId}/ralph/{taskId}/
 */
export class FileRalphLoopRepository implements RalphLoopRepository {
  private readonly projectPathResolver: ProjectPathResolver;
  private readonly fileSystem: RalphLoopFileSystem;
  private readonly cache: Map<string, RalphLoopState> = new Map();
  // The shared managers, not a private copy. This class used to reimplement both
  // and kept the pre-fix versions: the write lock deleted the queue entry
  // unconditionally, so an operation queued behind another was abandoned as the
  // lock holder finished and the next caller ran *concurrently* with it — two
  // read-modify-writes on the same state.json, and the loser's update silently
  // lost. Tracking used `void promise.finally()`, whose derived promise inherits
  // the rejection and so turned one failed write into a process-killing unhandled
  // rejection. `flush()` used Promise.all, which abandons the rest of the queue on
  // the first failure. All three are already fixed and documented in
  // utils/operation-tracking.ts, which conversation.ts uses.
  private readonly pendingOperations: PendingOperationsTracker;
  private readonly writeQueues: WriteQueueManager<string>;
  private readonly logger: Logger;

  constructor(config: FileRalphLoopRepositoryConfig) {
    this.pendingOperations = new PendingOperationsTracker('ralph-loop-repo');
    this.writeQueues = new WriteQueueManager('ralph-loop-repo');
    this.projectPathResolver = config.projectPathResolver;
    this.fileSystem = config.fileSystem || defaultFileSystem;
    this.logger = getLogger('ralph-loop-repository');
  }

  async flush(): Promise<void> {
    await this.pendingOperations.flush();
    await this.writeQueues.flush();
  }

  private trackOperation<T>(promise: Promise<T>): Promise<T> {
    return this.pendingOperations.track(promise);
  }

  private async withTaskLock<T>(
    projectId: string,
    taskId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.writeQueues.withLock(this.getCacheKey(projectId, taskId), operation);
  }

  private getCacheKey(projectId: string, taskId: string): string {
    return `${projectId}:${taskId}`;
  }

  private getRalphDir(projectId: string): string | null {
    const dataDir = this.projectPathResolver.getProjectDataDir(projectId);

    if (!dataDir) {
      return null;
    }

    return path.join(dataDir, 'ralph');
  }

  private getTaskDir(projectId: string, taskId: string): string | null {
    const ralphDir = this.getRalphDir(projectId);

    if (!ralphDir) {
      return null;
    }

    return path.join(ralphDir, taskId);
  }

  private getStatePath(projectId: string, taskId: string): string | null {
    const taskDir = this.getTaskDir(projectId, taskId);

    if (!taskDir) {
      return null;
    }

    return path.join(taskDir, 'state.json');
  }

  private getSummariesDir(projectId: string, taskId: string): string | null {
    const taskDir = this.getTaskDir(projectId, taskId);

    if (!taskDir) {
      return null;
    }

    return path.join(taskDir, 'summaries');
  }

  private getFeedbackDir(projectId: string, taskId: string): string | null {
    const taskDir = this.getTaskDir(projectId, taskId);

    if (!taskDir) {
      return null;
    }

    return path.join(taskDir, 'feedback');
  }

  async create(
    state: Omit<RalphLoopState, 'createdAt' | 'updatedAt'>
  ): Promise<RalphLoopState> {
    const taskDir = this.getTaskDir(state.projectId, state.taskId);

    if (!taskDir) {
      throw new Error(`Project not found: ${state.projectId}`);
    }

    const now = new Date().toISOString();
    const fullState: RalphLoopState = {
      ...state,
      createdAt: now,
      updatedAt: now,
    };

    await this.fileSystem.mkdir(taskDir);
    await this.fileSystem.mkdir(path.join(taskDir, 'summaries'));
    await this.fileSystem.mkdir(path.join(taskDir, 'feedback'));

    const statePath = this.getStatePath(state.projectId, state.taskId)!;
    await this.fileSystem.writeFile(statePath, JSON.stringify(fullState, null, 2));

    const cacheKey = this.getCacheKey(state.projectId, state.taskId);
    this.cache.set(cacheKey, fullState);

    this.logger.info('Created Ralph Loop state', {
      projectId: state.projectId,
      taskId: state.taskId,
    });

    return { ...fullState };
  }

  async findById(projectId: string, taskId: string): Promise<RalphLoopState | null> {
    const cacheKey = this.getCacheKey(projectId, taskId);

    if (this.cache.has(cacheKey)) {
      return { ...this.cache.get(cacheKey)! };
    }

    const statePath = this.getStatePath(projectId, taskId);

    if (!statePath) {
      return null;
    }

    const exists = await this.fileSystem.exists(statePath);

    if (!exists) {
      return null;
    }

    try {
      const content = await this.fileSystem.readFile(statePath);
      const state = JSON.parse(content) as RalphLoopState;
      this.cache.set(cacheKey, state);
      return { ...state };
    } catch (error) {
      this.logger.error('Failed to read Ralph Loop state', {
        projectId,
        taskId,
        error,
      });
      return null;
    }
  }

  async findByProject(projectId: string): Promise<RalphLoopState[]> {
    const ralphDir = this.getRalphDir(projectId);

    if (!ralphDir) {
      return [];
    }

    const exists = await this.fileSystem.exists(ralphDir);

    if (!exists) {
      return [];
    }

    const entries = await this.fileSystem.readdir(ralphDir);
    const states: RalphLoopState[] = [];

    for (const entry of entries) {
      if (entry.endsWith('.tmp')) {
        continue;
      }

      const state = await this.findById(projectId, entry);

      if (state) {
        states.push(state);
      }
    }

    return states.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async update(
    projectId: string,
    taskId: string,
    updates: Partial<RalphLoopState>
  ): Promise<RalphLoopState | null> {
    return this.withTaskLock(projectId, taskId, async () => {
      return this.updateInternal(projectId, taskId, updates);
    });
  }

  private async updateInternal(
    projectId: string,
    taskId: string,
    updates: Partial<RalphLoopState>
  ): Promise<RalphLoopState | null> {
    const existing = await this.findById(projectId, taskId);

    if (!existing) {
      return null;
    }

    const updated: RalphLoopState = {
      ...existing,
      ...updates,
      taskId: existing.taskId,
      projectId: existing.projectId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    const statePath = this.getStatePath(projectId, taskId)!;
    const operation = this.fileSystem.writeFile(
      statePath,
      JSON.stringify(updated, null, 2)
    );

    void this.trackOperation(operation);
    await operation;

    const cacheKey = this.getCacheKey(projectId, taskId);
    this.cache.set(cacheKey, updated);

    return { ...updated };
  }

  async addSummary(
    projectId: string,
    taskId: string,
    summary: IterationSummary
  ): Promise<void> {
    return this.withTaskLock(projectId, taskId, async () => {
      const summariesDir = this.getSummariesDir(projectId, taskId);

      if (!summariesDir) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const filePath = path.join(
        summariesDir,
        `iteration-${summary.iterationNumber}.json`
      );

      const operation = this.fileSystem.writeFile(
        filePath,
        JSON.stringify(summary, null, 2)
      );

      void this.trackOperation(operation);
      await operation;

      // Update state with summary reference (use internal to avoid deadlock)
      const state = await this.findById(projectId, taskId);

      if (state) {
        const summaries = [...state.summaries, summary];
        await this.updateInternal(projectId, taskId, { summaries });
      }

      this.logger.debug('Added iteration summary', {
        projectId,
        taskId,
        iteration: summary.iterationNumber,
      });
    });
  }

  async addFeedback(
    projectId: string,
    taskId: string,
    feedback: ReviewerFeedback
  ): Promise<void> {
    return this.withTaskLock(projectId, taskId, async () => {
      const feedbackDir = this.getFeedbackDir(projectId, taskId);

      if (!feedbackDir) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const filePath = path.join(
        feedbackDir,
        `iteration-${feedback.iterationNumber}.json`
      );

      const operation = this.fileSystem.writeFile(
        filePath,
        JSON.stringify(feedback, null, 2)
      );

      void this.trackOperation(operation);
      await operation;

      // Update state with feedback reference (use internal to avoid deadlock)
      const state = await this.findById(projectId, taskId);

      if (state) {
        const feedbackList = [...state.feedback, feedback];
        await this.updateInternal(projectId, taskId, { feedback: feedbackList });
      }

      this.logger.debug('Added reviewer feedback', {
        projectId,
        taskId,
        iteration: feedback.iterationNumber,
        decision: feedback.decision,
      });
    });
  }

  async delete(projectId: string, taskId: string): Promise<boolean> {
    const taskDir = this.getTaskDir(projectId, taskId);

    if (!taskDir) {
      return false;
    }

    const exists = await this.fileSystem.exists(taskDir);

    if (!exists) {
      return false;
    }

    try {
      await this.fileSystem.rmdir(taskDir);
      const cacheKey = this.getCacheKey(projectId, taskId);
      this.cache.delete(cacheKey);

      this.logger.info('Deleted Ralph Loop', {
        projectId,
        taskId,
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to delete Ralph Loop', {
        projectId,
        taskId,
        error,
      });
      return false;
    }
  }
}
