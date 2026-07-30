import fs from 'fs';
import path from 'path';
import { AgentMessage, ContextUsage } from '../agents';
import { MilestoneItemRef } from './project';
import { ProjectPathResolver } from './interfaces';
import {
  generateUUID,
  getLogger,
  Logger,
  atomicWriteFile,
  safeJsonStringify,
  getCurrentTimestamp,
  generateCacheKey,
  PendingOperationsTracker,
  WriteQueueManager
} from '../utils';

export interface ConversationMetadata {
  contextUsage?: ContextUsage;
  sessionId?: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  itemRef: MilestoneItemRef | null;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
  label?: string;
  metadata?: ConversationMetadata;
}

export interface SearchResult {
  conversationId: string;
  messageType: string;
  content: string;
  createdAt: string;
  label?: string;
}

export interface ConversationRepository {
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
  // Wait for all pending write operations to complete
  flush(): Promise<void>;
  // Legacy methods for backward compatibility
  addMessageLegacy(projectId: string, message: AgentMessage): Promise<void>;
  getMessagesLegacy(projectId: string, limit?: number): Promise<AgentMessage[]>;
}

export interface ConversationFileSystem {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, data: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  mkdir(dirPath: string): Promise<void>;
  readdir(dirPath: string): Promise<string[]>;
  unlink(filePath: string): Promise<void>;
}

const defaultFileSystem: ConversationFileSystem = {
  readFile: (filePath) => fs.promises.readFile(filePath, 'utf-8'),
  writeFile: (filePath, data) => atomicWriteFile(filePath, data),
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
  readdir: async (dirPath) => {
    try {
      return await fs.promises.readdir(dirPath);
    } catch {
      return [];
    }
  },
  unlink: (filePath) => fs.promises.unlink(filePath),
};

// ProjectPathResolver is now imported from interfaces.ts to avoid duplication

export interface FileConversationRepositoryConfig {
  projectPathResolver: ProjectPathResolver;
  fileSystem?: ConversationFileSystem;
  maxMessagesPerConversation?: number;
}

export function generateConversationId(): string {
  return generateUUID();
}

export class FileConversationRepository implements ConversationRepository {
  private readonly projectPathResolver: ProjectPathResolver;
  private readonly fileSystem: ConversationFileSystem;
  private readonly maxMessages: number;
  private readonly cache: Map<string, Conversation> = new Map();
  private readonly pendingOperations: PendingOperationsTracker;
  private readonly writeQueues: WriteQueueManager<string>;
  private readonly logger: Logger;

  constructor(config: FileConversationRepositoryConfig) {
    this.projectPathResolver = config.projectPathResolver;
    this.fileSystem = config.fileSystem || defaultFileSystem;
    this.maxMessages = config.maxMessagesPerConversation || 1000;
    this.logger = getLogger('conversation-repository');
    this.pendingOperations = new PendingOperationsTracker('conversation-repo');
    this.writeQueues = new WriteQueueManager('conversation-repo');
  }

  async flush(): Promise<void> {
    await this.pendingOperations.flush();
    await this.writeQueues.flush();
  }

  private trackOperation<T>(promise: Promise<T>): Promise<T> {
    return this.pendingOperations.track(promise);
  }

  // Serialize operations on a conversation to prevent race conditions
  private async withConversationLock<T>(
    projectId: string,
    conversationId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = this.getCacheKey(projectId, conversationId);
    return this.writeQueues.withLock(key, operation);
  }

  private getProjectDataDir(projectId: string): string | null {
    return this.projectPathResolver.getProjectDataDir(projectId);
  }

  private getConversationsDir(projectId: string): string | null {
    const dataDir = this.getProjectDataDir(projectId);

    if (!dataDir) {
      return null;
    }

    return path.join(dataDir, 'conversations');
  }

  private getConversationPath(projectId: string, conversationId: string): string | null {
    const conversationsDir = this.getConversationsDir(projectId);

    if (!conversationsDir) {
      return null;
    }

    return path.join(conversationsDir, `${conversationId}.json`);
  }

  private getCacheKey(projectId: string, conversationId: string): string {
    return generateCacheKey(projectId, conversationId);
  }

