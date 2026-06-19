import nodemailer from 'nodemailer';
import { EmailSettings } from '../repositories/settings';

export interface EmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  testConnection(): Promise<{ success: boolean; error?: string }>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseListBlock(lines: string[], start: number): { html: string; end: number } {
  const stack: { tag: 'ul' | 'ol'; indent: number }[] = [];
  const out: string[] = [];
  let i = start;

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const listMatch = raw.match(/^(\s*)([-*]|\d+\.)\s(.*)/);
    if (!listMatch) break;

    const indent = listMatch[1]!.length;
    const marker = listMatch[2]!;
    const content = listMatch[3] ?? '';
    const tag: 'ul' | 'ol' = /^\d+\./.test(marker) ? 'ol' : 'ul';

    while (stack.length > 0 && stack[stack.length - 1]!.indent > indent) {
      const popped = stack.pop()!;
      out.push(`</${popped.tag}>`);
    }

    if (stack.length === 0 || indent > stack[stack.length - 1]!.indent) {
      stack.push({ tag, indent });
      const listStyle = tag === 'ul'
        ? 'margin:6px 0;padding-left:20px'
        : 'margin:6px 0;padding-left:20px';
      out.push(`<${tag} style="${listStyle}">`);
    } else if (stack[stack.length - 1]!.tag !== tag) {
      const popped = stack.pop()!;
      out.push(`</${popped.tag}>`);
      stack.push({ tag, indent });
      out.push(`<${tag} style="margin:6px 0;padding-left:20px">`);
    }

    const checkboxMatch = content.match(/^\[([ xX])\]\s*(.*)/);
    if (checkboxMatch) {
      const checked = checkboxMatch[1] !== ' ';
      const text = checkboxMatch[2] ?? '';
      const checkbox = checked
        ? '<span style="color:#16a34a;font-family:monospace">&#9745;</span>'
        : '<span style="color:#9ca3af;font-family:monospace">&#9744;</span>';
      out.push(`<li style="margin:2px 0;list-style:none">${checkbox} ${inlineFormat(text)}</li>`);
    } else {
      out.push(`<li style="margin:2px 0">${inlineFormat(content)}</li>`);
    }

    i++;
  }

  while (stack.length > 0) {
    out.push(`</${stack.pop()!.tag}>`);
  }

  return { html: out.join(''), end: i };
}

