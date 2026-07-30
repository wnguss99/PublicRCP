import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getLogger } from '../utils';

export interface MilestoneItemRef {
  phaseId: string;
  milestoneId: string;
  itemIndex: number;
  taskTitle: string;
}

export interface ContextUsageData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  maxContextTokens: number;
  percentUsed: number;
}

export interface ProjectPermissionOverrides {
  enabled: boolean;
  allowRules?: string[];
  denyRules?: string[];
  defaultMode?: 'acceptEdits' | 'plan';
}

export interface McpOverrides {
  enabled: boolean;
  serverOverrides: {
    [serverId: string]: {
      enabled: boolean;
    };
  };
}

export type SlackNotificationEvent =
  | 'agent_completed'
  | 'agent_failed'
  | 'agent_waiting'
  | 'ralph_loop_complete'
  | 'ralph_loop_error'
  | 'milestone_completed'
  | 'milestone_failed';

export interface SlackNotificationConfig {
  channelId: string;
  events: SlackNotificationEvent[];
  mentionUsers: string[];
  threadReplies: boolean;
}

export interface ProjectStatus {
  id: string;
  name: string;
  path: string;
  status: 'stopped' | 'running' | 'error' | 'queued';
  currentConversationId: string | null;
  nextItem: MilestoneItemRef | null;
  currentItem: MilestoneItemRef | null;
  lastContextUsage: ContextUsageData | null;
  permissionOverrides: ProjectPermissionOverrides | null;
  /** Project-specific model override (null = use global default) */
  modelOverride: string | null;
  /** Project-specific MCP server overrides */
  mcpOverrides: McpOverrides | null;
  /** Run configurations for this project */
  runConfigurations?: RunConfiguration[];
  /** Per-project Docker override: true=force Docker, false=force host, undefined=use global */
  dockerOverride?: boolean;
  /** Per-project Docker image override (null/undefined = use global baseImage) */
  dockerImage?: string | null;
  /** Per-project Slack notification configuration */
  slackNotification?: SlackNotificationConfig | null;
  /** Slack channel linked to this project for feed updates */
  slackLinkedChannelId?: string | null;
  /** Agent profile ID override (null = use default profile) */
  agentProfileId?: string | null;
  /** Inline approval mode: 'ask' surfaces tool requests in the UI, 'auto' uses static rules only.
   *  Default (unset) is 'ask' for interactive agents; Ralph Loop / one-off agents keep 'auto'. */
  approvalMode?: 'ask' | 'auto';
  createdAt: string;
  updatedAt: string;
}

