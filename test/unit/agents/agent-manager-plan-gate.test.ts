import { DefaultAgentManager, AgentManagerDependencies } from '../../../src/agents/agent-manager';
import { Agent } from '../../../src/agents/agent';
import { ApprovalCoordinator } from '../../../src/services/permission-prompt';
import {
  createMockAgentFactory,
  createMockAgent,
  createMockProjectRepository,
  createMockConversationRepository,
  createMockInstructionGenerator,
  createMockRoadmapParser,
  createMockPermissionGenerator,
  createMockSettingsRepository,
  createTestProject,
} from '../helpers/mock-factories';

/**
 * Regression cover for the "input box is dead until the server restarts" report
 * (2026-08-01, five projects across two ports).
 *
 * ExitPlanMode has two independent approval paths that did not know about each
 * other:
 *
 *   A. claudito's own plan card — sets pendingPlans, cleared only by answering
 *      that card.
 *   B. the permission-prompt MCP server the CLI calls — resolves the CLI's gate
 *      so the run continues, and never touched pendingPlans.
 *
 * Answering B left A's entry behind. The agent resumed, so its isWaitingForInput
 * went false, which also disabled the one branch in sendInput that could have
 * consumed the plan. From then on every message was rejected with 400 and the
 * composer stayed disabled, with no reachable control to recover.
 */
