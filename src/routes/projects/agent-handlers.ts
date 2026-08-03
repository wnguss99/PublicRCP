import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { AppError, ValidationError, ConflictError, getLogger } from '../../utils';
import { AgentManager } from '../../agents';
import { AgentMessageBody } from './types';

export function handleStartAutonomousLoop(agentManager: AgentManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    const project = req.project!;

    if (agentManager.isRunning(id)) {
      throw new ConflictError('Agent is already running');
    }

    const roadmapPath = path.join(project.path, 'doc', 'ROADMAP.md');

    try {
      await fs.promises.access(roadmapPath);
    } catch {
      throw new ValidationError('Roadmap not found. A ROADMAP.md file is required to start the agent.');
    }

    await agentManager.startAutonomousLoop(id);
    res.json({ success: true, status: agentManager.isQueued(id) ? 'queued' : 'running' });
  };
}

export function handleStopAgent(agentManager: AgentManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;

    await agentManager.stopAgent(id);
    res.json({ success: true, status: 'stopped' });
  };
}

export function handleGetStatus(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const id = req.params['id'] as string;

    // Self-heal sweep. The frontend polls this every 10s, so a plan the CLI
    // already decided is retired even if nobody tries to send a message — a
    // stale lock can never outlive the run it belongs to.
    agentManager.reconcilePendingPlan(id);

    const fullStatus = agentManager.getFullStatus(id);
    res.json(fullStatus);
  };
}

export function handleGetContext(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const id = req.params['id'] as string;
    const project = req.project!;

    let contextUsage = agentManager.getContextUsage(id);

    if (!contextUsage && (project).lastContextUsage) {
      contextUsage = (project).lastContextUsage;
    }

    res.json({ contextUsage });
  };
}

export function handleGetQueue(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const id = req.params['id'] as string;

    const messages = agentManager.getQueuedMessages(id);
    res.json({ messages });
  };
}

export function handleGetLoop(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const id = req.params['id'] as string;

    const loopState = agentManager.getLoopState(id);

    if (!loopState) {
      res.json({ isLooping: false, progress: null });
      return;
    }

    res.json(loopState);
  };
}

export function handleRemoveFromQueue(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const id = req.params['id'] as string;

    if (!agentManager.isQueued(id)) {
      throw new ValidationError('Agent is not queued');
    }

    agentManager.removeFromQueue(id);
    res.json({ success: true });
  };
}

export function handleRemoveQueuedMessage(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const id = req.params['id'] as string;
    const index = req.params['index'] as unknown as number;

    if (!agentManager.isRunning(id)) {
      throw new ValidationError('Agent is not running');
    }

    const removed = agentManager.removeQueuedMessage(id, index);

    if (!removed) {
      throw new ValidationError('Failed to remove message from queue');
    }

    res.json({ success: true, remainingMessages: agentManager.getQueuedMessages(id) });
  };
}

export function handleStartInteractive(agentManager: AgentManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] as string;
    const body = req.body as AgentMessageBody;
    const { message, images, sessionId, permissionMode } = body;

    if (agentManager.isRunning(id)) {
      const currentMode = agentManager.getAgentMode(id);

      if (currentMode === 'autonomous') {
        throw new ConflictError('An autonomous agent is already running. Stop it first.');
      }

      // The mirror image of AGENT_NOT_RUNNING: the client thought the agent was
      // stopped and tried to start it, but one is already up. Coded so the browser
      // can just deliver the message to the running agent instead of losing it.
      throw new AppError('An agent is already running', 409, 'AGENT_ALREADY_RUNNING');
    }

    const result = await agentManager.startInteractiveAgent(id, {
      initialMessage: message,
      images,
      sessionId,
      permissionMode,
      // A user typed this. Starting an agent with a message is the same kind of
      // turn as sending one to a running agent, so it belongs in the history —
      // without this the stored conversation began with Claude's reply to a
      // question that was nowhere in it.
      persistInitialMessage: true,
    });

    const status = agentManager.isQueued(id) ? 'queued' : 'running';
    const actualSessionId = agentManager.getSessionId(id);

    res.json({
      success: true,
      status,
      mode: 'interactive',
      sessionId: actualSessionId,
      containerRestarted: result.containerRestarted,
      containerImageName: result.containerImageName,
      dockerFallback: result.dockerFallback,
      dockerFallbackReason: result.dockerFallbackReason,
    });
  };
}

