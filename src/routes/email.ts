import { Router, Request, Response } from 'express';
import { SettingsRepository, ProjectRepository } from '../repositories';
import { createEmailService, EmailAttachment } from '../services/email-service';
import { createZipArchive, cleanupArchive, needsSplit, splitArchive } from '../services/file-archive-service';
import { asyncHandler, ValidationError } from '../utils';
import * as path from 'path';

interface SendEmailBody {
  subject?: string;
  body: string;
  to?: string;
  projectId?: string;
  files?: string[];
  archiveName?: string;
}

export interface EmailRouterDependencies {
  settingsRepository: SettingsRepository;
  projectRepository?: ProjectRepository;
}

export function createEmailRouter(deps: EmailRouterDependencies): Router {
  const router = Router();
  const { settingsRepository, projectRepository } = deps;

  router.post('/send', asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const body = req.body as SendEmailBody;

    if (!body.body || typeof body.body !== 'string' || !body.body.trim()) {
      throw new ValidationError('body is required');
    }

    const settings = await settingsRepository.get();
    const emailSettings = settings.email;

    if (!emailSettings?.enabled) {
      res.status(400).json({ error: 'Email not configured' });
      return;
    }

    if (!emailSettings.smtpHost || !emailSettings.smtpUser || !emailSettings.smtpPassword) {
      res.status(400).json({ error: 'Email not configured' });
      return;
    }

    const to = body.to?.trim() || emailSettings.defaultRecipient;

    if (!to) {
      throw new ValidationError('No recipient specified and no default recipient configured');
    }

    let subject = body.subject?.trim();

    if (!subject) {
      if (body.projectId && projectRepository) {
        try {
          const project = await projectRepository.findById(body.projectId);
          subject = project ? `Claudito - ${project.name}` : 'Claudito';
        } catch {
          subject = 'Claudito';
        }
      } else {
        subject = 'Claudito';
      }
    }

    const emailService = createEmailService(emailSettings);
    const attachments: EmailAttachment[] = [];
    let zipPath: string | null = null;
    let splitPartPaths: string[] = [];

    try {
      if (body.files && body.files.length > 0) {
        const archive = await createZipArchive(body.files, body.archiveName);
        zipPath = archive.zipPath;
        attachments.push({ filename: archive.filename, path: archive.zipPath });
      }

      const attachmentPath = attachments[0]?.path;

      if (attachmentPath && needsSplit(attachmentPath)) {
        const splitResult = await splitArchive(attachmentPath);
        zipPath = null;
        splitPartPaths = splitResult.parts;

        const splitGuide = [
          '',
          '## 분할 압축 해제 안내',
          `총 ${splitResult.totalParts}파트로 분할 발송되었습니다.`,
          '',
          `1. 모든 메일의 첨부파일(${splitResult.parts.map(p => path.basename(p)).join(', ')})을 **같은 폴더**에 저장`,
          '2. **.001 파일**을 우클릭 → 7-Zip으로 압축 해제',
          '3. 나머지 파트는 자동으로 인식되어 한 번에 해제됩니다',
        ].join('\n');

        for (let i = 0; i < splitResult.parts.length; i++) {
          const partPath = splitResult.parts[i]!;
          const partSubject = `${subject} (파트 ${i + 1}/${splitResult.totalParts})`;
          const partBody = `${body.body}\n${splitGuide}`;
          await emailService.sendEmail(to, partSubject, partBody, [
            { filename: path.basename(partPath), path: partPath },
          ]);
        }

        res.json({ success: true, parts: splitResult.totalParts });
      } else {
        await emailService.sendEmail(to, subject, body.body, attachments.length > 0 ? attachments : undefined);
        res.json({ success: true });
      }
    } catch (error) {
      res.status(500).json({ error: 'Failed to send email: ' + (error instanceof Error ? error.message : String(error)) });
    } finally {
      if (zipPath) cleanupArchive(zipPath);
      for (const p of splitPartPaths) cleanupArchive(p);
    }
  }));

  router.post('/test', asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const settings = await settingsRepository.get();
    const emailSettings = settings.email;

    if (!emailSettings?.smtpHost || !emailSettings.smtpUser || !emailSettings.smtpPassword) {
      res.status(400).json({ error: 'Email not configured' });
      return;
    }

    const emailService = createEmailService(emailSettings);
    const result = await emailService.testConnection();
    res.json(result);
  }));

  return router;
}
