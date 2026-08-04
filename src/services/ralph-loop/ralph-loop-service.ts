import { EventEmitter } from 'events';
import {
  RalphLoopService,
  RalphLoopState,
  RalphLoopConfig,
  RalphLoopEvents,
  RalphLoopRepository,
  RalphLoopStatus,
  RalphLoopFinalStatus,
  ReviewerFeedback,
  ContextInitializer,
  IterationSummary,
} from './types';
import { DefaultContextInitializer } from './context-initializer';
import { WorkerAgent, WorkerAgentConfig } from './worker-agent';
import { ReviewerAgent, ReviewerAgentConfig } from './reviewer-agent';
import { getLogger, Logger } from '../../utils';
import { generateTaskId } from '../../repositories/ralph-loop';
import { ProjectRepository } from '../../repositories/project';
import { McpServerConfig } from '../../repositories';

/**
 * Interface for resolving project paths
 */
export interface ProjectPathResolver {
  getProjectPath(projectId: string): string | null;
}

/**
 * Factory interface for creating worker agents
 */
export interface WorkerAgentFactory {
  create(config: WorkerAgentConfig): WorkerAgent;
}

/**
 * Factory interface for creating reviewer agents
 */
export interface ReviewerAgentFactory {
  create(config: ReviewerAgentConfig): ReviewerAgent;
}

/**
 * Default worker agent factory
 */
const defaultWorkerAgentFactory: WorkerAgentFactory = {
  create: (config: WorkerAgentConfig) => new WorkerAgent(config),
};

/**
 * Default reviewer agent factory
 */
const defaultReviewerAgentFactory: ReviewerAgentFactory = {
  create: (config: ReviewerAgentConfig) => new ReviewerAgent(config),
};

/**
 * Internal state for tracking active loops
 */
interface ActiveLoopState {
  taskId: string;
  projectId: string;
  shouldContinue: boolean;
  currentPhase: 'worker' | 'reviewer' | null;
  startTime: number;
  workerAgent?: WorkerAgent;
  reviewerAgent?: ReviewerAgent;
}

export interface RalphLoopServiceDependencies {
  repository: RalphLoopRepository;
  projectRepository: ProjectRepository;
  projectPathResolver: ProjectPathResolver;
  contextInitializer?: ContextInitializer;
  workerAgentFactory?: WorkerAgentFactory;
  reviewerAgentFactory?: ReviewerAgentFactory;
  settingsRepository?: import('../../repositories/settings').SettingsRepository;
}

/**
 * Default implementation of RalphLoopService
 *
 * Orchestrates the worker → reviewer → decision cycle.
 */
export class DefaultRalphLoopService implements RalphLoopService {
  private readonly repository: RalphLoopRepository;
  private readonly projectRepository: ProjectRepository;
  private readonly projectPathResolver: ProjectPathResolver;
  private readonly contextInitializer: ContextInitializer;
  private readonly workerAgentFactory: WorkerAgentFactory;
  private readonly reviewerAgentFactory: ReviewerAgentFactory;
  private readonly settingsRepository?: import('../../repositories/settings').SettingsRepository;
  private readonly logger: Logger;
  private readonly emitter: EventEmitter;
  private readonly activeLoops: Map<string, ActiveLoopState> = new Map();

  constructor(deps: RalphLoopServiceDependencies) {
    this.repository = deps.repository;
    this.projectRepository = deps.projectRepository;
    this.projectPathResolver = deps.projectPathResolver;
    this.contextInitializer = deps.contextInitializer || new DefaultContextInitializer();
    this.workerAgentFactory = deps.workerAgentFactory || defaultWorkerAgentFactory;
    this.reviewerAgentFactory = deps.reviewerAgentFactory || defaultReviewerAgentFactory;
    this.settingsRepository = deps.settingsRepository;
    this.logger = getLogger('ralph-loop-service');
    this.emitter = new EventEmitter();
  }

