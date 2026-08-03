/**
 * A replaced agent must stop influencing its project, and the stored status must
 * always describe the agent that actually owns it.
 *
 * The 2026-08-03 G1 incident: a process exited with code 1, a replacement started
 * on the same session and worked normally for the next eight minutes, but
 * status.json was left saying "error". Every fresh page load reported the project
 * as failed while it was busy; switching project and back made it look fine again,
 * because that path reads the live agent instead of the stored value.
 *
 * Two defects made that possible and both are covered here:
 *   1. handleStatusChange() persisted whatever status was reported, so write order
 *      decided the result and a live agent never re-asserted the truth.
 *   2. handleAgentExit() removed the agent from the map but never detached its
 *      listeners, so a dead agent could keep writing project state.
 */
import { DefaultAgentManager, AgentManagerDependencies } from '../../../src/agents/agent-manager';
import { Agent } from '../../../src/agents/agent';
import {
  createMockAgent,
  createMockAgentFactory,
  createMockProjectRepository,
  createMockConversationRepository,
  createMockInstructionGenerator,
  createMockRoadmapParser,
  createMockPermissionGenerator,
  createMockSettingsRepository,
  createTestProject,
} from '../helpers/mock-factories';

describe('DefaultAgentManager — status ownership', () => {
  let agentManager: DefaultAgentManager;
  let mockAgent: jest.Mocked<Agent>;
  let projectRepository: ReturnType<typeof createMockProjectRepository>;
  const PROJECT = 'test-project';
  const SESSION_ID = '11111111-2222-4333-8444-555555555555';
  const testProject = createTestProject({ id: PROJECT });

  const emit = (agent: Agent, event: string, ...args: unknown[]): void => {
    (agent as unknown as { _emit: (e: string, ...a: unknown[]) => void })._emit(event, ...args);
  };

  const setStatus = (agent: Agent, status: string): void => {
    (agent as unknown as { _setStatus?: (s: string) => void })._setStatus?.(status);
  };

  const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The status value currently stored for the project. */
  const storedStatus = (): string | undefined => {
    const calls = projectRepository.updateStatus.mock.calls;
    return calls.length > 0 ? (calls[calls.length - 1]![1] as string) : undefined;
  };

  beforeEach(() => {
    mockAgent = createMockAgent(PROJECT);
    (mockAgent as unknown as { _setSessionId: (id: string) => void })._setSessionId(SESSION_ID);

    projectRepository = createMockProjectRepository([testProject]);

    const deps: AgentManagerDependencies = {
      maxConcurrentAgents: 3,
      agentFactory: createMockAgentFactory(mockAgent),
      projectRepository,
      conversationRepository: createMockConversationRepository(),
      instructionGenerator: createMockInstructionGenerator(),
      roadmapParser: createMockRoadmapParser(),
      permissionGenerator: createMockPermissionGenerator(),
      settingsRepository: createMockSettingsRepository(),
    };

    agentManager = new DefaultAgentManager(deps);
  });

  afterEach(async () => {
    await agentManager.stopAgent(PROJECT).catch(() => undefined);
  });

  it('does not leave the stored status at error once no process is running', async () => {
    await agentManager.startInteractiveAgent(PROJECT);

    // _setStatus emits 'status' itself, which is the real path into the manager.
    setStatus(mockAgent, 'error');
    await settle();
    expect(storedStatus()).toBe('error'); // accurate while the process is dying

    // The exit that follows must reconcile it: nothing is running now, so 'error'
    // would outlive the process it described — that is the value G1 was stuck on.
    emit(mockAgent, 'exit', 1);
    await settle();

    expect(storedStatus()).toBe('stopped');
    expect(agentManager.getAgentStatus(PROJECT)).toBe('stopped');
  });

  it('ignores a status reported by an agent that no longer owns the project', async () => {
    await agentManager.startInteractiveAgent(PROJECT);
    const replaced = mockAgent;

    const live = createMockAgent(PROJECT);
    (live as unknown as { _setSessionId: (id: string) => void })._setSessionId(SESSION_ID);
    (agentManager as unknown as { agents: Map<string, Agent> }).agents.set(PROJECT, live);
    setStatus(live, 'running');
    await settle();

    projectRepository.updateStatus.mockClear();

    // Called directly so this exercises the ownership guard itself, not the
    // listener teardown (covered separately below). This is the event that used
    // to stamp 'error' over a project that was working fine.
    await (
      agentManager as unknown as { handleStatusChange: (a: Agent, s: string) => Promise<void> }
    ).handleStatusChange(replaced, 'error');

    expect(projectRepository.updateStatus).not.toHaveBeenCalled();
    expect(agentManager.getAgentStatus(PROJECT)).toBe('running');
  });

  it('detaches a replaced agent so its later events cannot reach the project', async () => {
    await agentManager.startInteractiveAgent(PROJECT);

    emit(mockAgent, 'exit', 0);
    await settle();

    projectRepository.updateStatus.mockClear();
    const waitingSpy = jest.fn();
    agentManager.on('waitingForInput', waitingSpy);

    // Every channel the dead agent still had a listener on.
    emit(mockAgent, 'status', 'error');
    emit(mockAgent, 'waitingForInput', { isWaiting: true, version: 99 });
    emit(mockAgent, 'exitPlanMode', '## plan');
    await settle();

    expect(projectRepository.updateStatus).not.toHaveBeenCalled();
    expect(waitingSpy).not.toHaveBeenCalled();
    expect(agentManager.hasPendingPlan(PROJECT)).toBe(false);
  });

  it('derives the stored status from the current owner, whatever was reported', async () => {
    await agentManager.startInteractiveAgent(PROJECT);
    await settle();
    expect(mockAgent.status).toBe('running');
    projectRepository.updateStatus.mockClear();

    // A bare 'stopped' report from an agent that is in fact running must not be
    // copied verbatim: the stored value is derived from the owner's real state, so
    // write order can no longer decide what ends up on disk.
    emit(mockAgent, 'status', 'stopped');
    await settle();

    expect(storedStatus()).toBe('running');
  });

  /**
   * Without these two, an incident leaves no trace: the failure line and the
   * request that triggered it were both broadcast-only, so a page reload erased
   * the evidence and the stored conversation began with Claude answering a
   * question that was not in it.
   */
  describe('what gets written to the conversation', () => {
    let conversationRepository: ReturnType<typeof createMockConversationRepository>;

    const savedContents = (): string[] =>
      conversationRepository.addMessage.mock.calls.map(
        (call) => (call[2] as { content?: string } | undefined)?.content ?? ''
      );

    beforeEach(() => {
      conversationRepository = createMockConversationRepository();
      mockAgent = createMockAgent(PROJECT);
      (mockAgent as unknown as { _setSessionId: (id: string) => void })._setSessionId(SESSION_ID);
      projectRepository = createMockProjectRepository([testProject]);

      agentManager = new DefaultAgentManager({
        maxConcurrentAgents: 3,
        agentFactory: createMockAgentFactory(mockAgent),
        projectRepository,
        conversationRepository,
        instructionGenerator: createMockInstructionGenerator(),
        roadmapParser: createMockRoadmapParser(),
        permissionGenerator: createMockPermissionGenerator(),
        settingsRepository: createMockSettingsRepository(),
      } as AgentManagerDependencies);
    });

    it('persists system messages such as the exit line', async () => {
      await agentManager.startInteractiveAgent(PROJECT);

      emit(mockAgent, 'message', {
        type: 'system',
        content: 'Claude agent exited with code 1',
        timestamp: new Date().toISOString(),
      });
      await settle();

      expect(savedContents()).toContain('Claude agent exited with code 1');
    });

    it('persists the request that started the agent when the user typed it', async () => {
      await agentManager.startInteractiveAgent(PROJECT, {
        initialMessage: 'fix the month chart',
        persistInitialMessage: true,
      });
      await settle();

      expect(savedContents()).toContain('fix the month chart');
    });

    it('does not persist synthetic prompts from internal restarts', async () => {
      await agentManager.startInteractiveAgent(PROJECT, {
        initialMessage: 'I approved the plan. Please proceed with implementing it.',
      });
      await settle();

      expect(savedContents()).not.toContain('I approved the plan. Please proceed with implementing it.');
    });
  });

  describe('reconcilePersistedStatuses', () => {
    it('clears statuses left behind by a previous run', async () => {
      projectRepository.findAll.mockResolvedValue([
        { ...testProject, id: 'a', status: 'running' },
        { ...testProject, id: 'b', status: 'error' },
        { ...testProject, id: 'c', status: 'stopped' },
      ] as never);

      const corrected = await agentManager.reconcilePersistedStatuses();

      expect(corrected).toBe(2);
      expect(projectRepository.updateStatus).toHaveBeenCalledWith('a', 'stopped');
      expect(projectRepository.updateStatus).toHaveBeenCalledWith('b', 'stopped');
      expect(projectRepository.updateStatus).not.toHaveBeenCalledWith('c', 'stopped');
    });

    it('leaves a project alone when an agent really is running for it', async () => {
      await agentManager.startInteractiveAgent(PROJECT);
      projectRepository.findAll.mockResolvedValue([
        { ...testProject, id: PROJECT, status: 'running' },
      ] as never);
      projectRepository.updateStatus.mockClear();

      const corrected = await agentManager.reconcilePersistedStatuses();

      expect(corrected).toBe(0);
      expect(projectRepository.updateStatus).not.toHaveBeenCalled();
    });
  });
});
