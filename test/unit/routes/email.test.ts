import express from 'express';
import request from 'supertest';
import { createEmailRouter, EmailRouterDependencies } from '../../../src/routes/email';
import { createErrorHandler } from '../../../src/utils';
import { SettingsRepository } from '../../../src/repositories/settings';

const mockSendEmail = jest.fn().mockResolvedValue(undefined);
const mockTestConnection = jest.fn().mockResolvedValue({ success: true });

jest.mock('../../../src/services/email-service', () => ({
  createEmailService: () => ({
    sendEmail: mockSendEmail,
    testConnection: mockTestConnection,
  }),
}));

const mockCreateZipArchive = jest.fn();
const mockCleanupArchive = jest.fn();
const mockNeedsSplit = jest.fn().mockReturnValue(false);
const mockSplitArchive = jest.fn();

jest.mock('../../../src/services/file-archive-service', () => ({
  createZipArchive: (...args: unknown[]) => mockCreateZipArchive(...args),
  cleanupArchive: (...args: unknown[]) => mockCleanupArchive(...args),
  needsSplit: (...args: unknown[]) => mockNeedsSplit(...args),
  splitArchive: (...args: unknown[]) => mockSplitArchive(...args),
  MAX_ATTACHMENT_SIZE: 25 * 1024 * 1024,
}));

const emailSettings = {
  enabled: true,
  smtpHost: 'smtp.test.com',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: 'user@test.com',
  smtpPassword: 'pass',
  fromAddress: 'from@test.com',
  defaultRecipient: 'default@test.com',
};

function createApp(settingsOverride?: Record<string, unknown>) {
  const mockSettingsRepo: jest.Mocked<SettingsRepository> = {
    get: jest.fn().mockResolvedValue({ email: { ...emailSettings, ...settingsOverride } }),
    update: jest.fn(),
  };

  const deps: EmailRouterDependencies = {
    settingsRepository: mockSettingsRepo,
  };

  const app = express();
  app.use(express.json());
  app.use('/api/email', createEmailRouter(deps));
  app.use(createErrorHandler());
  return { app, mockSettingsRepo };
}