  /**
   * Start a new Ralph Loop
   */
  async start(projectId: string, config: RalphLoopConfig): Promise<RalphLoopState> {
    const taskId = generateTaskId();

    this.logger.info('Starting Ralph Loop', {
      projectId,
      taskId,
      maxTurns: config.maxTurns,
    });

    const initialState: Omit<RalphLoopState, 'createdAt' | 'updatedAt'> = {
      taskId,
      projectId,
      config,
      currentIteration: 0,
      status: 'idle',
      summaries: [],
      feedback: [],
    };

    const state = await this.repository.create(initialState);

    // Clean up old loops after creating the new one
    void this.cleanupOldLoops(projectId);

    // Track active loop
    const activeState: ActiveLoopState = {
      taskId,
      projectId,
      shouldContinue: true,
      currentPhase: null,
      startTime: Date.now(),
    };
    this.activeLoops.set(this.getLoopKey(projectId, taskId), activeState);

    // Update project status to running
    await this.projectRepository.updateStatus(projectId, 'running');

    // Start the first iteration
    void this.runNextIteration(projectId, taskId).catch((error) => {
      void this.handleLoopError(projectId, taskId, error);
    });

    return state;
  }

  /**
   * Stop a running Ralph Loop
   */
  async stop(projectId: string, taskId: string): Promise<void> {
    const key = this.getLoopKey(projectId, taskId);
    const activeState = this.activeLoops.get(key);

    if (activeState) {
      activeState.shouldContinue = false;

      // Stop worker agent if running
      if (activeState.workerAgent) {
        await activeState.workerAgent.stop();
      }

      // Stop reviewer agent if running
      if (activeState.reviewerAgent) {
        await activeState.reviewerAgent.stop();
      }

      this.activeLoops.delete(key);
    }

    await this.repository.update(projectId, taskId, {
      status: 'completed',
      finalStatus: 'critical_failure',
      error: 'Loop stopped by user',
    });

    // Update project status to stopped
    await this.projectRepository.updateStatus(projectId, 'stopped');

    this.logger.info('Ralph Loop stopped', { projectId, taskId });
  }

  /**
   * Pause a running Ralph Loop
   */
  async pause(projectId: string, taskId: string): Promise<void> {
    const key = this.getLoopKey(projectId, taskId);
    const activeState = this.activeLoops.get(key);

    if (activeState) {
      activeState.shouldContinue = false;
    }

    await this.updateStatus(projectId, taskId, 'paused');
    this.logger.info('Ralph Loop paused', { projectId, taskId });
  }

  /**
   * Resume a paused Ralph Loop
   */
  async resume(projectId: string, taskId: string): Promise<void> {
    const state = await this.repository.findById(projectId, taskId);

    if (!state) {
      throw new Error(`Ralph Loop not found: ${taskId}`);
    }

    if (state.status !== 'paused') {
      throw new Error(`Cannot resume loop in status: ${state.status}`);
    }

    const key = this.getLoopKey(projectId, taskId);
    const activeState: ActiveLoopState = {
      taskId,
      projectId,
      shouldContinue: true,
      currentPhase: null,
      startTime: Date.now(),
    };
    this.activeLoops.set(key, activeState);

    await this.updateStatus(projectId, taskId, 'idle');

    void this.runNextIteration(projectId, taskId).catch((error) => {
      void this.handleLoopError(projectId, taskId, error);
    });

    this.logger.info('Ralph Loop resumed', { projectId, taskId });
  }

  /**
   * Get the current state of a Ralph Loop
   */
  async getState(projectId: string, taskId: string): Promise<RalphLoopState | null> {
    return this.repository.findById(projectId, taskId);
  }

  /**
   * List all Ralph Loops for a project
   */
  async listByProject(projectId: string): Promise<RalphLoopState[]> {
    return this.repository.findByProject(projectId);
  }

  on<K extends keyof RalphLoopEvents>(event: K, listener: RalphLoopEvents[K]): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof RalphLoopEvents>(event: K, listener: RalphLoopEvents[K]): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private getLoopKey(projectId: string, taskId: string): string {
    return `${projectId}:${taskId}`;
  }

  private async updateStatus(
    projectId: string,
    taskId: string,
    status: RalphLoopStatus
  ): Promise<void> {
    await this.repository.update(projectId, taskId, { status });

    // Get the state to include iteration info
    const state = await this.repository.findById(projectId, taskId);
    const currentIteration = state?.currentIteration;
    const maxTurns = state?.config.maxTurns;

    this.emitter.emit('status_change', projectId, taskId, status, currentIteration, maxTurns);
  }

