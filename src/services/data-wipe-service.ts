import fs from 'fs';
import { ProjectRepository } from '../repositories';
import { getLogger, getInstanceTempDirPath, pruneStaleInstanceTempDirs } from '../utils';

export interface WipeSummary {
  projectsWiped: number;
  globalDataDeleted: boolean;
  mcpTempDeleted: boolean;
  archiveTempDeleted: boolean;
}

export interface DataWipeService {
  wipeAll(): Promise<WipeSummary>;
}

interface DataWipeServiceDependencies {
  projectRepository: ProjectRepository;
  dataDirectory: string;
}

export class DefaultDataWipeService implements DataWipeService {
  private readonly projectRepository: ProjectRepository;
  private readonly dataDirectory: string;
  private readonly logger = getLogger('data-wipe');

  constructor(deps: DataWipeServiceDependencies) {
    this.projectRepository = deps.projectRepository;
    this.dataDirectory = deps.dataDirectory;
  }

  async wipeAll(): Promise<WipeSummary> {
    // Project data lives inside the data directory now ({CLAUDITO_HOME}/projects/{id}),
    // so wiping the data directory takes the projects with it. Count them before
    // the delete so the summary reports what actually went away instead of 0.
    const projectsWiped = await this.countProjects();
    const mcpTempDeleted = this.wipeMcpTempData();
    const archiveTempDeleted = this.wipeArchiveTempData();
    const globalDataDeleted = this.wipeGlobalData();

    try {
      pruneStaleInstanceTempDirs();
    } catch (error) {
      this.logger.warn('Failed to prune stale instance temp dirs', { error: String(error) });
    }

    return { projectsWiped, globalDataDeleted, mcpTempDeleted, archiveTempDeleted };
  }

  private async countProjects(): Promise<number> {
    try {
      const projects = await this.projectRepository.findAll();
      return projects.length;
    } catch {
      this.logger.warn('Failed to read project index, reporting 0 projects wiped');
      return 0;
    }
  }

  /**
   * Scratch data is per instance now, so a wipe removes this instance's folder and
   * anything left by processes that are gone — but never a *live* sibling
   * instance's folder. Pruning matters because scoping the wipe to the current PID
   * alone left every previous run's directory behind for good.
   */
  private wipeMcpTempData(): boolean {
    return this.deleteDirectoryRecursive(getInstanceTempDirPath('claudito-mcp'));
  }

  private wipeArchiveTempData(): boolean {
    return this.deleteDirectoryRecursive(getInstanceTempDirPath('claudito-archives'));
  }

  private wipeGlobalData(): boolean {
    return this.deleteDirectoryRecursive(this.dataDirectory);
  }

  private deleteDirectoryRecursive(dirPath: string): boolean {
    try {
      if (!fs.existsSync(dirPath)) {
        return false;
      }

      fs.rmSync(dirPath, { recursive: true, force: true });
      this.logger.info('Deleted directory', { path: dirPath });
      return true;
    } catch (error) {
      this.logger.warn('Failed to delete directory', {
        path: dirPath,
        error: String(error),
      });
      return false;
    }
  }
}