export function handleOneOffStop(agentManager: AgentManager) {
  return async (req: Request, res: Response): Promise<void> => {
    await agentManager.stopOneOffAgent(req.params['oneOffId'] as string);
    res.json({ success: true });
  };
}

export function handleOneOffSend(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const oneOffId = req.params['oneOffId'] as string;
    const { message, images } = req.body as AgentMessageBody;

    if (!message && (!images || images.length === 0)) {
      throw new ValidationError('Message is required');
    }

    agentManager.sendOneOffInput(oneOffId, message || '', images);
    res.json({ success: true });
  };
}

export function handleOneOffStatus(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const oneOffId = req.params['oneOffId'] as string;
    const status = agentManager.getOneOffStatus(oneOffId);

    if (!status) {
      res.status(404).json({ error: 'One-off agent not found' });
      return;
    }

    res.json(status);
  };
}

export function handleOneOffContext(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const oneOffId = req.params['oneOffId'] as string;
    const contextUsage = agentManager.getOneOffContextUsage(oneOffId);
    res.json({ contextUsage });
  };
}

export function handleListOneOffAgents(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const id = req.params['id'] as string;
    res.json({ agents: agentManager.getActiveOneOffAgents(id) });
  };
}

export function handleAnswer(agentManager: AgentManager) {
  return (req: Request, res: Response): void => {
    const id = req.params['id'] as string;
    const { toolUseId, answers } = req.body as { toolUseId?: string; answers?: Record<string, string | string[]> };

    if (!toolUseId) {
      throw new ValidationError('toolUseId is required');
    }

    if (!answers || typeof answers !== 'object') {
      throw new ValidationError('answers is required');
    }

    if (!agentManager.isRunning(id)) {
      throw new ValidationError('Agent is not running');
    }

    const content = JSON.stringify({ answers });
    agentManager.sendToolResult(id, toolUseId, content);

    res.json({ success: true });
  };
}

export function handleSend(agentManager: AgentManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const logger = getLogger('agent-send');
    const id = req.params['id'] as string;
    const body = req.body as AgentMessageBody;
    const { message, images, planFeedback } = body;

    logger.info('Received send request', {
      projectId: id,
      messageLength: message?.length ?? 0,
      hasImages: !!images && images.length > 0,
    });

    if (planFeedback && agentManager.hasPendingPlan(id)) {
      logger.info('Processing plan approval response', { projectId: id });
      await agentManager.approvePlan(id, message || '');
      res.json({ success: true });
      return;
    }

    // Tagged with a code so the client can act on the *fact* instead of parsing
    // this sentence: the browser answers AGENT_NOT_RUNNING by starting the agent
    // with the same message. The UI's idea of whether an agent is alive is a
    // cached belief, and every incident in this file came from that belief being
    // out of date — so disagreeing with the server must be self-healing, not a
    // dead end the user has to notice and retry by hand.
    if (!agentManager.isRunning(id)) {
      logger.warn('Agent not running', { projectId: id });
      throw new AppError('Agent is not running', 400, 'AGENT_NOT_RUNNING');
    }

    const mode = agentManager.getAgentMode(id);

    if (mode !== 'interactive') {
      logger.warn('Agent not in interactive mode', { projectId: id, mode });
      throw new AppError(
        'An autonomous agent is running for this project. Stop it to chat.',
        400,
        'AGENT_NOT_INTERACTIVE'
      );
    }

    // A pending plan never rejects a message.
    //
    // This used to throw 400 PLAN_APPROVAL_PENDING whenever reconcilePendingPlan()
    // said the plan was live — but "live" is inferred, and one of its signals is
    // simply that the agent is idle, which is also true of an agent that has
    // already moved on. When that inference was wrong the user could not send
    // anything at all: every message came back 400 telling them to use controls
    // that were spent or had never rendered.
    //
    // The rejection was redundant as well as harmful. sendInput() already routes
    // a message into handlePlanApprovalResponse() when a plan is genuinely
    // pending: 'yes' approves, 'no' rejects, and anything else is delivered as
    // plan feedback — exactly what typing a reply should mean. So reconcile to
    // retire stale state, then hand the message over and let it be consumed.
    const planState = agentManager.reconcilePendingPlan(id);

    if (planState !== 'none') {
      logger.info('Sending with plan state present; sendInput will consume it', {
        projectId: id,
        planState,
      });
    }

    logger.info('Sending input to agent', { projectId: id });
    agentManager.sendInput(id, message || '', images);

    res.json({ success: true });
  };
}