describe('DefaultAgentManager — ExitPlanMode gate', () => {
  let agentManager: DefaultAgentManager;
  let mockAgent: jest.Mocked<Agent>;
  let coordinator: ApprovalCoordinator;
  const PROJECT = 'test-project';
  const PLAN_SESSION_ID = '11111111-2222-4333-8444-555555555555';
  const testProject = createTestProject({ id: PROJECT });

  const emit = (event: string, ...args: unknown[]): void => {
    (mockAgent as unknown as { _emit: (e: string, ...a: unknown[]) => void })._emit(event, ...args);
  };

  const setProcessing = (processing: boolean): void => {
    (mockAgent as unknown as { _setProcessing: (p: boolean) => void })._setProcessing(processing);
  };

  const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Answer the single approval the coordinator is holding for this project. */
  const resolveOnlyPending = (decision: Parameters<ApprovalCoordinator['resolve']>[1]): void => {
    const pending = coordinator.listForProject(PROJECT);
    if (pending.length !== 1) {
      throw new Error(`expected exactly one pending approval, got ${pending.length}`);
    }
    coordinator.resolve(pending[0]!.requestId, decision);
  };

  /** Reach into the private map to age an entry past the grace window. */
  const agePlan = (projectId: string, ms: number): void => {
    const plans = (agentManager as unknown as {
      pendingPlans: Map<string, { createdAt: number }>;
    }).pendingPlans;
    const entry = plans.get(projectId);
    if (entry) {
      entry.createdAt = Date.now() - ms;
    }
  };

  beforeEach(() => {
    mockAgent = createMockAgent(PROJECT);
    (mockAgent as unknown as { _setSessionId: (id: string) => void })._setSessionId(PLAN_SESSION_ID);

    const conversationRepository = createMockConversationRepository();
    conversationRepository.findById.mockImplementation((projectId: string, id: string) =>
      Promise.resolve(
        id === PLAN_SESSION_ID
          ? ({ id, projectId, itemRef: null, messages: [], createdAt: '', updatedAt: '' } as never)
          : null
      )
    );

    coordinator = new ApprovalCoordinator({ timeoutMs: 60_000 });

    const deps: AgentManagerDependencies = {
      maxConcurrentAgents: 3,
      agentFactory: createMockAgentFactory(mockAgent),
      projectRepository: createMockProjectRepository([testProject]),
      conversationRepository,
      instructionGenerator: createMockInstructionGenerator(),
      roadmapParser: createMockRoadmapParser(),
      permissionGenerator: createMockPermissionGenerator(),
      settingsRepository: createMockSettingsRepository(),
      approvalCoordinator: coordinator,
    };

    agentManager = new DefaultAgentManager(deps);
  });

  afterEach(async () => {
    await agentManager.stopAgent(PROJECT).catch(() => undefined);
  });

  describe('resolved through the CLI permission modal', () => {
    it('releases the plan lock and lets the next message through (the incident)', async () => {
      await agentManager.startInteractiveAgent(PROJECT);

      emit('exitPlanMode', '## plan');
      await settle();
      expect(agentManager.hasPendingPlan(PROJECT)).toBe(true);

      // The CLI raises its own gate for the same tool, and the user answers
      // *that* modal rather than the plan card.
      const requestPromise = coordinator.request(PROJECT, 'ExitPlanMode', {});
      resolveOnlyPending({ behavior: 'allow' });
      await requestPromise;
      await settle();

      expect(agentManager.hasPendingPlan(PROJECT)).toBe(false);
      expect(agentManager.getFullStatus(PROJECT).hasPendingPlan).toBe(false);

      // The agent carried on, so it is no longer idle.
      setProcessing(true);
      mockAgent.start.mockClear();
      mockAgent.sendInput.mockClear();

      agentManager.sendInput(PROJECT, 'next task');
      await settle();

      // Delivered as a normal message — not swallowed as a plan answer, and no
      // plan-approval restart.
      expect(mockAgent.sendInput).toHaveBeenCalledWith('next task');
      expect(mockAgent.start).not.toHaveBeenCalled();
    });

    it('also releases the lock when the modal is denied', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      emit('exitPlanMode', '## plan');
      await settle();

      const requestPromise = coordinator.request(PROJECT, 'ExitPlanMode', {});
      resolveOnlyPending({ behavior: 'deny', message: 'no' });
      await requestPromise;
      await settle();

      expect(agentManager.hasPendingPlan(PROJECT)).toBe(false);
    });

    it('emits planStateChanged(false) exactly once so the UI converges', async () => {
      await agentManager.startInteractiveAgent(PROJECT);

      const states: boolean[] = [];
      agentManager.on('planStateChanged', (_projectId, hasPending) => {
        states.push(hasPending);
      });

      emit('exitPlanMode', '## plan');
      await settle();

      const requestPromise = coordinator.request(PROJECT, 'ExitPlanMode', {});
      resolveOnlyPending({ behavior: 'allow' });
      await requestPromise;
      await settle();

      expect(states).toEqual([true, false]);
    });

    it('ignores resolutions for other tools', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      emit('exitPlanMode', '## plan');
      await settle();

      const requestPromise = coordinator.request(PROJECT, 'Bash', { command: 'ls' });
      resolveOnlyPending({ behavior: 'allow' });
      await requestPromise;
      await settle();

      expect(agentManager.hasPendingPlan(PROJECT)).toBe(true);
    });
  });

  describe('reconcilePendingPlan', () => {
    it('reports none when no plan was stored', async () => {
      await agentManager.startInteractiveAgent(PROJECT);

      expect(agentManager.reconcilePendingPlan(PROJECT)).toBe('none');
    });

    it('keeps a plan live while the agent is idle and waiting', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      emit('exitPlanMode', '## plan');
      await settle();

      agePlan(PROJECT, 10 * 60 * 1000);
      setProcessing(false); // idle => isWaitingForInput true

      expect(agentManager.reconcilePendingPlan(PROJECT)).toBe('live');
      expect(agentManager.hasPendingPlan(PROJECT)).toBe(true);
    });

    it('keeps a plan live while the CLI modal is still open', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      emit('exitPlanMode', '## plan');
      await settle();

      void coordinator.request(PROJECT, 'ExitPlanMode', {});
      agePlan(PROJECT, 10 * 60 * 1000);
      setProcessing(true); // busy, so only the open modal keeps it live

      expect(agentManager.reconcilePendingPlan(PROJECT)).toBe('live');
      expect(agentManager.hasPendingPlan(PROJECT)).toBe(true);
    });

    it('keeps a freshly created plan live even while the agent is busy', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      emit('exitPlanMode', '## plan');
      await settle();

      // handleExitPlanMode marks the manager as waiting before the agent flips
      // its own flag; without the grace window this would be judged stale.
      setProcessing(true);

      expect(agentManager.reconcilePendingPlan(PROJECT)).toBe('live');
    });

    it('clears a plan the run moved past', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      emit('exitPlanMode', '## plan');
      await settle();

      agePlan(PROJECT, 10 * 60 * 1000);
      setProcessing(true);

      expect(agentManager.reconcilePendingPlan(PROJECT)).toBe('cleared');
      expect(agentManager.hasPendingPlan(PROJECT)).toBe(false);
    });

    it('clears a plan whose session is no longer the running one', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      emit('exitPlanMode', '## plan');
      await settle();

      (mockAgent as unknown as { _setSessionId: (id: string) => void })._setSessionId(
        '99999999-2222-4333-8444-555555555555'
      );

      expect(agentManager.reconcilePendingPlan(PROJECT)).toBe('cleared');
    });

    it('clears a plan when no agent is running', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      emit('exitPlanMode', '## plan');
      await settle();

      // Reach past stopAgent(), which would delete the plan for other reasons.
      (agentManager as unknown as { agents: Map<string, Agent> }).agents.delete(PROJECT);

      expect(agentManager.reconcilePendingPlan(PROJECT)).toBe('cleared');
      expect(agentManager.hasPendingPlan(PROJECT)).toBe(false);
    });
  });

  describe('sendInput with a live plan', () => {
    it('still routes to plan approval rather than sending a normal message', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      emit('exitPlanMode', '## plan');
      await settle();

      setProcessing(false); // idle => the plan is a real gate
      mockAgent.start.mockClear();

      agentManager.sendInput(PROJECT, 'yes');
      await settle(900);

      // Approving restarts the agent in acceptEdits; a plain sendInput would not.
      expect(mockAgent.start).toHaveBeenCalled();
      expect(agentManager.hasPendingPlan(PROJECT)).toBe(false);
    });
  });
});
