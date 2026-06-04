import nodemailer from 'nodemailer';
import { EmailSettings } from '../repositories/settings';

export interface EmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  testConnection(): Promise<{ success: boolean; error?: string }>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToHtml(markdown: string): string {
  const blocks: string[] = [];

  // Extract fenced code blocks first to protect from other transforms
  const protected_ = markdown.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = blocks.length;
    const langLabel = lang ? `<span style="color:#9ca3af;font-size:0.75em">${escapeHtml(lang)}</span><br>` : '';
    blocks.push(
      `<pre style="background:#1e293b;color:#e2e8f0;padding:12px 16px;border-radius:6px;overflow-x:auto;font-family:monospace;font-size:0.875em;margin:8px 0">${langLabel}${escapeHtml(code.replace(/\n$/, ''))}</pre>`
    );
    return `\x00BLOCK${idx}\x00`;
  });

  const lines: string[] = protected_.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line: string = lines[i] ?? '';

    // Restore code block placeholders
    if (/^\x00BLOCK\d+\x00$/.test(line.trim())) {
      const idx = parseInt(line.trim().replace(/\x00BLOCK(\d+)\x00/, '$1'));
      out.push(blocks[idx] ?? '');
      i++;
      continue;
    }

    // Headings
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h3) { out.push(`<h3 style="margin:12px 0 4px;font-size:1em;color:#93c5fd">${inlineFormat(h3[1] ?? '')}</h3>`); i++; continue; }
    if (h2) { out.push(`<h2 style="margin:16px 0 4px;font-size:1.1em;color:#93c5fd">${inlineFormat(h2[1] ?? '')}</h2>`); i++; continue; }
    if (h1) { out.push(`<h1 style="margin:16px 0 6px;font-size:1.25em;color:#93c5fd">${inlineFormat(h1[1] ?? '')}</h1>`); i++; continue; }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { out.push('<hr style="border:none;border-top:1px solid #374151;margin:12px 0">'); i++; continue; }

    // Unordered list
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i] ?? '')) {
        items.push(`<li style="margin:2px 0">${inlineFormat((lines[i] ?? '').replace(/^[-*] /, ''))}</li>`);
        i++;
      }
      out.push(`<ul style="margin:6px 0;padding-left:20px">${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i] ?? '')) {
        items.push(`<li style="margin:2px 0">${inlineFormat((lines[i] ?? '').replace(/^\d+\. /, ''))}</li>`);
        i++;
      }
      out.push(`<ol style="margin:6px 0;padding-left:20px">${items.join('')}</ol>`);
      continue;
    }

    // Blockquote
    if (/^> /.test(line)) {
      const text = line.replace(/^> /, '');
      out.push(`<blockquote style="border-left:3px solid #4b5563;margin:6px 0;padding:4px 12px;color:#9ca3af">${inlineFormat(text)}</blockquote>`);
      i++;
      continue;
    }

    // Empty line → paragraph break
    if (line.trim() === '') { out.push('<br>'); i++; continue; }

    out.push(`<p style="margin:4px 0">${inlineFormat(line)}</p>`);
    i++;
  }

  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#e2e8f0;background:#111827;padding:20px;border-radius:8px">${out.join('')}</div>`;
}

function inlineFormat(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#1e293b;padding:1px 5px;border-radius:3px;font-family:monospace;font-size:0.9em">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#60a5fa">$1</a>');
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