describe('POST /api/email/send', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends a simple email without attachments', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/api/email/send')
      .send({ body: 'Hello world', subject: 'Test', to: 'a@b.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith('a@b.com', 'Test', 'Hello world', undefined);
  });

  it('sends email with ZIP attachment (no split needed)', async () => {
    const { app } = createApp();
    mockCreateZipArchive.mockResolvedValue({
      zipPath: '/tmp/test.zip',
      filename: 'test.zip',
      fileCount: 2,
      totalSize: 1000,
    });
    mockNeedsSplit.mockReturnValue(false);

    const res = await request(app)
      .post('/api/email/send')
      .send({ body: 'Files', subject: 'Attach', to: 'a@b.com', files: ['/a.txt', '/b.txt'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockCreateZipArchive).toHaveBeenCalledWith(['/a.txt', '/b.txt'], undefined);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      'a@b.com', 'Attach', 'Files',
      [{ filename: 'test.zip', path: '/tmp/test.zip' }],
    );
    expect(mockCleanupArchive).toHaveBeenCalledWith('/tmp/test.zip');
  });

  it('splits and sends multiple parts when attachment exceeds limit', async () => {
    const { app } = createApp();
    mockCreateZipArchive.mockResolvedValue({
      zipPath: '/tmp/big.zip',
      filename: 'big.zip',
      fileCount: 1,
      totalSize: 60_000_000,
    });
    mockNeedsSplit.mockReturnValue(true);
    mockSplitArchive.mockResolvedValue({
      parts: ['/tmp/big.zip.001', '/tmp/big.zip.002', '/tmp/big.zip.003'],
      totalParts: 3,
      originalSize: 60_000_000,
    });

    const res = await request(app)
      .post('/api/email/send')
      .send({ body: 'Big file', subject: 'Large', to: 'a@b.com', files: ['/huge.bin'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, parts: 3 });
    expect(mockSplitArchive).toHaveBeenCalledWith('/tmp/big.zip');
    expect(mockSendEmail).toHaveBeenCalledTimes(3);

    expect(mockSendEmail).toHaveBeenNthCalledWith(1,
      'a@b.com', 'Large (파트 1/3)', expect.stringContaining('Big file'),
      [{ filename: 'big.zip.001', path: '/tmp/big.zip.001' }],
    );
    expect(mockSendEmail).toHaveBeenNthCalledWith(2,
      'a@b.com', 'Large (파트 2/3)', expect.stringContaining('Big file'),
      [{ filename: 'big.zip.002', path: '/tmp/big.zip.002' }],
    );
    expect(mockSendEmail).toHaveBeenNthCalledWith(3,
      'a@b.com', 'Large (파트 3/3)', expect.stringContaining('Big file'),
      [{ filename: 'big.zip.003', path: '/tmp/big.zip.003' }],
    );
  });

  it('includes split guide text in body for split emails', async () => {
    const { app } = createApp();
    mockCreateZipArchive.mockResolvedValue({
      zipPath: '/tmp/guide.zip',
      filename: 'guide.zip',
      fileCount: 1,
      totalSize: 50_000_000,
    });
    mockNeedsSplit.mockReturnValue(true);
    mockSplitArchive.mockResolvedValue({
      parts: ['/tmp/guide.zip.001', '/tmp/guide.zip.002'],
      totalParts: 2,
      originalSize: 50_000_000,
    });

    await request(app)
      .post('/api/email/send')
      .send({ body: 'Content', subject: 'S', to: 'a@b.com', files: ['/f'] });

    const sentBody = mockSendEmail.mock.calls[0][2] as string;
    expect(sentBody).toContain('분할 압축 해제 안내');
    expect(sentBody).toContain('2파트');
    expect(sentBody).toContain('7-Zip');
  });

  it('cleans up split part files in finally block', async () => {
    const { app } = createApp();
    mockCreateZipArchive.mockResolvedValue({
      zipPath: '/tmp/clean.zip',
      filename: 'clean.zip',
      fileCount: 1,
      totalSize: 50_000_000,
    });
    mockNeedsSplit.mockReturnValue(true);
    mockSplitArchive.mockResolvedValue({
      parts: ['/tmp/clean.zip.001', '/tmp/clean.zip.002'],
      totalParts: 2,
      originalSize: 50_000_000,
    });

    await request(app)
      .post('/api/email/send')
      .send({ body: 'Ok', subject: 'S', to: 'a@b.com', files: ['/f'] });

    expect(mockCleanupArchive).toHaveBeenCalledWith('/tmp/clean.zip.001');
    expect(mockCleanupArchive).toHaveBeenCalledWith('/tmp/clean.zip.002');
  });

  it('cleans up split parts even when sendEmail fails mid-way', async () => {
    const { app } = createApp();
    mockCreateZipArchive.mockResolvedValue({
      zipPath: '/tmp/fail.zip',
      filename: 'fail.zip',
      fileCount: 1,
      totalSize: 50_000_000,
    });
    mockNeedsSplit.mockReturnValue(true);
    mockSplitArchive.mockResolvedValue({
      parts: ['/tmp/fail.zip.001', '/tmp/fail.zip.002'],
      totalParts: 2,
      originalSize: 50_000_000,
    });
    mockSendEmail
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('SMTP timeout'));

    const res = await request(app)
      .post('/api/email/send')
      .send({ body: 'Ok', subject: 'S', to: 'a@b.com', files: ['/f'] });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('SMTP timeout');
    expect(mockCleanupArchive).toHaveBeenCalledWith('/tmp/fail.zip.001');
    expect(mockCleanupArchive).toHaveBeenCalledWith('/tmp/fail.zip.002');
  });

  it('does not double-delete original zip after split (zipPath set to null)', async () => {
    const { app } = createApp();
    mockCreateZipArchive.mockResolvedValue({
      zipPath: '/tmp/nodbl.zip',
      filename: 'nodbl.zip',
      fileCount: 1,
      totalSize: 50_000_000,
    });
    mockNeedsSplit.mockReturnValue(true);
    mockSplitArchive.mockResolvedValue({
      parts: ['/tmp/nodbl.zip.001'],
      totalParts: 1,
      originalSize: 50_000_000,
    });

    await request(app)
      .post('/api/email/send')
      .send({ body: 'Ok', subject: 'S', to: 'a@b.com', files: ['/f'] });

    const cleanupCalls = mockCleanupArchive.mock.calls.map((c: unknown[]) => c[0]);
    expect(cleanupCalls).not.toContain('/tmp/nodbl.zip');
    expect(cleanupCalls).toContain('/tmp/nodbl.zip.001');
  });

  it('returns 400 when body is missing', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/api/email/send')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when email is not configured', async () => {
    const { app } = createApp({ enabled: false });
    const res = await request(app)
      .post('/api/email/send')
      .send({ body: 'test' });

    expect(res.status).toBe(400);
  });
});