export interface RunConfiguration {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  shell: string | null;
  autoRestart: boolean;
  autoRestartDelay: number;
  autoRestartMaxRetries: number;
  preLaunchConfigId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectIndexEntry {
  id: string;
  name: string;
}

export interface CreateProjectData {
  name: string;
  path: string;
}

export interface ProjectRepository {
  findAll(): Promise<ProjectStatus[]>;
  findById(id: string): Promise<ProjectStatus | null>;
  findByPath(projectPath: string): Promise<ProjectStatus | null>;
  create(data: CreateProjectData): Promise<ProjectStatus>;
  updateStatus(id: string, status: ProjectStatus['status']): Promise<ProjectStatus | null>;
  updateNextItem(id: string, nextItem: MilestoneItemRef | null): Promise<ProjectStatus | null>;
  updateCurrentItem(id: string, currentItem: MilestoneItemRef | null): Promise<ProjectStatus | null>;
  setCurrentConversation(id: string, conversationId: string | null): Promise<ProjectStatus | null>;
  updateContextUsage(id: string, contextUsage: ContextUsageData | null): Promise<ProjectStatus | null>;
  updatePermissionOverrides(id: string, overrides: ProjectPermissionOverrides | null): Promise<ProjectStatus | null>;
  updateModelOverride(id: string, model: string | null): Promise<ProjectStatus | null>;
  updateMcpOverrides(id: string, overrides: McpOverrides | null): Promise<ProjectStatus | null>;
  updateRunConfigurations(id: string, configs: RunConfiguration[]): Promise<ProjectStatus | null>;
  updateDockerOverride(id: string, dockerOverride: boolean | undefined): Promise<ProjectStatus | null>;
  updateDockerImage(id: string, dockerImage: string | null): Promise<ProjectStatus | null>;
  updateSlackNotification(id: string, config: SlackNotificationConfig | null): Promise<ProjectStatus | null>;
  updateSlackLinkedChannel(id: string, channelId: string | null): Promise<ProjectStatus | null>;
  updateAgentProfileId(id: string, profileId: string | null): Promise<ProjectStatus | null>;
  updateApprovalMode(id: string, mode: 'ask' | 'auto'): Promise<ProjectStatus | null>;
  updateProjectPath(id: string, newName: string, newPath: string): Promise<ProjectStatus | null>;
  delete(id: string): Promise<boolean>;
}

export interface FileSystem {
  readFileSync(filePath: string, encoding: BufferEncoding): string;
  writeFileSync(filePath: string, data: string): void;
  existsSync(filePath: string): boolean;
  mkdirSync(dirPath: string, options: { recursive: boolean }): void;
  rmdirSync(dirPath: string, options: { recursive: boolean }): void;
  renameSync(oldPath: string, newPath: string): void;
  /** Directory names only — used to rebuild the index from disk. */
  readdirSync(dirPath: string): string[];
}

const defaultFileSystem: FileSystem = {
  readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
  writeFileSync: (filePath, data) => fs.writeFileSync(filePath, data),
  existsSync: (filePath) => fs.existsSync(filePath),
  mkdirSync: (dirPath, options) => fs.mkdirSync(dirPath, options),
  rmdirSync: (dirPath, options) => fs.rmSync(dirPath, options),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
  readdirSync: (dirPath) => fs.readdirSync(dirPath),
};

const MAX_ID_LENGTH = 80;

export function generateIdFromPath(projectPath: string): string {
  const raw = projectPath.replace(/[^a-zA-Z0-9]/g, '_');

  if (raw.length <= MAX_ID_LENGTH) {
    return raw;
  }

  const hash = createHash('sha256').update(projectPath).digest('hex').substring(0, 16);
  return raw.substring(0, MAX_ID_LENGTH - 17) + '_' + hash;
}

// Extended index entry that includes project path for locating .claudito folder
export interface ProjectIndexEntryWithPath extends ProjectIndexEntry {
  path: string;
}

export class FileProjectRepository implements ProjectRepository {
  private readonly projectsDir: string;
  private readonly indexPath: string;
  private readonly fileSystem: FileSystem;
  private readonly logger = getLogger('project-repository');
  private index: Map<string, ProjectIndexEntryWithPath> = new Map();
  private statusCache: Map<string, ProjectStatus> = new Map();

  constructor(dataDir: string, fileSystem: FileSystem = defaultFileSystem) {
    this.fileSystem = fileSystem;
    this.projectsDir = path.join(dataDir, 'projects');
    this.indexPath = path.join(this.projectsDir, 'index.json');
    this.ensureProjectsDir();
    this.loadIndex();
  }

  // Get the project path for a given project ID (used by other repositories)
  getProjectPath(id: string): string | null {
    const entry = this.index.get(id);
    return entry?.path || null;
  }

  // Get the centralized data directory for a project (implements ProjectPathResolver)
  getProjectDataDir(id: string): string | null {
    if (!this.index.has(id)) return null;
    return path.join(this.projectsDir, id);
  }

  private ensureProjectsDir(): void {
    if (!this.fileSystem.existsSync(this.projectsDir)) {
      this.fileSystem.mkdirSync(this.projectsDir, { recursive: true });
    }
  }