  /**
   * Run the next iteration of the loop
   */
  private async runNextIteration(projectId: string, taskId: string): Promise<void> {
    const key = this.getLoopKey(projectId, taskId);
    const activeState = this.activeLoops.get(key);

    if (!activeState || !activeState.shouldContinue) {
      return;
    }

    const state = await this.repository.findById(projectId, taskId);

    if (!state) {
      return;
    }

    // Check if max turns reached
    if (state.currentIteration >= state.config.maxTurns) {
      await this.completeLoop(projectId, taskId, 'max_turns_reached');
      return;
    }

    // Start next iteration
    const nextIteration = state.currentIteration + 1;
    await this.repository.update(projectId, taskId, {
      currentIteration: nextIteration,
    });

    this.emitter.emit('iteration_start', projectId, taskId, nextIteration);

    // Run worker phase
    await this.runWorkerPhase(projectId, taskId, nextIteration);
  }

  /**
   * Run the worker phase of an iteration
   */
  private async runWorkerPhase(
    projectId: string,
    taskId: string,
    iteration: number
  ): Promise<void> {
    const validation = await this.validateAndPreparePhase(projectId, taskId, 'worker');
    if (!validation) {
      return;
    }

    const { activeState, state, projectPath } = validation;

    this.logger.info('Running worker phase', {
      projectId,
      taskId,
      iteration,
    });

    const workerAgent = await this.createWorkerAgent(state, projectPath);
    activeState.workerAgent = workerAgent;

    this.setupWorkerEventHandlers(workerAgent, projectId, taskId, iteration);

    try {
      const summary = await workerAgent.run(state);
      await this.handleWorkerCompletion(projectId, taskId, activeState, summary, iteration);
    } catch (error) {
      // Check if we were stopped
      if (!activeState.shouldContinue) {
        return;
      }
      throw error;
    } finally {
      activeState.workerAgent = undefined;
    }
  }

  /**
   * Validate and prepare for a phase execution
   */
  private async validateAndPreparePhase(
    projectId: string,
    taskId: string,
    phase: 'worker' | 'reviewer'
  ): Promise<{
    activeState: ActiveLoopState;
    state: RalphLoopState;
    projectPath: string;
  } | null> {
    const key = this.getLoopKey(projectId, taskId);
    const activeState = this.activeLoops.get(key);

    if (!activeState || !activeState.shouldContinue) {
      return null;
    }

    activeState.currentPhase = phase;
    const status = phase === 'worker' ? 'worker_running' : 'reviewer_running';
    await this.updateStatus(projectId, taskId, status);

    const state = await this.repository.findById(projectId, taskId);
    if (!state) {
      return null;
    }

    const projectPath = this.projectPathResolver.getProjectPath(projectId);
    if (!projectPath) {
      throw new Error(`Project path not found for: ${projectId}`);
    }

    return { activeState, state, projectPath };
  }

  /**
   * Create a worker agent with configuration
   */
  private async createWorkerAgent(
    state: RalphLoopState,
    projectPath: string
  ): Promise<WorkerAgent> {
    const mcpServers = await this.getMcpServers();

    return this.workerAgentFactory.create({
      projectPath,
      model: state.config.workerModel,
      contextInitializer: this.contextInitializer,
      appendSystemPrompt: state.config.workerSystemPrompt,
      mcpServers,
    });
  }

  /**
   * Get MCP servers from settings if available
   */
  private async getMcpServers(): Promise<McpServerConfig[] | undefined> {
    if (this.settingsRepository) {
      const settings = await this.settingsRepository.get();
      // Only return enabled servers if MCP is enabled globally
      return settings.mcp?.enabled
        ? (settings.mcp.servers || []).filter((server) => server.enabled)
        : undefined;
    }
    return undefined;
  }

  /**
   * Setup event handlers for worker agent
   */
  private setupWorkerEventHandlers(
    workerAgent: WorkerAgent,
    projectId: string,
    taskId: string,
    iteration: number
  ): void {
    workerAgent.on('output', (content) => {
      this.emitter.emit('output', projectId, taskId, 'worker', content);
      this.logger.debug('Worker output', {
        projectId,
        taskId,
        iteration,
        contentLength: content.length,
      });
    });

    workerAgent.on('tool_use', (toolInfo) => {
      this.logger.info('Ralph Loop service received tool_use from worker', {
        projectId,
        taskId,
        iteration,
        toolName: toolInfo.tool_name,
        toolId: toolInfo.tool_id,
      });
      this.emitter.emit('tool_use', projectId, taskId, 'worker', toolInfo);
    });
  }

  /**
   * Handle completion of worker phase
   */
  private async handleWorkerCompletion(
    projectId: string,
    taskId: string,
    activeState: ActiveLoopState,
    summary: IterationSummary,
    iteration: number
  ): Promise<void> {
    await this.repository.addSummary(projectId, taskId, summary);
    this.emitter.emit('worker_complete', projectId, taskId, summary);

    // Continue to reviewer phase if still active
    if (activeState.shouldContinue) {
      await this.runReviewerPhase(projectId, taskId, iteration, summary.workerOutput);
    }
  }

