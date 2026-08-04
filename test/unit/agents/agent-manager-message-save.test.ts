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
 * A failed conversation write must not take the instance down.
 *
 * `trackMessageSave` used `void promise.finally(...)`. `.finally()` returns a
 * *new* promise that inherits the rejection, and `void` left it without a
 * handler — so even though every call site attaches `.catch()` to the original,
 * the derived promise became an unhandled rejection and Node's default policy
 * terminated the process.
 *
 * This is not theoretical: this host produces `EPERM: operation not permitted,
 * rename` on the conversation `.tmp` → `.json` rename regularly (antivirus /
 * file locking on Windows), and those errors line up with PM2 restart counts in
 * the high hundreds.
 */
describe('DefaultAgentManager — a failed message save must not crash the process', () => {
  let agentManager: DefaultAgentManager;
  let mockAgent: jest.Mocked<Agent>;
  let conversationRepository: ReturnType<typeof createMockConversationRepository>;
  const PROJECT = 'test-project';
  const SESSION_ID = '11111111-2222-4333-8444-555555555555';

  const emit = (event: string, ...args: unknown[]): void => {
    (mockAgent as unknown as { _emit: (e: string, ...a: unknown[]) => void })._emit(event, ...args);
  };

  const settle = (ms = 50): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  function captureUnhandled(): { events: unknown[]; restore: () => void } {
    const events: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      events.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);

    return {
      events,
      restore: () => process.off('unhandledRejection', onUnhandled),
    };
  }

  beforeEach(() => {
    mockAgent = createMockAgent(PROJECT);
    (mockAgent as unknown as { _setSessionId: (id: string) => void })._setSessionId(SESSION_ID);

    conversationRepository = createMockConversationRepository();
    conversationRepository.findById.mockImplementation((projectId: string, id: string) =>
      Promise.resolve(
        id === SESSION_ID
          ? ({ id, projectId, itemRef: null, messages: [], createdAt: '', updatedAt: '' } as never)
          : null
      )
    );

    const deps: AgentManagerDependencies = {
      maxConcurrentAgents: 3,
      agentFactory: createMockAgentFactory(mockAgent),
      projectRepository: createMockProjectRepository([createTestProject({ id: PROJECT })]),
      conversationRepository,
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

  it('leaves no unhandled rejection when the conversation write fails', async () => {
    await agentManager.startInteractiveAgent(PROJECT);

    // The exact failure this host produces.
    const eperm = Object.assign(new Error('EPERM: operation not permitted, rename'), {
      code: 'EPERM',
    });
    conversationRepository.addMessage.mockRejectedValue(eperm);

    const captured = captureUnhandled();

    emit('message', {
      type: 'stdout',
      content: 'some output',
      timestamp: new Date().toISOString(),
    });

    await settle();
    captured.restore();

    expect(captured.events).toEqual([]);
  });

  it('still drains pendingMessageSaves so shutdown is not blocked', async () => {
    await agentManager.startInteractiveAgent(PROJECT);
    conversationRepository.addMessage.mockRejectedValue(new Error('disk full'));

    const captured = captureUnhandled();

    emit('message', {
      type: 'stdout',
      content: 'a',
      timestamp: new Date().toISOString(),
    });
    emit('message', {
      type: 'stdout',
      content: 'b',
      timestamp: new Date().toISOString(),
    });

    await settle();

    const pending = (agentManager as unknown as { pendingMessageSaves: Set<unknown> })
      .pendingMessageSaves;

    captured.restore();

    expect(pending.size).toBe(0);
    expect(captured.events).toEqual([]);
  });

  it('keeps saving later messages after one write fails', async () => {
    await agentManager.startInteractiveAgent(PROJECT);

    conversationRepository.addMessage.mockRejectedValueOnce(new Error('transient EPERM'));
    const captured = captureUnhandled();

    emit('message', { type: 'stdout', content: 'fails', timestamp: new Date().toISOString() });
    await settle();

    conversationRepository.addMessage.mockResolvedValue(undefined as never);
    emit('message', { type: 'stdout', content: 'succeeds', timestamp: new Date().toISOString() });
    await settle();

    captured.restore();

    const saved = conversationRepository.addMessage.mock.calls.map(
      (call) => (call[2] as { content?: string } | undefined)?.content
    );

    expect(saved).toContain('fails');
    expect(saved).toContain('succeeds');
    expect(captured.events).toEqual([]);
  });
});