  private loadIndex(): void {
    if (!this.fileSystem.existsSync(this.indexPath)) {
      // A missing index used to mean "no projects". Now that project data lives in
      // {projectsDir}/{id}, the folders on disk are the better source of truth.
      this.rebuildIndexFromDisk();
      return;
    }

    try {
      const data = this.fileSystem.readFileSync(this.indexPath, 'utf-8');
      const entries = JSON.parse(data) as ProjectIndexEntryWithPath[];
      entries.forEach((entry) => this.index.set(entry.id, entry));
      return;
    } catch {
      // Fall through to recovery below.
    }

    // Starting fresh here used to be silent and unrecoverable: getProjectDataDir()
    // returns null for anything not in the index, so an unreadable index made
    // every project's conversations and ralph state unreachable even though the
    // files were still on disk — and the next save overwrote the index with an
    // empty list, making it permanent. Keep the bad file for forensics and rebuild
    // from the project folders instead.
    this.preserveCorruptIndex();
    this.rebuildIndexFromDisk();

    if (this.index.size > 0) {
      this.saveIndex();
    }
  }

  private preserveCorruptIndex(): void {
    try {
      this.fileSystem.renameSync(this.indexPath, `${this.indexPath}.corrupt`);
    } catch {
      // Nothing more we can do; the rebuild below is what matters.
    }
  }

  /**
   * Reconstruct index entries from `{projectsDir}/{id}/status.json`.
   *
   * Each status file carries the id, name and path, so the index is fully
   * derivable from disk. The directory name wins over `status.id` because the
   * directory is what getProjectDataDir() resolves to.
   */
  private rebuildIndexFromDisk(): void {
    if (!this.fileSystem.existsSync(this.projectsDir)) {
      return;
    }

    let names: string[] = [];

    try {
      const listed = this.fileSystem.readdirSync(this.projectsDir);
      names = Array.isArray(listed) ? listed : [];
    } catch {
      return;
    }

    for (const name of names) {
      const statusPath = path.join(this.projectsDir, name, 'status.json');

      if (!this.fileSystem.existsSync(statusPath)) {
        continue;
      }

      try {
        const status = JSON.parse(this.fileSystem.readFileSync(statusPath, 'utf-8')) as ProjectStatus;

        if (typeof status?.path !== 'string' || status.path === '') {
          continue;
        }

        this.index.set(name, { id: name, name: status.name || name, path: status.path });
      } catch {
        // Skip unreadable project folders rather than aborting the whole rebuild.
      }
    }
  }

  private saveIndex(): void {
    const entries = Array.from(this.index.values());
    const data = JSON.stringify(entries, null, 2);
    // Atomic, like saveStatus: a half-written index is the one file that can make
    // every project's data unreachable at once.
    const tempPath = `${this.indexPath}.tmp`;
    this.fileSystem.writeFileSync(tempPath, data);
    this.fileSystem.renameSync(tempPath, this.indexPath);
  }

  private getProjectDataDirById(id: string): string {
    return path.join(this.projectsDir, id);
  }

  private getStatusPath(id: string): string {
    return path.join(this.getProjectDataDirById(id), 'status.json');
  }

  private loadStatus(id: string): ProjectStatus | null {
    if (this.statusCache.has(id)) {
      return { ...this.statusCache.get(id)! };
    }

    const entry = this.index.get(id);

    if (!entry) {
      return null;
    }

    // Handle backward compatibility: old entries may not have path
    if (!entry.path) {
      const oldStatusPath = path.join(this.projectsDir, id, 'status.json');

      if (this.fileSystem.existsSync(oldStatusPath)) {
        try {
          const data = this.fileSystem.readFileSync(oldStatusPath, 'utf-8');
          const status = JSON.parse(data) as ProjectStatus;

          entry.path = status.path;
          this.saveIndex();

          this.statusCache.set(id, status);
          return { ...status };
        } catch {
          return null;
        }
      }

      return null;
    }

    // Try centralized location first: {projectsDir}/{id}/status.json
    const statusPath = this.getStatusPath(id);

    if (this.fileSystem.existsSync(statusPath)) {
      try {
        const data = this.fileSystem.readFileSync(statusPath, 'utf-8');
        const status = JSON.parse(data) as ProjectStatus;
        this.statusCache.set(id, status);
        return { ...status };
      } catch {
        return null;
      }
    }

    // Fallback: legacy location {project-root}/.claudito/status.json
    const legacyStatusPath = path.join(entry.path, '.claudito', 'status.json');

    if (this.fileSystem.existsSync(legacyStatusPath)) {
      try {
        const data = this.fileSystem.readFileSync(legacyStatusPath, 'utf-8');
        const status = JSON.parse(data) as ProjectStatus;

        this.migrateFromLegacy(id, entry.path);

        this.statusCache.set(id, status);
        return { ...status };
      } catch {
        return null;
      }
    }

    return null;
  }