  /**
   * Run the reviewer phase of an iteration
   */
  private async runReviewerPhase(
    projectId: string,
    taskId: string,
    iteration: number,
    workerOutput: string
  ): Promise<void> {
    const validation = await this.validateAndPreparePhase(projectId, taskId, 'reviewer');
    if (!validation) {
      return;
    }

    const { activeState, state, projectPath } = validation;

    this.logger.info('Running reviewer phase', {
      projectId,
      taskId,
      iteration,
    });

    const reviewerAgent = await this.createReviewerAgent(state, projectPath);
    activeState.reviewerAgent = reviewerAgent;

    this.setupReviewerEventHandlers(reviewerAgent, projectId, taskId, iteration);

    try {
      const feedback = await reviewerAgent.run(state, workerOutput);
      await this.handleReviewerCompletion(projectId, taskId, activeState, feedback);
    } catch (error) {
      // Check if we were stopped
      if (!activeState.shouldContinue) {
        return;
      }
      throw error;
    } finally {
      activeState.reviewerAgent = undefined;
    }
  }

  /**
   * Create a reviewer agent with configuration
   */
  private async createReviewerAgent(
    state: RalphLoopState,
    projectPath: string
  ): Promise<ReviewerAgent> {
    const mcpServers = await this.getMcpServers();

    return this.reviewerAgentFactory.create({
      projectPath,
      model: state.config.reviewerModel,
      contextInitializer: this.contextInitializer,
      appendSystemPrompt: state.config.reviewerSystemPrompt,
      mcpServers,
    });
  }

  /**
   * Setup event handlers for reviewer agent
   */
  private setupReviewerEventHandlers(
    reviewerAgent: ReviewerAgent,
    projectId: string,
    taskId: string,
    iteration: number
  ): void {
    reviewerAgent.on('output', (content) => {
      this.emitter.emit('output', projectId, taskId, 'reviewer', content);
      this.logger.debug('Reviewer output', {
        projectId,
        taskId,
        iteration,
        contentLength: content.length,
      });
    });

    reviewerAgent.on('tool_use', (toolInfo) => {
      this.emitter.emit('tool_use', projectId, taskId, 'reviewer', toolInfo);
      this.logger.debug('Reviewer tool use', {
        projectId,
        taskId,
        iteration,
        toolName: toolInfo.tool_name,
      });
    });
  }

  /**
   * Handle completion of reviewer phase
   */
  private async handleReviewerCompletion(
    projectId: string,
    taskId: string,
    activeState: ActiveLoopState,
    feedback: ReviewerFeedback
  ): Promise<void> {
    await this.repository.addFeedback(projectId, taskId, feedback);
    this.emitter.emit('reviewer_complete', projectId, taskId, feedback);

    // Handle the reviewer's decision if still active
    if (activeState.shouldContinue) {
      await this.handleReviewerDecision(projectId, taskId, feedback);
    }
  }

  /**
   * Handle the reviewer's decision
   */
  private async handleReviewerDecision(
    projectId: string,
    taskId: string,
    feedback: ReviewerFeedback
  ): Promise<void> {
    const key = this.getLoopKey(projectId, taskId);
    const activeState = this.activeLoops.get(key);

    if (!activeState || !activeState.shouldContinue) {
      return;
    }

    switch (feedback.decision) {
      case 'approve':
        await this.completeLoop(projectId, taskId, 'approved');
        break;

      case 'reject':
        await this.completeLoop(projectId, taskId, 'critical_failure');
        break;

      case 'needs_changes':
        // Continue to next iteration
        await this.runNextIteration(projectId, taskId);
        break;
    }
  }

  /**
   * Complete the loop with a final status
   */
  private async completeLoop(
    projectId: string,
    taskId: string,
    finalStatus: RalphLoopFinalStatus
  ): Promise<void> {
    const key = this.getLoopKey(projectId, taskId);
    this.activeLoops.delete(key);

    await this.repository.update(projectId, taskId, {
      status: 'completed',
      finalStatus,
    });

    // Update project status to stopped
    await this.projectRepository.updateStatus(projectId, 'stopped');

    this.emitter.emit('loop_complete', projectId, taskId, finalStatus);

    this.logger.info('Ralph Loop completed', {
      projectId,
      taskId,
      finalStatus,
    });
  }

