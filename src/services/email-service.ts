import nodemailer from 'nodemailer';
import { EmailSettings } from '../repositories/settings';

export interface EmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  testConnection(): Promise<{ success: boolean; error?: string }>;
}

function markdownToHtml(markdown: string): string {
  return markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

export class DefaultEmailService implements EmailService {
  private settings: EmailSettings;

  constructor(settings: EmailSettings) {
    this.settings = settings;
  }

  private createTransport() {
    return nodemailer.createTransport({
      host: this.settings.smtpHost,
      port: this.settings.smtpPort,
      secure: this.settings.smtpSecure,
      auth: {
        user: this.settings.smtpUser,
        pass: this.settings.smtpPassword,
      },
    });
  }

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    const transport = this.createTransport();
    await transport.sendMail({
      from: this.settings.fromAddress,
      to,
      subject,
      html: markdownToHtml(body),
      text: body,
    });
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const transport = this.createTransport();
      await transport.verify();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function createEmailService(settings: EmailSettings): EmailService {
  return new DefaultEmailService(settings);
}