  private migrateFromLegacy(id: string, projectPath: string): void {
    const legacyDir = path.join(projectPath, '.claudito');

    if (!this.fileSystem.existsSync(legacyDir)) {
      return;
    }

    const centralDir = this.getProjectDataDirById(id);

    if (!this.fileSystem.existsSync(centralDir)) {
      this.fileSystem.mkdirSync(centralDir, { recursive: true });
    }

    try {
      // Copy conversations and ralph FIRST — if these fail, status.json
      // won't exist in central, so the next loadStatus will retry migration.
      const legacyConvDir = path.join(legacyDir, 'conversations');
      const centralConvDir = path.join(centralDir, 'conversations');

      if (this.fileSystem.existsSync(legacyConvDir)) {
        this.copyDirectory(legacyConvDir, centralConvDir);
      }

      const legacyRalphDir = path.join(legacyDir, 'ralph');
      const centralRalphDir = path.join(centralDir, 'ralph');

      if (this.fileSystem.existsSync(legacyRalphDir)) {
        this.copyDirectory(legacyRalphDir, centralRalphDir);
      }

      // Copy status.json LAST — its presence signals migration is complete.
      const legacyStatusPath = path.join(legacyDir, 'status.json');

      if (this.fileSystem.existsSync(legacyStatusPath)) {
        const statusData = this.fileSystem.readFileSync(legacyStatusPath, 'utf-8');
        const centralStatusPath = path.join(centralDir, 'status.json');
        const tempPath = `${centralStatusPath}.tmp`;
        this.fileSystem.writeFileSync(tempPath, statusData);
        this.fileSystem.renameSync(tempPath, centralStatusPath);
      }
    } catch {
      // Partial migration — clean up central dir so next loadStatus retries
      try {
        this.fileSystem.rmdirSync(centralDir, { recursive: true });
      } catch {
        // best-effort cleanup
      }
      return;
    }

    // The legacy dir is intentionally left in place. With several instances
    // running (one CLAUDITO_HOME per port), two of them can hold the same
    // project path in their index; deleting the legacy dir after the first
    // migration would silently strip that project's history from every other
    // instance. Keeping it lets each instance migrate independently.
  }