function parseCells(row: string): string[] {
  const stripped = row.replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let j = 0; j < stripped.length; j++) {
    if (stripped[j] === '\\' && j + 1 < stripped.length && stripped[j + 1] === '|') {
      current += '|';
      j++;
    } else if (stripped[j] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += stripped[j];
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTable(lines: string[], start: number): { html: string; end: number } | null {
  const headerLine = lines[start] ?? '';
  const separatorLine = lines[start + 1] ?? '';

  if (!headerLine.includes('|') || !separatorLine.includes('|')) return null;

  const headers = parseCells(headerLine);
  const separators = parseCells(separatorLine);

  if (headers.length !== separators.length) return null;
  if (!separators.every(s => /^:?-{3,}:?$/.test(s))) return null;

  const aligns = separators.map(s => {
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });

  const cellStyle = 'padding:6px 12px;border:1px solid #d1d5db';
  const headerCellStyle = `${cellStyle};background:#f0f4f8;color:#1e3a5f;font-weight:600`;

  let html = '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:8px 0;width:100%;font-size:0.9em">';
  html += '<thead><tr>';
  headers.forEach((h, idx) => {
    const align = aligns[idx] ?? 'left';
    html += `<th align="${align}" bgcolor="#f0f4f8" style="${headerCellStyle};text-align:${align}">${inlineFormat(h)}</th>`;
  });
  html += '</tr></thead><tbody>';

  let i = start + 2;
  let rowIdx = 0;
  while (i < lines.length && (lines[i] ?? '').includes('|')) {
    const cells = parseCells(lines[i] ?? '');
    const rowBg = rowIdx % 2 === 0 ? '' : 'background:#f9fafb;';
    const rowBgAttr = rowIdx % 2 === 0 ? '' : ' bgcolor="#f9fafb"';
    html += `<tr${rowBgAttr}>`;
    headers.forEach((_h, idx) => {
      const align = aligns[idx] ?? 'left';
      const cell = cells[idx] ?? '';
      html += `<td align="${align}" style="${cellStyle};${rowBg}text-align:${align}">${inlineFormat(cell)}</td>`;
    });
    html += '</tr>';
    i++;
    rowIdx++;
  }

  html += '</tbody></table>';
  return { html, end: i };
}

const BLOCK_MARKER_START = '​​%%CBLOCK_';
const BLOCK_MARKER_END = '%%​​';
const BLOCK_PATTERN = /​​%%CBLOCK_(\d+)%%​​/;

function markdownToHtml(markdown: string): string {
  const blocks: string[] = [];
  const normalized = markdown.replace(/\r\n?/g, '\n');

  const protected_ = normalized.replace(/^```(\w*)[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/gm, (_m, lang, code) => {
    const idx = blocks.length;
    const langLabel = lang ? `<span style="color:#6b7280;font-size:0.75em">${escapeHtml(lang)}</span><br>` : '';
    blocks.push(
      `<pre bgcolor="#f5f5f5" style="background:#f5f5f5;color:#1a1a1a;padding:12px 16px;border-radius:6px;overflow-x:auto;font-family:monospace;font-size:0.875em;margin:8px 0">${langLabel}${escapeHtml(code.replace(/\n$/, ''))}</pre>`
    );
    return `${BLOCK_MARKER_START}${idx}${BLOCK_MARKER_END}`;
  });

  const lines: string[] = protected_.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line: string = lines[i] ?? '';

    const blockMatch = line.trim().match(BLOCK_PATTERN);
    if (blockMatch) {
      const idx = parseInt(blockMatch[1]!);
      out.push(blocks[idx] ?? '');
      i++;
      continue;
    }

    // Headings
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h3) { out.push(`<h3 style="margin:12px 0 4px;font-size:1em;color:#1e3a5f">${inlineFormat(h3[1] ?? '')}</h3>`); i++; continue; }
    if (h2) { out.push(`<h2 style="margin:16px 0 4px;font-size:1.1em;color:#1e3a5f">${inlineFormat(h2[1] ?? '')}</h2>`); i++; continue; }
    if (h1) { out.push(`<h1 style="margin:16px 0 6px;font-size:1.25em;color:#1e3a5f">${inlineFormat(h1[1] ?? '')}</h1>`); i++; continue; }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { out.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0">'); i++; continue; }

    // Table
    if (line.includes('|') && i + 1 < lines.length) {
      const table = parseTable(lines, i);
      if (table) { out.push(table.html); i = table.end; continue; }
    }

    // Lists (unordered, ordered, checkbox — with nesting)
    if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const list = parseListBlock(lines, i);
      out.push(list.html);
      i = list.end;
      continue;
    }

    // Blockquote (multi-line)
    if (/^> /.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^> /.test(lines[i] ?? '')) {
        quoteLines.push((lines[i] ?? '').replace(/^> /, ''));
        i++;
      }
      const quoteContent = quoteLines.map(l => inlineFormat(l)).join('<br>');
      out.push(`<table cellpadding="0" cellspacing="0" border="0" style="margin:6px 0"><tr><td bgcolor="#d1d5db" width="3" style="width:3px;background:#d1d5db"></td><td style="padding:4px 12px;color:#4b5563">${quoteContent}</td></tr></table>`);
      continue;
    }

    // Empty line
    if (line.trim() === '') { out.push('<br>'); i++; continue; }

    out.push(`<p style="margin:4px 0">${inlineFormat(line)}</p>`);
    i++;
  }

  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#ffffff"><tr><td style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;background:#ffffff;padding:20px;border-radius:8px">${out.join('')}</td></tr></table>`;
}

function inlineFormat(text: string): string {
  const urlPattern = '[^()]*(?:\\([^()]*\\))*[^()]*';
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del style="text-decoration:line-through;color:#6b7280">$1</del>')
    .replace(/`([^`]+)`/g, '<code style="background:#f0f0f0;padding:1px 5px;border-radius:3px;font-family:monospace;font-size:0.9em">$1</code>')
    .replace(new RegExp(`!\\[([^\\]]*)\\]\\((${urlPattern})\\)`, 'g'), '<img src="$2" alt="$1" style="max-width:100%;height:auto;border-radius:6px;margin:4px 0">')
    .replace(new RegExp(`\\[([^\\]]+)\\]\\((${urlPattern})\\)`, 'g'), '<a href="$2" style="color:#2563eb">$1</a>');
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