  /**
   * Handle errors during loop execution
   */
  private async handleLoopError(
    projectId: string,
    taskId: string,
    error: unknown
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);

    const key = this.getLoopKey(projectId, taskId);
    this.activeLoops.delete(key);

    await this.repository.update(projectId, taskId, {
      status: 'failed',
      finalStatus: 'critical_failure',
      error: errorMessage,
    });

    this.emitter.emit('loop_error', projectId, taskId, errorMessage);

    this.logger.error('Ralph Loop error', {
      projectId,
      taskId,
      error: errorMessage,
    });
  }

  /**
   * Delete a Ralph Loop and its associated data
   */
  async delete(projectId: string, taskId: string): Promise<boolean> {
    try {
      const taskKey = this.getLoopKey(projectId, taskId);

      // 1. Stop the loop only if this loop is the one actually running.
      //
      // This used to call stop() unconditionally, and stop() always rewrites the
      // record as `critical_failure / Loop stopped by user` *and* sets the whole
      // project's status to 'stopped'. So deleting a finished loop from the
      // history list stamped a bogus failure on it, and — if another loop or agent
      // was running for that project — reported the project as stopped while it
      // was still working.
      if (this.activeLoops.has(taskKey)) {
        await this.stop(projectId, taskId);
      }

      // 2. Remove from active loops map. The key was built as `${projectId}-...`
      // here while every other site uses getLoopKey (`${projectId}:...`), so this
      // delete never matched anything; it only appeared to work because stop()
      // had already removed the correct key.
      this.activeLoops.delete(taskKey);

      // 3. Delete from repository (filesystem)
      const deleted = await this.repository.delete(projectId, taskId);

      if (deleted) {
        // 4. Emit event for WebSocket clients (optional but good UX)
        this.emitter.emit('loop_deleted', projectId, taskId);

        this.logger.info('Ralph Loop deleted', {
          projectId,
          taskId,
        });
      }

      return deleted;
    } catch (error) {
      this.logger.error('Failed to delete Ralph Loop', {
        projectId,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Clean up old Ralph Loop directories based on history limit
   */
  private async cleanupOldLoops(projectId: string): Promise<void> {
    try {
      const historyLimit = await this.getHistoryLimit();
      const loopsToDelete = await this.getLoopsToDelete(projectId, historyLimit);

      if (loopsToDelete.length > 0) {
        await this.deleteOldLoops(projectId, loopsToDelete);
      }
    } catch (error) {
      // Don't fail the main operation if cleanup fails
      this.logger.error('Failed to cleanup old Ralph Loops', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get the history limit from settings
   */
  private async getHistoryLimit(): Promise<number> {
    if (this.settingsRepository) {
      const settings = await this.settingsRepository.get();
      return settings.ralphLoop.historyLimit;
    }
    return 5; // Default history limit
  }

  /**
   * Get loops that should be deleted based on history limit
   */
  private async getLoopsToDelete(
    projectId: string,
    historyLimit: number
  ): Promise<RalphLoopState[]> {
    const allLoops = await this.repository.findByProject(projectId);

    if (allLoops.length <= historyLimit) {
      return [];
    }

    const loopsToDelete = allLoops.slice(historyLimit);

    this.logger.info('Cleaning up old Ralph Loops', {
      projectId,
      totalLoops: allLoops.length,
      historyLimit,
      toDelete: loopsToDelete.length,
    });

    return loopsToDelete;
  }

  /**
   * Delete old loops, skipping active ones
   */
  private async deleteOldLoops(
    projectId: string,
    loopsToDelete: RalphLoopState[]
  ): Promise<void> {
    for (const loop of loopsToDelete) {
      if (this.isActiveLoop(loop)) {
        this.logger.debug('Skipping cleanup of active loop', {
          projectId,
          taskId: loop.taskId,
          status: loop.status,
        });
        continue;
      }

      const deleted = await this.repository.delete(projectId, loop.taskId);
      if (deleted) {
        this.logger.debug('Deleted old Ralph Loop', {
          projectId,
          taskId: loop.taskId,
          createdAt: loop.createdAt,
        });
      }
    }
  }

  /**
   * Check if a loop is currently active
   */
  private isActiveLoop(loop: RalphLoopState): boolean {
    return loop.status === 'worker_running' ||
           loop.status === 'reviewer_running' ||
           loop.status === 'paused';
  }
}
