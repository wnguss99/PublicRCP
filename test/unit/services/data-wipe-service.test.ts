import fs from 'fs';
import path from 'path';
import os from 'os';
import { DefaultDataWipeService } from '../../../src/services/data-wipe-service';
import { createMockProjectRepository } from '../helpers/mock-factories';

jest.mock('fs');
jest.mock('os');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

describe('DefaultDataWipeService', () => {
  let service: DefaultDataWipeService;
  const dataDirectory = '/home/user/.claudito';

  beforeEach(() => {
    jest.resetAllMocks();
    mockOs.tmpdir.mockReturnValue('/tmp');
    mockFs.existsSync.mockReturnValue(true);
    mockFs.rmSync.mockImplementation(() => undefined);

    const mockProjectRepository = createMockProjectRepository([]);

    service = new DefaultDataWipeService({
      projectRepository: mockProjectRepository,
      dataDirectory,
    });
  });

  it('should delete the global data directory', async () => {
    const summary = await service.wipeAll();

    expect(mockFs.rmSync).toHaveBeenCalledWith(
      dataDirectory,
      { recursive: true, force: true },
    );
    expect(summary.globalDataDeleted).toBe(true);
  });

  it('should delete the PID-scoped MCP temp directory', async () => {
    const summary = await service.wipeAll();

    expect(mockFs.rmSync).toHaveBeenCalledWith(
      path.join('/tmp', 'claudito-mcp', String(process.pid)),
      { recursive: true, force: true },
    );
    expect(summary.mcpTempDeleted).toBe(true);
  });

  it('should delete the PID-scoped archive temp directory', async () => {
    const summary = await service.wipeAll();

    expect(mockFs.rmSync).toHaveBeenCalledWith(
      path.join('/tmp', 'claudito-archives', String(process.pid)),
      { recursive: true, force: true },
    );
    expect(summary.archiveTempDeleted).toBe(true);
  });

  it('should report 0 projects wiped when there are none', async () => {
    const summary = await service.wipeAll();
    expect(summary.projectsWiped).toBe(0);
  });

  it('should report how many projects the wipe took with it', async () => {
    // Project data lives inside the data directory now, so deleting it removes
    // the projects too. The summary used to be hardcoded to 0 and always lied.
    const withProjects = new DefaultDataWipeService({
      projectRepository: createMockProjectRepository([
        { id: 'a', name: 'A', path: '/p/a' },
        { id: 'b', name: 'B', path: '/p/b' },
      ] as never),
      dataDirectory,
    });

    const summary = await withProjects.wipeAll();

    expect(summary.projectsWiped).toBe(2);
  });

  it('should still wipe when the project index cannot be read', async () => {
    const failing = new DefaultDataWipeService({
      projectRepository: {
        ...createMockProjectRepository([]),
        findAll: jest.fn().mockRejectedValue(new Error('index unreadable')),
      } as never,
      dataDirectory,
    });

    const summary = await failing.wipeAll();

    expect(summary.projectsWiped).toBe(0);
    expect(summary.globalDataDeleted).toBe(true);
  });

  it('should handle missing directories gracefully', async () => {
    mockFs.existsSync.mockReturnValue(false);

    const summary = await service.wipeAll();

    expect(summary.projectsWiped).toBe(0);
    expect(summary.globalDataDeleted).toBe(false);
    expect(summary.mcpTempDeleted).toBe(false);
    expect(summary.archiveTempDeleted).toBe(false);
    expect(mockFs.rmSync).not.toHaveBeenCalled();
  });

  it('should handle rmSync errors without throwing', async () => {
    mockFs.rmSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const summary = await service.wipeAll();

    expect(summary.projectsWiped).toBe(0);
    expect(summary.globalDataDeleted).toBe(false);
    expect(summary.mcpTempDeleted).toBe(false);
    expect(summary.archiveTempDeleted).toBe(false);
  });
});
