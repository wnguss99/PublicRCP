import { Router, Request, Response } from 'express';
import { SettingsRepository, ProjectRepository } from '../repositories';
import { createEmailService, EmailAttachment } from './email-service';
import { createZipArchive, cleanupArchive, needsSplit, splitArchive } from './file-archive-service';
import { getLogger } from '../utils/logger';
import { getInstanceTempDir } from '../utils/temp-dirs';
import * as path from 'path';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'claudito-email';
const TOOL_NAME = 'send_email';
const GET_SETTINGS_TOOL = 'get_email_settings';
const UPDATE_SETTINGS_TOOL = 'update_email_settings';

export const EMAIL_TOOL_NAME = `mcp__${SERVER_NAME}__${TOOL_NAME}`;

/**
 * Every tool this server exposes, in the `mcp__server__tool` form the CLI expects
 * in --allowedTools. Kept here so adding a tool cannot silently leave it blocked.
 */
export const EMAIL_MCP_TOOL_NAMES = [TOOL_NAME, GET_SETTINGS_TOOL, UPDATE_SETTINGS_TOOL]
  .map((tool) => `mcp__${SERVER_NAME}__${tool}`);

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
        {
          name: GET_SETTINGS_TOOL,
          description: [
            'Read this instance\'s email configuration (sender address, default recipient, SMTP server).',
            'The password is never returned — only whether one is stored.',
            'Use before changing settings so you can tell the user what is currently configured.',
          ].join(' '),
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: UPDATE_SETTINGS_TOOL,
          description: [
            'Change this instance\'s email configuration when the user asks to set their sending or receiving address.',
            'Only the fields you pass are changed; everything else is left as-is.',
            'Email becomes enabled automatically once SMTP host, user, password and sender address are all present.',
            'Settings belong to this port only and never affect the other users.',
          ].join(' '),
          inputSchema: {
            type: 'object',
            properties: {
              fromAddress: {
                type: 'string',
                description: 'Sender address that outgoing mail comes from (보내는 메일 주소).',
              },
              defaultRecipient: {
                type: 'string',
                description: 'Address used as the recipient when send_email is called without "to" (받는 메일 주소).',
              },
              smtpHost: { type: 'string', description: 'SMTP server hostname, e.g. smtp.naver.com or smtp.gmail.com.' },
              smtpPort: { type: 'number', description: 'SMTP port. 587 for STARTTLS, 465 for TLS.' },
              smtpSecure: { type: 'boolean', description: 'true for port 465 (TLS), false for 587 (STARTTLS).' },
              smtpUser: { type: 'string', description: 'SMTP login id.' },
              smtpPassword: {
                type: 'string',
                description: 'SMTP password or app password. Only send when the user supplies one.',
              },
              enabled: {
                type: 'boolean',
                description: 'Turn the email feature on or off explicitly. Usually omit — it is derived from completeness.',
              },
            },
            required: [],
          },
        },
      ],
    });
  }

  if (request.method === 'tools/call') {
    const params = (request.params || {}) as { name?: string; arguments?: Record<string, unknown> };

    if (params.name === GET_SETTINGS_TOOL) {
      return rpcResult(id, toolResponse(await describeEmailSettings(deps)));
    }

    if (params.name === UPDATE_SETTINGS_TOOL) {
      try {
        return rpcResult(id, toolResponse(await handleUpdateSettings(params.arguments || {}, deps, logger)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return rpcResult(id, toolResponse(`Error: ${message}`));
      }
    }

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

/** Deliberately permissive — real validation is the SMTP server rejecting it. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readAddress(args: Record<string, unknown>, key: string): string | undefined {
  if (args[key] === undefined) {
    return undefined;
  }

  const value = String(args[key]).trim();

  if (value !== '' && !EMAIL_PATTERN.test(value)) {
    throw new Error(`${key} is not a valid email address: ${value}`);
  }

  return value;
}

async function describeEmailSettings(deps: EmailMcpServerDependencies): Promise<string> {
  const { email } = await deps.settingsRepository.get();

  return [
    `enabled: ${email.enabled}`,
    `fromAddress (보내는 주소): ${email.fromAddress || '(not set)'}`,
    `defaultRecipient (받는 주소): ${email.defaultRecipient || '(not set)'}`,
    `smtpHost: ${email.smtpHost || '(not set)'}`,
    `smtpPort: ${email.smtpPort}`,
    `smtpSecure: ${email.smtpSecure}`,
    `smtpUser: ${email.smtpUser || '(not set)'}`,
    `smtpPassword: ${email.smtpPassword ? '(stored)' : '(not set)'}`,
  ].join('\n');
}

/**
 * Apply a partial email settings change requested in conversation.
 *
 * Settings live in this instance's own settings.json, so a user on one port can
 * never reach another port's configuration. The feature is switched on as soon as
 * the configuration is complete — that is what makes the mail icon appear, and
 * asking the user to also say "and enable it" would be pointless friction.
 */
async function handleUpdateSettings(
  args: Record<string, unknown>,
  deps: EmailMcpServerDependencies,
  logger: ReturnType<typeof getLogger>,
): Promise<string> {
  const current = (await deps.settingsRepository.get()).email;
  const patch: Partial<typeof current> = {};

  const fromAddress = readAddress(args, 'fromAddress');
  const defaultRecipient = readAddress(args, 'defaultRecipient');

  if (fromAddress !== undefined) {
    patch.fromAddress = fromAddress;
  }

  if (defaultRecipient !== undefined) {
    patch.defaultRecipient = defaultRecipient;
  }

  if (args.smtpHost !== undefined) {
    patch.smtpHost = String(args.smtpHost).trim();
  }

  if (args.smtpUser !== undefined) {
    patch.smtpUser = String(args.smtpUser).trim();
  }

  if (args.smtpPassword !== undefined) {
    patch.smtpPassword = String(args.smtpPassword);
  }

  if (args.smtpPort !== undefined) {
    const port = Number(args.smtpPort);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`smtpPort must be between 1 and 65535, got: ${String(args.smtpPort)}`);
    }

    patch.smtpPort = port;
    // 465 is implicit TLS, 587 is STARTTLS. Getting this pair wrong is the most
    // common reason sending fails, so keep them consistent unless told otherwise.
    if (args.smtpSecure === undefined) {
      patch.smtpSecure = port === 465;
    }
  }

  if (args.smtpSecure !== undefined) {
    patch.smtpSecure = args.smtpSecure === true || String(args.smtpSecure) === 'true';
  }

  if (Object.keys(patch).length === 0 && args.enabled === undefined) {
    return 'Nothing to change. Tell me which address or SMTP field to set.';
  }

  const merged = { ...current, ...patch };
  const missing = (['smtpHost', 'smtpUser', 'smtpPassword', 'fromAddress'] as const)
    .filter((key) => String(merged[key] ?? '').trim() === '');

  if (args.enabled !== undefined) {
    const wanted = args.enabled === true || String(args.enabled) === 'true';

    if (wanted && missing.length > 0) {
      throw new Error(`Cannot enable email — still missing: ${missing.join(', ')}`);
    }

    patch.enabled = wanted;
  } else if (missing.length === 0) {
    patch.enabled = true;
  }

  await deps.settingsRepository.update({ email: patch });

  const changed = Object.keys(patch).filter((key) => key !== 'smtpPassword');
  logger.info('Email settings updated via MCP', { fields: changed, passwordChanged: patch.smtpPassword !== undefined });

  const lines = [`Updated: ${changed.join(', ') || '(password only)'}`];

  if (missing.length > 0) {
    lines.push(`Email is still off — missing: ${missing.join(', ')}.`);
  } else if (patch.enabled === true && current.enabled !== true) {
    lines.push('Email is now enabled. Ask the user to refresh the page so the mail icon appears.');
  }

  lines.push(await describeEmailSettings(deps));

  return lines.join('\n\n');
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
  let skippedFiles: string[] = [];
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
        skippedFiles = archive.skipped;
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
    // `zipPath` is set only when we built the archive ourselves. When the user
    // attached their own file we must not delete it, and the parts belong in our
    // temp folder rather than scattered through their project directory.
    const weOwnTheArchive = zipPath !== null;
    const splitResult = await splitArchive(attachmentPath, undefined, {
      deleteSource: weOwnTheArchive,
      outputDir: weOwnTheArchive ? undefined : getInstanceTempDir('claudito-archives'),
    });
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

    const attachedNames = files.filter((f) => !skippedFiles.includes(f)).map((f) => path.basename(f));
    const resultParts = [`Email sent successfully to ${recipient}`];

    if (attachedNames.length > 0) {
      const method = isSingleArchive ? 'as attachment' : 'as ZIP';
      resultParts.push(`with ${attachedNames.length} file(s) attached ${method}: ${attachedNames.join(', ')}`);
    }

    // Unreadable paths used to vanish without a word — the user believed every
    // file they named had been sent.
    if (skippedFiles.length > 0) {
      resultParts.push(`WARNING: these paths could not be read and were NOT sent: ${skippedFiles.join(', ')}`);
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
