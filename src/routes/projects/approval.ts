import { Router, Request, Response } from 'express';
import { ProjectRouterDependencies } from './types';
import { ApprovalDecision, buildAllowRule } from '../../services/permission-prompt';
import { getLogger } from '../../utils/logger';

interface ApprovalBody {
  requestId?: string;
  decision?: 'allow' | 'deny' | 'allow_always';
  message?: string;
}

interface ApprovalModeBody {
  mode?: 'ask' | 'auto';
}

export function createApprovalRouter(deps: ProjectRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const logger = getLogger('approval-route');
  const coordinator = deps.approvalCoordinator;

  router.get('/pending', (req: Request, res: Response) => {
    if (!coordinator) {
      res.json({ pending: [] });
      return;
    }
    const projectId = req.params['id'];
    if (!projectId) {
      res.status(400).json({ error: 'Missing project id' });
      return;
    }
    res.json({ pending: coordinator.listForProject(projectId) });
  });

  router.post('/resolve', async (req: Request, res: Response) => {
    if (!coordinator) {
      res.status(503).json({ error: 'Approval coordinator not configured' });
      return;
    }

    const body = (req.body || {}) as ApprovalBody;
    const validDecisions = ['allow', 'deny', 'allow_always'];
    if (!body.requestId || !validDecisions.includes(body.decision || '')) {
      res.status(400).json({ error: 'Invalid body: requestId + decision(allow|deny|allow_always)' });
      return;
    }

    let persistedRule: string | null = null;

    if (body.decision === 'allow_always') {
      const pending = coordinator.peek(body.requestId);
      if (!pending) {
        res.status(404).json({ error: 'Unknown or already-resolved approval' });
        return;
      }
      // 1) Session allowlist — same key auto-passes for the rest of this agent session.
      coordinator.rememberAllow(pending.projectId, pending.toolName, pending.input);
      // 2) Persist a Claude Code allow rule to project.permissionOverrides so future sessions skip it too.
      persistedRule = buildAllowRule(pending.toolName, pending.input);
      try {
        await persistProjectAllowRule(deps, pending.projectId, persistedRule);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to persist allow rule (session allowlist still active)', {
          projectId: pending.projectId,
          rule: persistedRule,
          error: msg,
        });
        persistedRule = null;
      }
    }

    const decision: ApprovalDecision =
      body.decision === 'deny'
        ? { behavior: 'deny', message: body.message || 'User denied this action' }
        : { behavior: 'allow' };

    const ok = coordinator.resolve(body.requestId, decision);
    if (!ok) {
      res.status(404).json({ error: 'Unknown or already-resolved approval' });
      return;
    }

    logger.info('Approval resolved by user', {
      requestId: body.requestId,
      decision: body.decision,
      persistedRule,
    });
    res.json({ ok: true, persistedRule });
  });

  router.get('/mode', async (req: Request, res: Response) => {
    const projectId = req.params['id'];
    if (!projectId) {
      res.status(400).json({ error: 'Missing project id' });
      return;
    }
    const project = await deps.projectRepository.findById(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ mode: project.approvalMode ?? 'ask' });
  });

  router.put('/mode', async (req: Request, res: Response) => {
    const projectId = req.params['id'];
    if (!projectId) {
      res.status(400).json({ error: 'Missing project id' });
      return;
    }
    const body = (req.body || {}) as ApprovalModeBody;
    if (body.mode !== 'ask' && body.mode !== 'auto') {
      res.status(400).json({ error: 'mode must be "ask" or "auto"' });
      return;
    }
    const updated = await deps.projectRepository.updateApprovalMode(projectId, body.mode);
    if (!updated) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ mode: updated.approvalMode });
  });

  return router;
}

/**
 * Add an allow rule to the project's permissionOverrides (creating the override block if needed).
 * Idempotent — same rule won't be added twice.
 */
async function persistProjectAllowRule(
  deps: ProjectRouterDependencies,
  projectId: string,
  rule: string,
): Promise<void> {
  const project = await deps.projectRepository.findById(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  const existing = project.permissionOverrides ?? null;
  const allowRules = existing?.allowRules ? [...existing.allowRules] : [];
  if (allowRules.includes(rule)) {
    return;
  }
  allowRules.push(rule);

  await deps.projectRepository.updatePermissionOverrides(projectId, {
    enabled: true,
    allowRules,
    denyRules: existing?.denyRules ?? [],
    defaultMode: existing?.defaultMode,
  });
}
