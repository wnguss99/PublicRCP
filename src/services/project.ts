import fs from 'fs';
import path from 'path';
import { Project, ProjectRepository, CreateProjectData } from '../repositories/project';

export interface FileSystemOperations {
  exists(filePath: string): Promise<boolean>;
  mkdir(dirPath: string): Promise<void>;
  writeFile(filePath: string, content: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
}

const defaultFileSystemOps: FileSystemOperations = {
  exists: async (filePath) => {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  mkdir: async (dirPath) => {
    await fs.promises.mkdir(dirPath, { recursive: true });
  },
  writeFile: (filePath, content) => fs.promises.writeFile(filePath, content, 'utf-8'),
  readFile: (filePath) => fs.promises.readFile(filePath, 'utf-8'),
};

export interface ProjectServiceDependencies {
  projectRepository: ProjectRepository;
  fileSystem?: FileSystemOperations;
}

export interface CreateProjectOptions {
  name?: string;
  path: string;
  createNew: boolean;
}

export interface CreateProjectResult {
  success: boolean;
  project?: Project;
  error?: string;
}

export interface ProjectService {
  createProject(options: CreateProjectOptions): Promise<CreateProjectResult>;
  updateProjectPath(id: string, newName: string, newPath: string): Promise<Project | null>;
  hasRoadmap(projectPath: string): Promise<boolean>;
  getRoadmapContent(projectPath: string): Promise<string | null>;
}

export class DefaultProjectService implements ProjectService {
  private readonly projectRepository: ProjectRepository;
  private readonly fileSystem: FileSystemOperations;

  constructor(deps: ProjectServiceDependencies) {
    this.projectRepository = deps.projectRepository;
    this.fileSystem = deps.fileSystem || defaultFileSystemOps;
  }

  async createProject(options: CreateProjectOptions): Promise<CreateProjectResult> {
    const { path: projectPath, createNew } = options;
    const projectName = options.name || path.basename(projectPath);

    const folderExists = await this.fileSystem.exists(projectPath);

    if (createNew) {
      if (folderExists) {
        return { success: false, error: 'Folder already exists' };
      }
      await this.createProjectFolder(projectPath);
    } else {
      if (!folderExists) {
        return { success: false, error: 'Folder does not exist' };
      }
    }

    const data: CreateProjectData = { name: projectName, path: projectPath };
    const project = await this.projectRepository.create(data);

    return { success: true, project };
  }

  async updateProjectPath(
    id: string,
    newName: string,
    newPath: string,
  ): Promise<Project | null> {
    return this.projectRepository.updateProjectPath(id, newName, newPath);
  }

  async hasRoadmap(projectPath: string): Promise<boolean> {
    const roadmapPath = this.getRoadmapPath(projectPath);
    return this.fileSystem.exists(roadmapPath);
  }

  async getRoadmapContent(projectPath: string): Promise<string | null> {
    const roadmapPath = this.getRoadmapPath(projectPath);

    try {
      return await this.fileSystem.readFile(roadmapPath);
    } catch {
      return null;
    }
  }

  private async createProjectFolder(projectPath: string): Promise<void> {
    await this.fileSystem.mkdir(projectPath);
  }

  private getRoadmapPath(projectPath: string): string {
    return path.join(projectPath, 'doc', 'ROADMAP.md');
  }
}
