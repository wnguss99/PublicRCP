/**
 * A start that never claims the port must not touch anything the instance owns.
 *
 * On 2026-08-10 every chat message came back "Claude agent exited with code 1"
 * within three seconds, with no stderr — because the CLI was not failing, it was
 * being killed. A duplicate instance that could never serve (a healthy sibling
 * already held the port) ran its startup cleanup *before* listen(): it read the
 * live sibling's pids.json, decided the running Claude agents were leftovers from
 * a previous run, and killed them. Then it hit EADDRINUSE and exited. pm2 restarted
 * it four seconds later and it did it again — 2,100 times.
 *
 * The same race explains the earlier "Invalid MCP configuration: MCP config file
 * not found" failures: pruneStaleInstanceTempDirs() ran from the doomed duplicate
 * and deleted config files out from under a live agent between write and spawn.
 *
 * Binding the port is the only proof of ownership, so every destructive step now
 * runs from inside the listen() callback. These tests pin that ordering.
 */
import { EventEmitter } from 'events';

const listenMock = jest.fn();
const serverEmitter = new EventEmitter() as EventEmitter & {
  listen: jest.Mock;
  close: jest.Mock;
};
serverEmitter.listen = listenMock;
serverEmitter.close = jest.fn();

// Keep the real modules — express reads http.IncomingMessage.prototype at import
// time — and replace only the factory this server calls.
jest.mock('http', () => ({
  ...jest.requireActual('http'),
  createServer: jest.fn(() => serverEmitter),
}));
jest.mock('https', () => ({
  ...jest.requireActual('https'),
  createServer: jest.fn(() => serverEmitter),
}));

const cleanupOrphanProcesses = jest.fn().mockResolvedValue({
  foundCount: 0,
  killedCount: 0,
  killedPids: [],
  failedPids: [],
  skippedPids: [],
});
const reconcilePersistedStatuses = jest.fn().mockResolvedValue(0);

jest.mock('../../../src/routes', () => ({
  createApiRouter: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  getAgentManager: jest.fn(() => ({
    cleanupOrphanProcesses,
    reconcilePersistedStatuses,
    // The WebSocket layer subscribes to the manager during initializeWebSocket().
    on: jest.fn(),
    off: jest.fn(),
    getFullStatus: jest.fn(() => ({ status: 'stopped' })),
  })),
  getRoadmapGenerator: jest.fn(() => null),
  getShellService: jest.fn(() => null),
  getRalphLoopService: jest.fn(() => null),
  getConversationRepository: jest.fn(() => null),
  getProjectRepository: jest.fn(() => null),
  getRunProcessManager: jest.fn(() => null),
  getApprovalCoordinator: jest.fn(() => null),
  setWebSocketServer: jest.fn(),
}));

const pruneStaleInstanceTempDirs = jest.fn();
const pruneAbandonedTempFiles = jest.fn();

jest.mock('../../../src/utils', () => {
  const actual = jest.requireActual('../../../src/utils');
  return {
    ...actual,
    pruneStaleInstanceTempDirs,
    pruneAbandonedTempFiles,
    getDataDirectory: jest.fn(() => 'C:/tmp/data'),
    formatAccessibleUrls: jest.fn(() => []),
  };
});

const destructiveSteps = () => [
  ...cleanupOrphanProcesses.mock.calls,
  ...reconcilePersistedStatuses.mock.calls,
  ...pruneStaleInstanceTempDirs.mock.calls,
  ...pruneAbandonedTempFiles.mock.calls,
];

describe('server startup ordering', () => {
  let ExpressHttpServer: typeof import('../../../src/server').ExpressHttpServer;

  beforeEach(async () => {
    jest.clearAllMocks();
    serverEmitter.removeAllListeners();
    ({ ExpressHttpServer } = await import('../../../src/server'));
  });

  const build = () =>
    new ExpressHttpServer({
      config: { port: 4000, host: '0.0.0.0' },
    } as unknown as ConstructorParameters<typeof ExpressHttpServer>[0]);

  it('does not clean up anything when the port is already taken', async () => {
    listenMock.mockImplementation(() => {
      const err = Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
      setImmediate(() => serverEmitter.emit('error', err));
    });

    const server = build();
    await expect(server.start()).rejects.toThrow('already in use');

    // The whole point: a doomed start is not allowed to kill a live sibling's
    // agents or delete its MCP config files.
    expect(cleanupOrphanProcesses).not.toHaveBeenCalled();
    expect(reconcilePersistedStatuses).not.toHaveBeenCalled();
    expect(pruneStaleInstanceTempDirs).not.toHaveBeenCalled();
    expect(pruneAbandonedTempFiles).not.toHaveBeenCalled();
    expect(destructiveSteps()).toHaveLength(0);
  });

  it('cleans up only after the port is bound', async () => {
    let boundCallback: (() => void) | null = null;
    listenMock.mockImplementation((_port: number, _host: string, cb: () => void) => {
      boundCallback = cb;
    });

    const server = build();
    const starting = server.start();

    // Before the listen callback fires, nothing destructive has run.
    expect(destructiveSteps()).toHaveLength(0);

    boundCallback!();
    await starting;

    expect(cleanupOrphanProcesses).toHaveBeenCalledTimes(1);
    expect(reconcilePersistedStatuses).toHaveBeenCalledTimes(1);
    expect(pruneStaleInstanceTempDirs).toHaveBeenCalledTimes(1);
    expect(pruneAbandonedTempFiles).toHaveBeenCalledTimes(1);
  });

  it('still resolves when the post-bind cleanup fails', async () => {
    cleanupOrphanProcesses.mockRejectedValueOnce(new Error('boom'));

    let boundCallback: (() => void) | null = null;
    listenMock.mockImplementation((_port: number, _host: string, cb: () => void) => {
      boundCallback = cb;
    });

    const server = build();
    const starting = server.start();
    boundCallback!();

    // Housekeeping must never stop a server that is already serving.
    await expect(starting).resolves.toBeUndefined();
  });
});
