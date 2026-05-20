import { Router, Request, Response } from 'express';
import { ApprovalCoordinator } from './approval-coordinator';
import { getLogger, Logger } from '../../utils/logger';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'claudito-approve';
const TOOL_NAME = 'approve';
export const FULL_TOOL_NAME = `mcp__${SERVER_NAME}__${TOOL_NAME}`;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface PermissionMcpServerOptions {
  coordinator: ApprovalCoordinator;
  /** Resolves the projectId for a given request (e.g. from URL param). */
  resolveProjectId: (req: Request) => string | null;
}

export function createPermissionMcpRouter(options: PermissionMcpServerOptions): Router {
  const router = Router();
  const logger = getLogger('permission-mcp');

  router.post('/:projectId', async (req: Request, res: Response) => {
    const projectId = options.resolveProjectId(req);
    if (!projectId) {
      res.status(404).json(rpcError(null, -32001, 'Unknown project'));
      return;
    }

    const body = req.body as JsonRpcRequest | undefined;
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      res.status(400).json(rpcError(null, -32600, 'Invalid JSON-RPC request'));
      return;
    }

    try {
      const response = await dispatch(body, projectId, options.coordinator, logger);
      if (response === null) {
        res.status(204).end();
        return;
      }
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('MCP dispatch failed', { method: body.method, error: message });
      res.json(rpcError(body.id ?? null, -32603, message));
    }
  });

  return router;
}

async function dispatch(
  request: JsonRpcRequest,
  projectId: string,
  coordinator: ApprovalCoordinator,
  logger: Logger,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;

  if (request.method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: '1.0.0' },
    });
  }

  if (request.method === 'notifications/initialized' || request.method.startsWith('notifications/')) {
    return null;
  }

  if (request.method === 'tools/list') {
    return rpcResult(id, {
      tools: [
        {
          name: TOOL_NAME,
          description:
            'Permission prompt handler for Claudito. Called by Claude Code before any tool not pre-approved.',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
            },
            required: ['tool_name', 'input'],
          },
        },
      ],
    });
  }

  if (request.method === 'tools/call') {
    const params = (request.params || {}) as { name?: string; arguments?: Record<string, unknown> };
    if (params.name !== TOOL_NAME) {
      return rpcError(id, -32602, `Unknown tool: ${params.name}`);
    }

    const args = params.arguments || {};
    const toolName = String(args.tool_name || '');
    const input = (args.input as Record<string, unknown>) || {};

    if (!toolName) {
      return rpcResult(id, wrapDecision({ behavior: 'deny', message: 'Missing tool_name' }));
    }

    logger.info('Permission prompt received', { projectId, toolName });
    const decision = await coordinator.request(projectId, toolName, input);
    return rpcResult(id, wrapDecision(decision));
  }

  return rpcError(id, -32601, `Method not found: ${request.method}`);
}

function wrapDecision(decision: {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}): unknown {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(decision),
      },
    ],
  };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
