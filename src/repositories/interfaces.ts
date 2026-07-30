/**
 * Central repository interfaces following CLAUDE.md guidelines
 * These interfaces allow for easy mocking in unit tests
 */

import { AgentMessage, ContextUsage } from '../agents';
import {
  RalphLoopState,
  IterationSummary,
  ReviewerFeedback
} from '../services/ralph-loop';

// Import needed types
import {
  ProjectStatus,
  MilestoneItemRef,
  ProjectPermissionOverrides,
  ContextUsageData
} from './project';

import {
  Conversation,
  ConversationMetadata,
  SearchResult
} from './conversation';

import {
  GlobalSettings,
  ClaudePermissions,
  RalphLoopSettings,
  PromptTemplate
} from './settings';

// Re-export for convenience
export {
  ProjectStatus,
  MilestoneItemRef,
  ProjectPermissionOverrides,
  ContextUsageData,
  Conversation,
  ConversationMetadata,
  SearchResult,
  GlobalSettings,
  ClaudePermissions,
  RalphLoopSettings,
  PromptTemplate
};

/**
 * Project repository interface
 */
export interface IProjectRepository {
  findAll(): Promise<ProjectStatus[]>;
  findById(id: string): Promise<ProjectStatus | null>;
  create(project: Omit<ProjectStatus, 'id' | 'createdAt' | 'updatedAt'>): Promise<ProjectStatus>;
  updateStatus(id: string, status: 'running' | 'stopped'): Promise<void>;
  updateConversation(id: string, conversationId: string | null): Promise<void>;
  updateNextItem(id: string, nextItem: MilestoneItemRef | null): Promise<void>;
  updateCurrentItem(id: string, currentItem: MilestoneItemRef | null): Promise<void>;
  updateContextUsage(id: string, usage: ContextUsage): Promise<void>;
  updatePermissionOverrides(id: string, overrides: ProjectPermissionOverrides | null): Promise<void>;
  updateModelOverride(id: string, model: string | null): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  setCurrentConversation(projectId: string, conversationId: string): Promise<void>;
  getByPath(path: string): Promise<ProjectStatus | null>;
}

/**
 * Conversation repository interface
 */
export interface IConversationRepository {
  create(projectId: string, itemRef: MilestoneItemRef | null): Promise<Conversation>;
  findById(projectId: string, conversationId: string): Promise<Conversation | null>;
  getByProject(projectId: string, limit?: number): Promise<Conversation[]>;
  addMessage(projectId: string, conversationId: string, message: AgentMessage): Promise<void>;
  getMessages(projectId: string, conversationId: string, limit?: number): Promise<AgentMessage[]>;
  clearMessages(projectId: string, conversationId: string): Promise<void>;
  deleteConversation(projectId: string, conversationId: string): Promise<void>;
  renameConversation(projectId: string, conversationId: string, label: string): Promise<void>;
  updateMetadata(
    projectId: string,
    conversationId: string,
    metadata: Partial<ConversationMetadata>
  ): Promise<void>;
  searchMessages(projectId: string, query: string): Promise<SearchResult[]>;
  flush(): Promise<void>;
  // Legacy methods for backward compatibility
  addMessageLegacy(projectId: string, message: AgentMessage): Promise<void>;
  getMessagesLegacy(projectId: string, limit?: number): Promise<AgentMessage[]>;
}

/**
 * Settings repository interface
 */
export interface ISettingsRepository {
  get(): Promise<GlobalSettings>;
  update(settings: Partial<GlobalSettings>): Promise<void>;
}

/**
 * Ralph Loop repository interface
 */
export interface IRalphLoopRepository {
  create(state: Omit<RalphLoopState, 'createdAt' | 'updatedAt'>): Promise<RalphLoopState>;
  findById(projectId: string, taskId: string): Promise<RalphLoopState | null>;
  findByProject(projectId: string): Promise<RalphLoopState[]>;
  update(projectId: string, taskId: string, update: Partial<RalphLoopState>): Promise<void>;
  addSummary(projectId: string, taskId: string, summary: IterationSummary): Promise<void>;
  addFeedback(projectId: string, taskId: string, feedback: ReviewerFeedback): Promise<void>;
  delete(projectId: string, taskId: string): Promise<boolean>;
  deleteAll(projectId: string): Promise<void>;
  flush(): Promise<void>;
}

/**
 * Generic file system interface for repositories
 */
export interface IFileSystem {
  readFileSync(filePath: string, encoding: BufferEncoding): string;
  writeFileSync(filePath: string, data: string): void;
  existsSync(filePath: string): boolean;
  mkdirSync(dirPath: string, options: { recursive: boolean }): void;
  rmdirSync(dirPath: string, options: { recursive: boolean }): void;
  renameSync(oldPath: string, newPath: string): void;
}

/**
 * Async file system interface
 */
export interface IAsyncFileSystem {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, data: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  mkdir(dirPath: string): Promise<void>;
  readdir(dirPath: string): Promise<string[]>;
  unlink(filePath: string): Promise<void>;
}

/**
 * Project path resolver interface
 */
export interface ProjectPathResolver {
  getProjectPath(projectId: string): string | null;
  getProjectDataDir(projectId: string): string | null;
}

/**
 * Repository factory for dependency injection
 */
export interface IRepositoryFactory {
  createProjectRepository(): IProjectRepository;
  createConversationRepository(): IConversationRepository;
  createSettingsRepository(): ISettingsRepository;
  createRalphLoopRepository(): IRalphLoopRepository;
}