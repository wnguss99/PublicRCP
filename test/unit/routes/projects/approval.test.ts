import express, { Express } from 'express';
import request from 'supertest';
import {
  createMockProjectRepository,
  createMockProjectService,
  createMockAgentManager,
  createMockSettingsRepository,
  createMockRoadmapParser,
  createMockRoadmapGenerator,
  createMockRoadmapEditor,
  createMockConversationRepository,
  createMockGitService,
  createMockInstructionGenerator,
  sampleProject,
} from '../../helpers/mock-factories';
import { createProjectsRouter, ProjectRouterDependencies } from '../../../../src/routes/projects';
import { createErrorHandler } from '../../../../src/utils';
import { ApprovalCoordinator } from '../../../../src/services/permission-prompt';

jest.mock('../../../../src/middleware/rate-limit', () => ({
  roadmapGenerationRateLimit: (_req: any, _res: any, next: any) => next(),
  agentOperationRateLimit: (_req: any, _res: any, next: any) => next(),
  moderateRateLimit: (_req: any, _res: any, next: any) => next(),
  strictRateLimit: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../../../src/routes', () => ({
  ...jest.requireActual('../../../../src/routes'),
  getWebSocketServer: jest.fn(() => null),
  getAgentManager: jest.fn(() => null),
  getProcessTracker: jest.fn(() => null),
  getRalphLoopService: jest.fn(() => null),
}));

function buildApp(deps: ProjectRouterDependencies): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', createProjectsRouter(deps));
  app.use(createErrorHandler());
  return app;
}

function buildDeps(coordinator: ApprovalCoordinator): ProjectRouterDependencies {
  return {
    projectRepository: createMockProjectRepository([{ ...sampleProject }]),
    projectService: createMockProjectService(),
    roadmapParser: createMockRoadmapParser(),
    roadmapGenerator: createMockRoadmapGenerator(),
    roadmapEditor: createMockRoadmapEditor(),
    agentManager: createMockAgentManager(),
    instructionGenerator: createMockInstructionGenerator(),
    conversationRepository: createMockConversationRepository(),
    settingsRepository: createMockSettingsRepository(),
    gitService: createMockGitService(),
    approvalCoordinator: coordinator,
  };
}

const PROJECT_ID = sampleProject.id;

describe('Approval routes — allow_always', () => {
  let coordinator: ApprovalCoordinator;
  let deps: ProjectRouterDependencies;
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    coordinator = new ApprovalCoordinator({ timeoutMs: 60_000 });
    deps = buildDeps(coordinator);
    app = buildApp(deps);
  });

  afterEach(() => {
    coordinator.cancelProject(PROJECT_ID);
  });

  const openPrompt = (toolName: string, input: Record<string, unknown> = {}): string => {
    void coordinator.request(PROJECT_ID, toolName, input);
    const pending = coordinator.listForProject(PROJECT_ID);
    return pending[pending.length - 1]!.requestId;
  };

  /**
   * ExitPlanMode decides one specific plan. Persisting it as standing policy is
   * what let the CLI's gate auto-pass silently while claudito's plan card stayed
   * locked — the invisible variant of the 2026-08-01 lockout.
   */
  it('does not persist a rule for ExitPlanMode', async () => {
    const requestId = openPrompt('ExitPlanMode');

    const response = await request(app)
      .post(`/api/projects/${PROJECT_ID}/approval/resolve`)
      .send({ requestId, decision: 'allow_always' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.persistedRule).toBeNull();
    expect(deps.projectRepository.updatePermissionOverrides).not.toHaveBeenCalled();
  });

  it('does not remember ExitPlanMode, so the next prompt still surfaces', async () => {
    const requestId = openPrompt('ExitPlanMode');

    await request(app)
      .post(`/api/projects/${PROJECT_ID}/approval/resolve`)
      .send({ requestId, decision: 'allow_always' });

    void coordinator.request(PROJECT_ID, 'ExitPlanMode', {});
    expect(coordinator.hasPendingForTool(PROJECT_ID, 'ExitPlanMode')).toBe(true);
  });

  it('still persists a rule for a normal tool', async () => {
    const requestId = openPrompt('Bash', { command: 'git status' });

    const response = await request(app)
      .post(`/api/projects/${PROJECT_ID}/approval/resolve`)
      .send({ requestId, decision: 'allow_always' });

    expect(response.status).toBe(200);
    expect(response.body.persistedRule).toBe('Bash(git:*)');
    expect(deps.projectRepository.updatePermissionOverrides).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ enabled: true, allowRules: expect.arrayContaining(['Bash(git:*)']) })
    );
  });

  it('still auto-approves the remembered normal tool afterwards', async () => {
    const requestId = openPrompt('Bash', { command: 'git status' });

    await request(app)
      .post(`/api/projects/${PROJECT_ID}/approval/resolve`)
      .send({ requestId, decision: 'allow_always' });

    await expect(coordinator.request(PROJECT_ID, 'Bash', { command: 'git log' })).resolves.toEqual({
      behavior: 'allow',
    });
  });

  it('rejects an unknown requestId', async () => {
    const response = await request(app)
      .post(`/api/projects/${PROJECT_ID}/approval/resolve`)
      .send({ requestId: 'does-not-exist', decision: 'allow_always' });

    expect(response.status).toBe(404);
  });
});
