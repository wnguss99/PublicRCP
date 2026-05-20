import { Router, Request, Response } from 'express';
import { asyncHandler, NotFoundError } from '../../utils';
import { ProjectRouterDependencies, RenameConversationBody } from './types';
import { computeConversationStats } from './helpers';
import { validateBody, validateParams } from '../../middleware/validation';
import { validateProjectExists } from '../../middleware/project';
import {
  renameConversationSchema,
  setCurrentConversationSchema,
  projectAndConversationIdSchema
} from './schemas';

export function createConversationRouter(deps: ProjectRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const {
    projectRepository,
    conversationRepository,
  } = deps;

  // Get conversation (handles both /conversation and /conversations paths)
  router.get('/', validateProjectExists(projectRepository), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'] as string;
    const project = req.project!;
    const path = req.baseUrl.split('/').pop(); // 'conversation' or 'conversations'

    // If path is 'conversations' (plural), list all conversations
    if (path === 'conversations') {
      const limit = req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : undefined;

      const conversations = await conversationRepository.getByProject(id, limit);
      res.json({ conversations });
      return;
    }

    // Otherwise, get a specific conversation (singular)
    const conversationId = req.query['conversationId'] as string | undefined;

    // Determine which conversation to load:
    // 1. If specific conversationId query param provided, use that
    // 2. Otherwise use currentConversationId from project (if agent is running)
    // 3. Otherwise show empty conversation
    const targetConversationId = conversationId || (project).currentConversationId;

    if (!targetConversationId) {
      res.json({ conversation: null, stats: null });
      return;
    }

    const conversation = await conversationRepository.findById(id, targetConversationId);

    if (!conversation) {
      res.json({ conversation: null, stats: null });
      return;
    }

    // Compute stats for the conversation
    const stats = computeConversationStats(conversation.messages, conversation.createdAt);

    res.json({
      ...conversation,
      stats,
      sessionId: conversation.id // Include sessionId for compatibility
    });
  }));

  // Search conversations by content
  router.get('/search', validateProjectExists(projectRepository), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'] as string;
    const query = req.query['q'] as string;

    // Return empty array for short queries
    if (!query || query.length < 2) {
      res.json([]);
      return;
    }

    const results = await conversationRepository.searchMessages(id, query);
    res.json(results);
  }));

  // Clear current conversation (start fresh)
  router.post('/clear', validateProjectExists(projectRepository), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'] as string;

    // Clear the current conversation ID
    await projectRepository.setCurrentConversation(id, null);
    res.json({ success: true });
  }));

  // Set current conversation (for resuming from history)
  router.put('/current', validateBody(setCurrentConversationSchema), validateProjectExists(projectRepository), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'] as string;
    const body = req.body as { conversationId?: string };
    const { conversationId } = body;

    // Verify conversation exists and belongs to this project
    const conversation = await conversationRepository.findById(id, conversationId!);

    if (!conversation) {
      throw new NotFoundError('Conversation');
    }

    await projectRepository.setCurrentConversation(id, conversationId!);

    // Extract sessionId from conversation metadata if available
    const sessionId = conversation.metadata?.sessionId;
    res.json({ success: true, conversationId, sessionId });
  }));

  // Rename a conversation
  router.put('/:conversationId', validateParams(projectAndConversationIdSchema), validateBody(renameConversationSchema), validateProjectExists(projectRepository), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'] as string;
    const conversationId = req.params['conversationId'] as string;
    const body = req.body as RenameConversationBody;
    const { label } = body;

    // Verify conversation exists and belongs to this project
    const conversation = await conversationRepository.findById(id, conversationId);

    if (!conversation) {
      throw new NotFoundError('Conversation');
    }

    await conversationRepository.renameConversation(id, conversationId, label!.trim());
    res.json({ success: true });
  }));

  // Delete a conversation
  router.delete('/:conversationId', validateParams(projectAndConversationIdSchema), validateProjectExists(projectRepository), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id'] as string;
    const conversationId = req.params['conversationId'] as string;
    const project = req.project!;

    const conversation = await conversationRepository.findById(id, conversationId);

    if (!conversation) {
      throw new NotFoundError('Conversation');
    }

    // If the deleted conversation is the active one, clear the pointer.
    if (project.currentConversationId === conversationId) {
      await projectRepository.setCurrentConversation(id, null);
    }

    await conversationRepository.deleteConversation(id, conversationId);
    res.json({ success: true });
  }));

  return router;
}