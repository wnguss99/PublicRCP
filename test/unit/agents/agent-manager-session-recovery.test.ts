import { DefaultAgentManager, AgentManagerDependencies } from '../../../src/agents/agent-manager';
import { Agent } from '../../../src/agents/agent';
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
 * Regression cover for the "Claude agent exited with code 1" report.
 *
 * The chain that produced it:
 *   1. ExitPlanMode arrives with an empty `input` on current CLI versions, so
 *      the captured plan content is ''.
 *   2. Approving the plan started a *new* session and, because the plan text was
 *      empty, sent no initial message. Nothing was ever written to that session
 *      id, so the CLI wrote no transcript for it.
 *   3. claudito stored the id as the project's conversation anyway, so the next
 *      message resumed a session the CLI had never heard of. The process died
 *      and the chat showed a bare "Claude agent exited with code 1".
 */
describe('DefaultAgentManager — plan approval and session recovery', () => {
  let agentManager: DefaultAgentManager;
  let mockAgent: jest.Mocked<Agent>;
  const testProject = createTestProject({ id: 'test-project' });

  const emit = (event: string, ...args: unknown[]): void => {
    (mockAgent as unknown as { _emit: (e: string, ...a: unknown[]) => void })._emit(event, ...args);
  };

  const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));

  // 실제 세션 ID 는 UUID 다. mock 기본값('mock-session-xxx')은 UUID 가 아니어서
  // session-manager 의 isValidUUID 검사에 걸려 복구 경로로 빠지고, 운영과 다른
  // 흐름을 테스트하게 된다.
  const PLAN_SESSION_ID = '11111111-2222-4333-8444-555555555555';

  let mockConversationRepo: ReturnType<typeof createMockConversationRepository>;

  beforeEach(() => {
    mockAgent = createMockAgent('test-project');
    (mockAgent as unknown as { _setSessionId: (id: string) => void })._setSessionId(PLAN_SESSION_ID);

    mockConversationRepo = createMockConversationRepository();

    // 계획을 만든 대화는 실제로는 이미 존재한다. mock 에 없으면 session-manager 가
    // "요청한 세션 없음" 으로 판단해 복구 경로로 빠지고, 운영과 다른 흐름이 된다.
    mockConversationRepo.findById.mockImplementation((projectId: string, id: string) =>
      Promise.resolve(
        id === PLAN_SESSION_ID
          ? ({ id, projectId, itemRef: null, messages: [], createdAt: '', updatedAt: '' } as never)
          : null
      )
    );

    const deps: AgentManagerDependencies = {
      maxConcurrentAgents: 3,
      agentFactory: createMockAgentFactory(mockAgent),
      projectRepository: createMockProjectRepository([testProject]),
      conversationRepository: mockConversationRepo,
      instructionGenerator: createMockInstructionGenerator(),
      roadmapParser: createMockRoadmapParser(),
      permissionGenerator: createMockPermissionGenerator(),
      settingsRepository: createMockSettingsRepository(),
    };

    agentManager = new DefaultAgentManager(deps);
  });

  afterEach(async () => {
    await agentManager.stopAgent('test-project').catch(() => undefined);
  });

  describe('plan approval', () => {
    it('always sends a message so the session is never left empty', async () => {
      await agentManager.startInteractiveAgent('test-project');

      // Empty plan content is what the current CLI actually delivers.
      emit('exitPlanMode', '');
      await settle(100);

      mockAgent.start.mockClear();
      agentManager.sendInput('test-project', 'yes');
      await settle();

      expect(mockAgent.start).toHaveBeenCalled();
      const [initialMessage] = mockAgent.start.mock.calls.at(-1) as [string | undefined];

      // An undefined/empty initial message is what created the phantom session.
      expect(initialMessage).toBeTruthy();
      expect(String(initialMessage).trim().length).toBeGreaterThan(0);
    });

    it('resumes the session the plan was made in rather than starting a new one', async () => {
      await agentManager.startInteractiveAgent('test-project');
      const planSessionId = mockAgent.sessionId;

      emit('exitPlanMode', '');
      await settle(100);

      const factory = (agentManager as unknown as { agentFactory: { create: jest.Mock } }).agentFactory;
      factory.create.mockClear();

      agentManager.sendInput('test-project', 'yes');
      await settle();

      const options = factory.create.mock.calls.at(-1)?.[0] as
        { sessionId?: string; isNewSession?: boolean } | undefined;

      // A fresh session would discard the conversation that produced the plan,
      // and (with empty plan text) leave a session the CLI never materialised.
      expect(options?.sessionId).toBe(planSessionId);
      expect(options?.isNewSession).toBe(false);
    });

    it('does not repeat the plan text when resuming, to avoid duplicating it', async () => {
      await agentManager.startInteractiveAgent('test-project');

      const plan = '## Plan\n1. do the thing';
      emit('exitPlanMode', plan);
      await settle(100);

      mockAgent.start.mockClear();
      agentManager.sendInput('test-project', 'yes');
      await settle();

      const [initialMessage] = mockAgent.start.mock.calls.at(-1) as [string | undefined];
      expect(initialMessage).toBeTruthy();
      // The plan is already in the resumed transcript.
      expect(initialMessage).not.toBe(plan);
    });
  });

  describe('session recovery', () => {
    it('restarts the agent instead of leaving the user with an exit code', async () => {
      await agentManager.startInteractiveAgent('test-project');

      mockAgent.start.mockClear();

      // The real order: the CLI reports the missing session, then the process
      // dies with code 1. The restart has to wait for the slot to free up.
      emit('sessionNotFound', 'session-the-cli-never-saw');
      await settle(200);
      emit('exit', 1);
      await settle();

      // Recovery used to stop after creating a new session, so the dying
      // process reported "exited with code 1" and the user had to resend.
      expect(mockAgent.start).toHaveBeenCalled();
    });

    it('tells the user their message was lost rather than failing silently', async () => {
      const messages: Array<{ type: string; content: string }> = [];
      agentManager.on('message', (_p: string, m: { type: string; content: string }) => messages.push(m));

      await agentManager.startInteractiveAgent('test-project');
      emit('sessionNotFound', 'session-the-cli-never-saw');
      await settle();

      const notice = messages.find((m) => m.type === 'system' && m.content.includes('다시 보내'));
      expect(notice).toBeDefined();
    });

    it('creates the recovered session instead of resuming an id the CLI lacks', async () => {
      await agentManager.startInteractiveAgent('test-project');

      const factory = (agentManager as unknown as { agentFactory: { create: jest.Mock } }).agentFactory;
      factory.create.mockClear();

      emit('sessionNotFound', 'session-the-cli-never-saw');
      await settle(200);
      emit('exit', 1);
      await settle();

      // Resuming the freshly minted recovery id would fail the same way and
      // loop forever, so it must be created with --session-id.
      const options = factory.create.mock.calls.at(-1)?.[0] as
        { isNewSession?: boolean } | undefined;
      expect(options).toBeDefined();
      expect(options?.isNewSession).toBe(true);
    });

    it('survives a failed restart without taking the instance down', async () => {
      await agentManager.startInteractiveAgent('test-project');

      mockAgent.start.mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });

      emit('sessionNotFound', 'session-the-cli-never-saw');
      await settle(200);
      emit('exit', 1);
      await settle();

      expect(agentManager.getFullStatus('test-project')).toBeDefined();
    });
  });
});