  async create(projectId: string, itemRef: MilestoneItemRef | null): Promise<Conversation> {
    const id = generateConversationId();
    const now = getCurrentTimestamp();

    const conversation: Conversation = {
      id,
      projectId,
      itemRef,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.saveConversation(projectId, conversation);
    return conversation;
  }

  async findById(projectId: string, conversationId: string): Promise<Conversation | null> {
    return this.loadConversation(projectId, conversationId);
  }

  async getByProject(projectId: string, limit?: number): Promise<Conversation[]> {
    const conversationsDir = this.getConversationsDir(projectId);

    if (!conversationsDir) {
      return [];
    }

    const exists = await this.fileSystem.exists(conversationsDir);

    if (!exists) {
      return [];
    }

    const files = await this.fileSystem.readdir(conversationsDir);
    const conversations: Conversation[] = [];

    for (const file of files) {
      // Skip non-JSON files and temp files
      if (!file.endsWith('.json') || file.endsWith('.tmp.json')) {
        continue;
      }

      const conversationId = file.replace('.json', '');
      const conversation = await this.loadConversation(projectId, conversationId);

      if (conversation) {
        conversations.push(conversation);
      }
    }

    const sorted = conversations.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    if (limit && limit > 0) {
      return sorted.slice(0, limit);
    }

    return sorted;
  }

  async renameConversation(
    projectId: string,
    conversationId: string,
    label: string
  ): Promise<void> {
    const conversation = await this.loadConversation(projectId, conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    conversation.label = label;
    conversation.updatedAt = getCurrentTimestamp();
    await this.saveConversation(projectId, conversation);
  }

  async addMessage(
    projectId: string,
    conversationId: string,
    message: AgentMessage
  ): Promise<void> {
    // Use lock to serialize concurrent message additions
    return this.withConversationLock(projectId, conversationId, async () => {
      // Always read fresh from disk inside the lock to get latest state
      let conversation = await this.loadConversationFromDisk(projectId, conversationId);

      if (!conversation) {
        // Conversation doesn't exist (deleted or corrupted), create it
        const filePath = this.getConversationPath(projectId, conversationId);
        this.logger.warn('Conversation not found, creating new one', { projectId, conversationId, filePath });

        const now = getCurrentTimestamp();
        conversation = {
          id: conversationId,
          projectId,
          itemRef: null,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
      }

      conversation.messages.push(message);

      if (conversation.messages.length > this.maxMessages) {
        conversation.messages.splice(0, conversation.messages.length - this.maxMessages);
      }

      conversation.updatedAt = getCurrentTimestamp();
      await this.saveConversation(projectId, conversation);
    });
  }

  async getMessages(
    projectId: string,
    conversationId: string,
    limit?: number
  ): Promise<AgentMessage[]> {
    const conversation = await this.loadConversation(projectId, conversationId);

    if (!conversation) {
      return [];
    }

    const messages = conversation.messages;

    if (limit && limit < messages.length) {
      return messages.slice(-limit);
    }

    return messages;
  }

  async clearMessages(projectId: string, conversationId: string): Promise<void> {
    const conversation = await this.loadConversation(projectId, conversationId);

    if (!conversation) {
      return;
    }

    conversation.messages = [];
    conversation.updatedAt = getCurrentTimestamp();
    await this.saveConversation(projectId, conversation);
  }

  async deleteConversation(projectId: string, conversationId: string): Promise<void> {
    const filePath = this.getConversationPath(projectId, conversationId);

    if (!filePath) {
      return;
    }

    const exists = await this.fileSystem.exists(filePath);

    if (exists) {
      await this.fileSystem.unlink(filePath);
    }

    // Remove from cache
    const cacheKey = this.getCacheKey(projectId, conversationId);
    this.cache.delete(cacheKey);
  }

  async updateMetadata(
    projectId: string,
    conversationId: string,
    metadata: Partial<ConversationMetadata>
  ): Promise<void> {
    // Use lock to serialize concurrent updates
    return this.withConversationLock(projectId, conversationId, async () => {
      // Always read fresh from disk inside the lock
      let conversation = await this.loadConversationFromDisk(projectId, conversationId);

      if (!conversation) {
        // Conversation doesn't exist (deleted or corrupted), create it
        const filePath = this.getConversationPath(projectId, conversationId);
        this.logger.warn('Conversation not found for metadata update, creating new one', { projectId, conversationId, filePath });

        const now = getCurrentTimestamp();
        conversation = {
          id: conversationId,
          projectId,
          itemRef: null,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
      }

      conversation.metadata = {
        ...conversation.metadata,
        ...metadata,
      };
      conversation.updatedAt = getCurrentTimestamp();
      await this.saveConversation(projectId, conversation);
    });
  }

  // Legacy methods - operate on a "current" or default conversation
  // These maintain backward compatibility with existing code
  async addMessageLegacy(projectId: string, message: AgentMessage): Promise<void> {
    const conversations = await this.getByProject(projectId);
    let currentConversation = conversations[0];

    if (!currentConversation) {
      currentConversation = await this.create(projectId, null);
    }

    await this.addMessage(projectId, currentConversation.id, message);
  }

  async getMessagesLegacy(projectId: string, limit?: number): Promise<AgentMessage[]> {
    const conversations = await this.getByProject(projectId);
    const mostRecent = conversations[0];

    if (!mostRecent) {
      return [];
    }

    return this.getMessages(projectId, mostRecent.id, limit);
  }

  async searchMessages(projectId: string, query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();
    const conversations = await this.getByProject(projectId);
    const maxResults = 50;
    const contextChars = 100;

    for (const conv of conversations) {
      if (results.length >= maxResults) {
        break;
      }

      if (!conv.messages || conv.messages.length === 0) {
        continue;
      }

      for (const message of conv.messages) {
        if (results.length >= maxResults) {
          break;
        }

        const content = message.content || '';
        const lowerContent = content.toLowerCase();
        const matchIndex = lowerContent.indexOf(lowerQuery);

        if (matchIndex === -1) {
          continue;
        }

        // Extract context around the match
        const start = Math.max(0, matchIndex - contextChars);
        const end = Math.min(content.length, matchIndex + query.length + contextChars);
        let snippet = content.substring(start, end);

        if (start > 0) {
          snippet = '...' + snippet;
        }

        if (end < content.length) {
          snippet = snippet + '...';
        }

        results.push({
          conversationId: conv.id,
          messageType: message.type,
          content: snippet,
          createdAt: conv.createdAt,
          label: conv.label,
        });
      }
    }

    return results;
  }

  // Load from cache first, then disk
  private async loadConversation(
    projectId: string,
    conversationId: string
  ): Promise<Conversation | null> {
    const cacheKey = this.getCacheKey(projectId, conversationId);

    if (this.cache.has(cacheKey)) {
      return { ...this.cache.get(cacheKey)! };
    }

    return this.loadConversationFromDisk(projectId, conversationId);
  }

  // Always read fresh from disk, bypassing cache
  private async loadConversationFromDisk(
    projectId: string,
    conversationId: string
  ): Promise<Conversation | null> {
    const filePath = this.getConversationPath(projectId, conversationId);

    if (!filePath) {
      return null;
    }

    const exists = await this.fileSystem.exists(filePath);

    if (!exists) {
      return null;
    }

    try {
      const content = await this.fileSystem.readFile(filePath);
      const conversation = JSON.parse(content) as Conversation;
      // Update cache with fresh data
      const cacheKey = this.getCacheKey(projectId, conversationId);
      this.cache.set(cacheKey, { ...conversation });
      return conversation;
    } catch (err) {
      this.logger.error('Corrupted conversation file, preserving as .corrupt', {
        projectId,
        conversationId,
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });

      try {
        await fs.promises.rename(filePath, `${filePath}.corrupt`);
      } catch {
        // best-effort preservation
      }

      return null;
    }
  }

  private async saveConversation(projectId: string, conversation: Conversation): Promise<void> {
    const writeOperation = this.doSaveConversation(projectId, conversation);
    return this.trackOperation(writeOperation);
  }

  private async doSaveConversation(projectId: string, conversation: Conversation): Promise<void> {
    const conversationsDir = this.getConversationsDir(projectId);

    if (!conversationsDir) {
      throw new Error(`Project ${projectId} not found`);
    }

    const exists = await this.fileSystem.exists(conversationsDir);

    if (!exists) {
      await this.fileSystem.mkdir(conversationsDir);
    }

    const cacheKey = this.getCacheKey(projectId, conversation.id);
    this.cache.set(cacheKey, { ...conversation });

    const filePath = this.getConversationPath(projectId, conversation.id);

    if (!filePath) {
      throw new Error(`Project ${projectId} not found`);
    }

    await this.fileSystem.writeFile(filePath, safeJsonStringify(conversation));
  }
}
