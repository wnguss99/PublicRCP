import {
  ApprovalCoordinator,
  buildAllowKey,
  buildAllowRule,
  isOneShotApprovalTool,
} from '../../../src/services/permission-prompt';

describe('ApprovalCoordinator', () => {
  const PROJECT = 'proj-1';
  let coordinator: ApprovalCoordinator;

  beforeEach(() => {
    coordinator = new ApprovalCoordinator({ timeoutMs: 60_000 });
  });

  afterEach(() => {
    coordinator.cancelProject(PROJECT);
  });

  describe('one-shot tools', () => {
    it('classifies ExitPlanMode as one-shot and Bash as not', () => {
      expect(isOneShotApprovalTool('ExitPlanMode')).toBe(true);
      expect(isOneShotApprovalTool('Bash')).toBe(false);
    });

    /**
     * The silent variant of the 2026-08-01 lockout: once ExitPlanMode was in the
     * session allowlist the CLI's gate auto-passed with no user-visible event at
     * all, so the plan card had nothing to click and stayed locked forever.
     */
    it('refuses to remember ExitPlanMode, so later prompts still surface', async () => {
      expect(coordinator.rememberAllow(PROJECT, 'ExitPlanMode', {})).toBeNull();

      void coordinator.request(PROJECT, 'ExitPlanMode', {});

      expect(coordinator.listForProject(PROJECT)).toHaveLength(1);
      expect(coordinator.hasPendingForTool(PROJECT, 'ExitPlanMode')).toBe(true);
    });

    it('still auto-approves a remembered Bash command', async () => {
      expect(coordinator.rememberAllow(PROJECT, 'Bash', { command: 'git status' })).toBe('Bash:git');

      const decision = await coordinator.request(PROJECT, 'Bash', { command: 'git log' });

      expect(decision).toEqual({ behavior: 'allow' });
      expect(coordinator.listForProject(PROJECT)).toHaveLength(0);
    });
  });

  describe('hasPendingForTool', () => {
    it('is false when nothing is pending', () => {
      expect(coordinator.hasPendingForTool(PROJECT, 'ExitPlanMode')).toBe(false);
    });

    it('is scoped to the project and the tool', () => {
      void coordinator.request(PROJECT, 'ExitPlanMode', {});

      expect(coordinator.hasPendingForTool(PROJECT, 'ExitPlanMode')).toBe(true);
      expect(coordinator.hasPendingForTool(PROJECT, 'Bash')).toBe(false);
      expect(coordinator.hasPendingForTool('other-project', 'ExitPlanMode')).toBe(false);
    });

    it('goes false once the request is resolved', async () => {
      const pendingPromise = coordinator.request(PROJECT, 'ExitPlanMode', {});
      const [pending] = coordinator.listForProject(PROJECT);

      coordinator.resolve(pending!.requestId, { behavior: 'allow' });
      await pendingPromise;

      expect(coordinator.hasPendingForTool(PROJECT, 'ExitPlanMode')).toBe(false);
    });
  });

  describe('resolved event', () => {
    it('carries the pending approval so listeners can filter by tool', async () => {
      const seen: Array<{ toolName: string; projectId: string }> = [];
      coordinator.on('resolved', (_requestId, projectId, _decision, pending) => {
        seen.push({ toolName: pending.toolName, projectId });
      });

      const pendingPromise = coordinator.request(PROJECT, 'ExitPlanMode', {});
      const [pending] = coordinator.listForProject(PROJECT);
      coordinator.resolve(pending!.requestId, { behavior: 'allow' });
      await pendingPromise;

      expect(seen).toEqual([{ toolName: 'ExitPlanMode', projectId: PROJECT }]);
    });
  });

  describe('allow key and rule building (unchanged behaviour)', () => {
    it('keys Bash by its first word', () => {
      expect(buildAllowKey('Bash', { command: 'git status' })).toBe('Bash:git');
      expect(buildAllowRule('Bash', { command: 'git status' })).toBe('Bash(git:*)');
    });

    it('keys other tools by name', () => {
      expect(buildAllowKey('Write', {})).toBe('Write');
      expect(buildAllowRule('Write', {})).toBe('Write');
    });
  });
});
