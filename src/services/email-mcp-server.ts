import { Router, Request, Response } from 'express';
import { SettingsRepository, ProjectRepository } from '../repositories';
import { createEmailService, EmailAttachment } from './email-service';
import { createZipArchive, cleanupArchive, needsSplit, splitArchive } from './file-archive-service';
import { getLogger } from '../utils/logger';
import * as path from 'path';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'claudito-email';
const TOOL_NAME = 'send_email';
export const EMAIL_TOOL_NAME = `mcp__${SERVER_NAME}__${TOOL_NAME}`;

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

export interface EmailMcpServerDependencies {
  settingsRepository: SettingsRepository;
  projectRepository: ProjectRepository;
  resolveProjectId: (req: Request) => string | null;
}

export function createEmailMcpRouter(deps: EmailMcpServerDependencies): Router {
  const router = Router();
  const logger = getLogger('email-mcp');

  router.post('/:projectId', async (req: Request, res: Response) => {
    const projectId = deps.resolveProjectId(req);
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
      const response = await dispatch(body, projectId, deps, logger);
      if (response === null) {
        res.status(204).end();
        return;
      }
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Email MCP dispatch failed', { method: body.method, error: message });
      res.json(rpcError(body.id ?? null, -32603, message));
    }
  });

  return router;
}

async function dispatch(
  request: JsonRpcRequest,
  projectId: string,
  deps: EmailMcpServerDependencies,
  logger: ReturnType<typeof getLogger>,
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
          description: [
            'Send an email with optional file attachments.',
            'When files are provided, they are automatically compressed into a ZIP archive and attached.',
            'Use this tool when the user asks to email their work, send files, or share results via email.',
          ].join(' '),
          inputSchema: {
            type: 'object',
            properties: {
              subject: {
                type: 'string',
                description: 'Email subject line',
              },
              body: {
                type: 'string',
                description: 'Email body in markdown format',
              },
              to: {
                type: 'string',
                description: 'Recipient email address. If omitted, uses the default recipient from settings.',
              },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute file paths to attach. Multiple files are compressed into a single ZIP.',
              },
              archiveName: {
                type: 'string',
                description: 'Custom name for the ZIP archive (without .zip extension). Defaults to project name.',
              },
            },
            required: ['body'],
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
    const bodyText = String(args.body || '');
    const subject = args.subject ? String(args.subject) : undefined;
    const to = args.to ? String(args.to) : undefined;
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    const archiveName = args.archiveName ? String(args.archiveName) : undefined;

    if (!bodyText.trim()) {
      return rpcResult(id, toolResponse('Error: email body is required'));
    }

    try {
      const result = await handleSendEmail({
        projectId, bodyText, subject, to, files, archiveName, deps, logger,
      });
      return rpcResult(id, toolResponse(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcResult(id, toolResponse(`Error: ${message}`));
    }
  }

  return rpcError(id, -32601, `Method not found: ${request.method}`);
}

async function handleSendEmail(opts: {
  projectId: string;
  bodyText: string;
  subject?: string;
  to?: string;
  files: string[];
  archiveName?: string;
  deps: EmailMcpServerDependencies;
  logger: ReturnType<typeof getLogger>;
}): Promise<string> {
  const { projectId, bodyText, subject, to, files, archiveName, deps, logger } = opts;

  const settings = await deps.settingsRepository.get();
  const emailSettings = settings.email;

  if (!emailSettings?.enabled) {
    throw new Error('Email is not configured. Please configure SMTP settings first.');
  }

  if (!emailSettings.smtpHost || !emailSettings.smtpUser || !emailSettings.smtpPassword) {
    throw new Error('Email SMTP settings are incomplete.');
  }

  const recipient = to?.trim() || emailSettings.defaultRecipient;
  if (!recipient) {
    throw new Error('No recipient specified and no default recipient configured.');
  }

  let emailSubject = subject?.trim();
  if (!emailSubject) {
    try {
      const project = await deps.projectRepository.findById(projectId);
      emailSubject = project ? `Claudito - ${project.name}` : 'Claudito';
    } catch {
      emailSubject = 'Claudito';
    }
  }

  const attachments: EmailAttachment[] = [];
  let zipPath: string | null = null;
  const ARCHIVE_EXTS = new Set(['.7z', '.zip', '.tar', '.gz', '.tgz', '.tar.gz', '.rar']);

  const isSingleArchive = files.length === 1
    && ARCHIVE_EXTS.has(path.extname(files[0]!).toLowerCase());

  if (files.length > 0) {
    if (isSingleArchive) {
      const filePath = files[0]!;
      attachments.push({ filename: path.basename(filePath), path: filePath });
      logger.info('Attaching archive file directly', { projectId, file: path.basename(filePath) });
    } else {
      try {
        let zipName = archiveName;
        if (!zipName) {
          try {
            const project = await deps.projectRepository.findById(projectId);
            zipName = project ? project.name.replace(/[^a-zA-Z0-9가-힣_-]/g, '_') : 'files';
          } catch {
            zipName = 'files';
          }
        }

        const archive = await createZipArchive(files, zipName);
        zipPath = archive.zipPath;
        attachments.push({ filename: archive.filename, path: archive.zipPath });

        logger.info('Created ZIP archive for email', {
          projectId,
          fileCount: archive.fileCount,
          totalSize: archive.totalSize,
          archiveName: archive.filename,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Failed to create ZIP archive', { error: message });
        throw new Error(`Failed to compress files: ${message}`);
      }
    }
  }

  const emailService = createEmailService(emailSettings);
  const attachmentPath = attachments[0]?.path;
  const shouldSplit = attachmentPath && needsSplit(attachmentPath);

  if (shouldSplit) {
    const splitResult = splitArchive(attachmentPath);
    const archiveBaseName = path.basename(attachmentPath);
    const splitGuide = [
      '',
      '## 분할 압축 해제 안내',
      `총 ${splitResult.totalParts}파트로 분할 발송되었습니다.`,
      '',
      `1. 모든 메일의 첨부파일(${splitResult.parts.map(p => path.basename(p)).join(', ')})을 **같은 폴더**에 저장`,
      '2. **.001 파일**을 우클릭 → 7-Zip으로 압축 해제',
      '3. 나머지 파트는 자동으로 인식되어 한 번에 해제됩니다',
    ].join('\n');

    try {
      for (let i = 0; i < splitResult.parts.length; i++) {
        const partPath = splitResult.parts[i]!;
        const partSubject = `${emailSubject} (파트 ${i + 1}/${splitResult.totalParts})`;
        const partBody = `${bodyText}\n${splitGuide}`;
        await emailService.sendEmail(recipient, partSubject, partBody, [
          { filename: path.basename(partPath), path: partPath },
        ]);
      }

      return `Email sent successfully to ${recipient} — ${splitResult.totalParts} parts (${archiveBaseName}, ${(splitResult.originalSize / 1024 / 1024).toFixed(1)} MB total)`;
    } finally {
      for (const p of splitResult.parts) cleanupArchive(p);
    }
  }

  try {
    await emailService.sendEmail(recipient, emailSubject, bodyText, attachments.length > 0 ? attachments : undefined);

    const fileNames = files.map(f => path.basename(f));
    const resultParts = [`Email sent successfully to ${recipient}`];
    if (files.length > 0) {
      const method = isSingleArchive ? 'as attachment' : 'as ZIP';
      resultParts.push(`with ${files.length} file(s) attached ${method}: ${fileNames.join(', ')}`);
    }

    return resultParts.join(' ');
  } finally {
    if (zipPath) {
      cleanupArchive(zipPath);
    }
  }
}

function toolResponse(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