  private copyDirectory(src: string, dest: string): void {
    if (!this.fileSystem.existsSync(dest)) {
      this.fileSystem.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  private saveStatus(status: ProjectStatus): void {
    const dataDir = this.getProjectDataDirById(status.id);

    if (!this.fileSystem.existsSync(dataDir)) {
      this.fileSystem.mkdirSync(dataDir, { recursive: true });
    }

    status.updatedAt = new Date().toISOString();
    this.statusCache.set(status.id, status);
    const statusPath = this.getStatusPath(status.id);
    const data = JSON.stringify(status, null, 2);
    const tempPath = `${statusPath}.tmp`;
    this.fileSystem.writeFileSync(tempPath, data);
    this.fileSystem.renameSync(tempPath, statusPath);
  }

  findAll(): Promise<ProjectStatus[]> {
    const projects: ProjectStatus[] = [];

    for (const entry of this.index.values()) {
      const status = this.loadStatus(entry.id);

      if (status) {
        projects.push(status);
      }
    }

    return Promise.resolve(projects);
  }

  findById(id: string): Promise<ProjectStatus | null> {
    if (!this.index.has(id)) {
      return Promise.resolve(null);
    }

    return Promise.resolve(this.loadStatus(id));
  }

  async findByPath(projectPath: string): Promise<ProjectStatus | null> {
    const id = generateIdFromPath(projectPath);
    return this.findById(id);
  }

  async create(data: CreateProjectData): Promise<ProjectStatus> {
    const id = generateIdFromPath(data.path);

    const existingProject = await this.findById(id);

    if (existingProject) {
      throw new Error('Project with this path already exists');
    }

    const now = new Date().toISOString();
    const status: ProjectStatus = {
      id,
      name: data.name,
      path: data.path,
      status: 'stopped',
      currentConversationId: null,
      nextItem: null,
      currentItem: null,
      lastContextUsage: null,
      permissionOverrides: null,
      modelOverride: null,
      mcpOverrides: null,
      createdAt: now,
      updatedAt: now,
    };

    // Store path in index so we can locate the .claudito folder
    const indexEntry: ProjectIndexEntryWithPath = { id, name: data.name, path: data.path };
    this.index.set(id, indexEntry);
    this.saveIndex();
    this.saveStatus(status);

    return status;
  }

  updateStatus(id: string, newStatus: ProjectStatus['status']): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.status = newStatus;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateNextItem(id: string, nextItem: MilestoneItemRef | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.nextItem = nextItem;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateCurrentItem(id: string, currentItem: MilestoneItemRef | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.currentItem = currentItem;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  setCurrentConversation(id: string, conversationId: string | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.currentConversationId = conversationId;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateContextUsage(id: string, contextUsage: ContextUsageData | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.lastContextUsage = contextUsage;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updatePermissionOverrides(id: string, overrides: ProjectPermissionOverrides | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.permissionOverrides = overrides;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateModelOverride(id: string, model: string | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.modelOverride = model;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateMcpOverrides(id: string, overrides: McpOverrides | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.mcpOverrides = overrides;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateRunConfigurations(id: string, configs: RunConfiguration[]): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.runConfigurations = configs;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateDockerOverride(id: string, dockerOverride: boolean | undefined): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.dockerOverride = dockerOverride;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateDockerImage(id: string, dockerImage: string | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.dockerImage = dockerImage;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateSlackNotification(id: string, config: SlackNotificationConfig | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.slackNotification = config;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateSlackLinkedChannel(id: string, channelId: string | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.slackLinkedChannelId = channelId;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateAgentProfileId(id: string, profileId: string | null): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.agentProfileId = profileId;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateApprovalMode(id: string, mode: 'ask' | 'auto'): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) {
      return Promise.resolve(null);
    }

    status.approvalMode = mode;
    this.saveStatus(status);
    return Promise.resolve({ ...status });
  }

  updateProjectPath(
    id: string,
    newName: string,
    newPath: string,
  ): Promise<ProjectStatus | null> {
    const status = this.loadStatus(id);

    if (!status) return Promise.resolve(null);

    const newId = generateIdFromPath(newPath);

    const oldDataDir = this.getProjectDataDirById(id);
    const newDataDir = this.getProjectDataDirById(newId);

    if (id !== newId && this.fileSystem.existsSync(oldDataDir)) {
      if (!this.fileSystem.existsSync(newDataDir)) {
        this.fileSystem.renameSync(oldDataDir, newDataDir);
      } else {
        this.logger.warn('Target data directory already exists, skipping rename', {
          oldDataDir,
          newDataDir,
        });
      }
    }

    this.index.delete(id);
    this.statusCache.delete(id);

    status.id = newId;
    status.name = newName;
    status.path = newPath;

    const indexEntry: ProjectIndexEntryWithPath = {
      id: newId,
      name: newName,
      path: newPath,
    };

    this.index.set(newId, indexEntry);
    this.saveIndex();
    this.saveStatus(status);

    return Promise.resolve({ ...status });
  }

  delete(id: string): Promise<boolean> {
    const entry = this.index.get(id);

    if (!entry) {
      return Promise.resolve(false);
    }

    this.index.delete(id);
    this.saveIndex();
    this.statusCache.delete(id);

    const dataDir = this.getProjectDataDirById(id);

    if (this.fileSystem.existsSync(dataDir)) {
      this.fileSystem.rmdirSync(dataDir, { recursive: true });
    }

    return Promise.resolve(true);
  }
}

// Legacy alias for backward compatibility in type references
export type Project = ProjectStatus;
