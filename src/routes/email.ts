import { Router, Request, Response } from 'express';
import { SettingsRepository, ProjectRepository } from '../repositories';
import { createEmailService, EmailAttachment } from '../services/email-service';
import { createZipArchive, cleanupArchive } from '../services/file-archive-service';
import { asyncHandler, ValidationError } from '../utils';

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

    try {
      if (body.files && body.files.length > 0) {
        const archive = await createZipArchive(body.files, body.archiveName);
        zipPath = archive.zipPath;
        attachments.push({ filename: archive.filename, path: archive.zipPath });
      }

      await emailService.sendEmail(to, subject, body.body, attachments.length > 0 ? attachments : undefined);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to send email: ' + (error instanceof Error ? error.message : String(error)) });
    } finally {
      if (zipPath) cleanupArchive(zipPath);
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
