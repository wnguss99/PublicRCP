import express from 'express';
import request from 'supertest';
import { createEmailMcpRouter, EMAIL_MCP_TOOL_NAMES } from '../../../src/services/email-mcp-server';
import { GlobalSettings, SettingsRepository, SettingsUpdate } from '../../../src/repositories/settings';

/**
 * Users configure email by asking for it in conversation ("보내는 주소를 …로 바꿔줘"),
 * which reaches these MCP tools. Settings live in the instance's own settings.json,
 * so one port's user can never reach another port's configuration.
 */
function createSettingsRepository(initial: Partial<GlobalSettings['email']> = {}): SettingsRepository & {
  current: GlobalSettings['email'];
} {
  const state = {
    current: {
      enabled: false,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpPassword: '',
      fromAddress: '',
      defaultRecipient: '',
      ...initial,
    },
  };

  return {
    // Accessor, because update() swaps the object rather than mutating it.
    get current() {
      return state.current;
    },
    get: jest.fn().mockImplementation(() => Promise.resolve({ email: state.current } as GlobalSettings)),
    update: jest.fn().mockImplementation((updates: SettingsUpdate) => {
      // Mirrors FileSettingsRepository: a *new* email object replaces the old one,
      // so a reference captured before the update keeps the previous values.
      state.current = { ...state.current, ...(updates.email ?? {}) };
      return Promise.resolve({ email: state.current } as GlobalSettings);
    }),
  } as unknown as SettingsRepository & { current: GlobalSettings['email'] };
}

function createApp(settingsRepository: SettingsRepository): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/mcp/email', createEmailMcpRouter({
    settingsRepository,
    projectRepository: { findById: jest.fn().mockResolvedValue(null) } as never,
    resolveProjectId: (req) => req.params['projectId'] || null,
  }));
  return app;
}

async function callTool(
  app: express.Express,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app)
    .post('/mcp/email/proj')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  return (res.body as { result: { content: { text: string }[] } }).result.content[0]!.text;
}

describe('email MCP settings tools', () => {
  it('advertises every tool it serves', async () => {
    const app = createApp(createSettingsRepository());

    const res = await request(app)
      .post('/mcp/email/proj')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const names = (res.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toEqual(['send_email', 'get_email_settings', 'update_email_settings']);
  });

  it('allow-lists exactly the tools it serves', () => {
    // A tool that is served but missing from --allowedTools is silently unusable.
    expect(EMAIL_MCP_TOOL_NAMES).toEqual([
      'mcp__claudito-email__send_email',
      'mcp__claudito-email__get_email_settings',
      'mcp__claudito-email__update_email_settings',
    ]);
  });

  it('never returns the stored password', async () => {
    const app = createApp(createSettingsRepository({ smtpPassword: 'super-secret' }));

    const text = await callTool(app, 'get_email_settings');

    expect(text).not.toContain('super-secret');
    expect(text).toContain('smtpPassword: (stored)');
  });

  it('sets sender and recipient addresses', async () => {
    const repo = createSettingsRepository();
    const app = createApp(repo);

    await callTool(app, 'update_email_settings', {
      fromAddress: 'me@naver.com',
      defaultRecipient: 'me@naver.com',
    });

    expect(repo.current.fromAddress).toBe('me@naver.com');
    expect(repo.current.defaultRecipient).toBe('me@naver.com');
  });

  it('leaves untouched fields alone', async () => {
    const repo = createSettingsRepository({ smtpHost: 'smtp.naver.com', smtpUser: 'keep-me' });
    const app = createApp(repo);

    await callTool(app, 'update_email_settings', { fromAddress: 'me@naver.com' });

    expect(repo.current.smtpHost).toBe('smtp.naver.com');
    expect(repo.current.smtpUser).toBe('keep-me');
  });

  it('rejects an address that is not an email', async () => {
    const repo = createSettingsRepository();
    const app = createApp(repo);

    const text = await callTool(app, 'update_email_settings', { fromAddress: 'not-an-email' });

    expect(text).toContain('not a valid email address');
    expect(repo.current.fromAddress).toBe('');
  });

  it('rejects an out-of-range port', async () => {
    const repo = createSettingsRepository();
    const app = createApp(repo);

    const text = await callTool(app, 'update_email_settings', { smtpPort: 99999 });

    expect(text).toContain('smtpPort must be between 1 and 65535');
    expect(repo.current.smtpPort).toBe(587);
  });

  it('derives smtpSecure from the port', async () => {
    const repo = createSettingsRepository();
    const app = createApp(repo);

    await callTool(app, 'update_email_settings', { smtpPort: 465 });
    expect(repo.current.smtpSecure).toBe(true);

    await callTool(app, 'update_email_settings', { smtpPort: 587 });
    expect(repo.current.smtpSecure).toBe(false);
  });

  it('does not enable email while the configuration is incomplete', async () => {
    const repo = createSettingsRepository();
    const app = createApp(repo);

    const text = await callTool(app, 'update_email_settings', { fromAddress: 'me@naver.com' });

    expect(repo.current.enabled).toBe(false);
    expect(text).toContain('still off');
  });

  it('refuses to force-enable an incomplete configuration', async () => {
    const repo = createSettingsRepository();
    const app = createApp(repo);

    const text = await callTool(app, 'update_email_settings', { enabled: true });

    expect(text).toContain('Cannot enable email');
    expect(repo.current.enabled).toBe(false);
  });

  it('enables automatically once the configuration is complete', async () => {
    // This is what makes the mail icon appear — requiring a separate "and enable
    // it" instruction would just be friction.
    const repo = createSettingsRepository({
      smtpHost: 'smtp.naver.com',
      smtpUser: 'me',
      smtpPassword: 'pw',
    });
    const app = createApp(repo);

    const text = await callTool(app, 'update_email_settings', { fromAddress: 'me@naver.com' });

    expect(repo.current.enabled).toBe(true);
    expect(text).toContain('refresh');
  });

  it('can be switched off explicitly', async () => {
    const repo = createSettingsRepository({
      enabled: true,
      smtpHost: 'smtp.naver.com',
      smtpUser: 'me',
      smtpPassword: 'pw',
      fromAddress: 'me@naver.com',
    });
    const app = createApp(repo);

    await callTool(app, 'update_email_settings', { enabled: false });

    expect(repo.current.enabled).toBe(false);
  });

  it('says so when there is nothing to change', async () => {
    const repo = createSettingsRepository();
    const app = createApp(repo);

    const text = await callTool(app, 'update_email_settings', {});

    expect(text).toContain('Nothing to change');
    expect(repo.update).not.toHaveBeenCalled();
  });
});
