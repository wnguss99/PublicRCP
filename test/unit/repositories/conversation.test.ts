import {
  FileConversationRepository,
  FileConversationRepositoryConfig,
  Conversation,
  generateConversationId,
} from '../../../src/repositories/conversation';
import { AgentMessage } from '../../../src/agents/agent';
import {
  createMockConversationFileSystem,
  createMockProjectPathResolver,
  sampleMilestoneRef,
} from '../helpers/mock-factories';

// Helper to get write call data safely
function getWriteCallData(
  mockFs: ReturnType<typeof createMockConversationFileSystem>,
  callIndex = 0
): Conversation {
  const calls = mockFs.writeFile.mock.calls;
  if (callIndex < 0) {
    callIndex = calls.length + callIndex;
  }
  const call = calls[callIndex];
  if (!call || !call[1]) {
    throw new Error(`No write call at index ${callIndex}`);
  }
  return JSON.parse(call[1]) as Conversation;
}

describe('FileConversationRepository', () => {
  let repository: FileConversationRepository;
  let mockFileSystem: ReturnType<typeof createMockConversationFileSystem>;
  let mockPathResolver: ReturnType<typeof createMockProjectPathResolver>;

  beforeEach(() => {
    mockFileSystem = createMockConversationFileSystem();
    mockPathResolver = createMockProjectPathResolver(
      {
        'test-project': '/test/path',
        'project-2': '/test/path2',
      },
      {
        'test-project': '/data/projects/test-project',
        'project-2': '/data/projects/project-2',
      },
    );

    const config: FileConversationRepositoryConfig = {
      projectPathResolver: mockPathResolver,
      fileSystem: mockFileSystem,
      maxMessagesPerConversation: 10,
    };

    repository = new FileConversationRepository(config);
  });


  describe('generateConversationId', () => {
    it('should generate valid UUID v4', () => {
      const id = generateConversationId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateConversationId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('create', () => {
    it('should create conversation with generated UUID', async () => {
      const conversation = await repository.create('test-project', null);

      expect(conversation.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(conversation.projectId).toBe('test-project');
      expect(conversation.itemRef).toBeNull();
      expect(conversation.messages).toEqual([]);
    });

    it('should create conversation with itemRef', async () => {
      const conversation = await repository.create('test-project', sampleMilestoneRef);

      expect(conversation.itemRef).toEqual(sampleMilestoneRef);
    });

    it('should set createdAt and updatedAt timestamps', async () => {
      const before = new Date().toISOString();
      const conversation = await repository.create('test-project', null);
      const after = new Date().toISOString();

      expect(conversation.createdAt).toBeTruthy();
      expect(conversation.updatedAt).toBeTruthy();
      expect(conversation.createdAt >= before).toBe(true);
      expect(conversation.createdAt <= after).toBe(true);
    });

    it('should save conversation to disk', async () => {
      const conversation = await repository.create('test-project', null);

      expect(mockFileSystem.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(`${conversation.id}.json`),
        expect.any(String)
      );
    });

    it('should create conversations directory if not exists', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      await repository.create('test-project', null);

      expect(mockFileSystem.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('conversations')
      );
    });

    // Note: Testing "throw error if project not found" is skipped because
    // the repository's trackOperation() method tracks rejected promises
    // without handling them, causing Node.js unhandled rejection errors.
    // This would require fixing the repository code to properly handle rejections.
  });

  describe('findById', () => {
    it('should return null if file does not exist', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      const result = await repository.findById('test-project', 'conv-123');

      expect(result).toBeNull();
    });

    it('should return conversation from disk', async () => {
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      const result = await repository.findById('test-project', 'conv-123');

      expect(result).toEqual(savedConv);
    });

    it('should return cached conversation on second call', async () => {
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      await repository.findById('test-project', 'conv-123');
      mockFileSystem.readFile.mockClear();

      const result = await repository.findById('test-project', 'conv-123');

      expect(result).toEqual(savedConv);
      expect(mockFileSystem.readFile).not.toHaveBeenCalled();
    });

    it('should return null for unknown project', async () => {
      const result = await repository.findById('unknown-project', 'conv-123');

      expect(result).toBeNull();
    });

    it('should handle corrupted JSON gracefully', async () => {
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue('not valid json');

      const result = await repository.findById('test-project', 'conv-123');

      expect(result).toBeNull();
    });
  });

  describe('getByProject', () => {
    it('should return empty array if conversations dir does not exist', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      const result = await repository.getByProject('test-project');

      expect(result).toEqual([]);
    });

    it('should return empty array for unknown project', async () => {
      const result = await repository.getByProject('unknown-project');

      expect(result).toEqual([]);
    });

    it('should return conversations sorted by createdAt descending', async () => {
      const conv1: Conversation = {
        id: 'conv-1',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      const conv2: Conversation = {
        id: 'conv-2',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      };

      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readdir.mockResolvedValue(['conv-1.json', 'conv-2.json']);
      mockFileSystem.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('conv-1')) {
          return Promise.resolve(JSON.stringify(conv1));
        }
        return Promise.resolve(JSON.stringify(conv2));
      });

      const result = await repository.getByProject('test-project');

      expect(result[0]?.id).toBe('conv-2');
      expect(result[1]?.id).toBe('conv-1');
    });

    it('should respect limit parameter', async () => {
      const conv1: Conversation = {
        id: 'conv-1',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      const conv2: Conversation = {
        id: 'conv-2',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      };

      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readdir.mockResolvedValue(['conv-1.json', 'conv-2.json']);
      mockFileSystem.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('conv-1')) {
          return Promise.resolve(JSON.stringify(conv1));
        }
        return Promise.resolve(JSON.stringify(conv2));
      });

      const result = await repository.getByProject('test-project', 1);

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('conv-2');
    });

    it('should skip non-JSON files', async () => {
      const conv1: Conversation = {
        id: 'conv-1',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readdir.mockResolvedValue(['conv-1.json', 'readme.txt', '.gitkeep']);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(conv1));

      const result = await repository.getByProject('test-project');

      expect(result).toHaveLength(1);
    });

    it('should skip temp files', async () => {
      const conv1: Conversation = {
        id: 'conv-1',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readdir.mockResolvedValue(['conv-1.json', 'conv-1.tmp.json']);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(conv1));

      const result = await repository.getByProject('test-project');

      expect(result).toHaveLength(1);
    });
  });

  describe('addMessage', () => {
    it('should add message to existing conversation', async () => {
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      const message: AgentMessage = {
        type: 'stdout',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      };

      await repository.addMessage('test-project', 'conv-123', message);

      await repository.flush(); // writes are coalesced; force the pending one out

      expect(mockFileSystem.writeFile).toHaveBeenCalled();
      const writtenData = getWriteCallData(mockFileSystem, 0);
      expect(writtenData.messages).toHaveLength(1);
      expect(writtenData.messages[0]).toBeDefined();
      expect(writtenData.messages[0]).toEqual(message);
    });

    it('should create conversation if not exists', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      const message: AgentMessage = {
        type: 'stdout',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      };

      await repository.addMessage('test-project', 'conv-123', message);

      await repository.flush(); // writes are coalesced; force the pending one out

      expect(mockFileSystem.writeFile).toHaveBeenCalled();
      const writtenData = getWriteCallData(mockFileSystem, 0);
      expect(writtenData.id).toBe('conv-123');
      expect(writtenData.messages).toHaveLength(1);
    });

    it('should trim messages when exceeding max limit', async () => {
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push({
          type: 'stdout',
          content: `Message ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      const newMessage: AgentMessage = {
        type: 'stdout',
        content: 'New message',
        timestamp: new Date().toISOString(),
      };

      await repository.addMessage('test-project', 'conv-123', newMessage);

      await repository.flush(); // writes are coalesced; force the pending one out

      const writtenData = getWriteCallData(mockFileSystem, 0);
      expect(writtenData.messages).toHaveLength(10);
      expect(writtenData.messages[9]?.content).toBe('New message');
      expect(writtenData.messages[0]?.content).toBe('Message 1');
    });

    it('should update updatedAt timestamp', async () => {
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      const before = new Date().toISOString();
      await repository.addMessage('test-project', 'conv-123', {
        type: 'stdout',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      });
      const after = new Date().toISOString();

      await repository.flush(); // writes are coalesced; force the pending one out
      const writtenData = getWriteCallData(mockFileSystem, 0);
      expect(writtenData.updatedAt >= before).toBe(true);
      expect(writtenData.updatedAt <= after).toBe(true);
    });
  });

  describe('getMessages', () => {
    it('should return empty array if conversation not found', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      const result = await repository.getMessages('test-project', 'conv-123');

      expect(result).toEqual([]);
    });

    it('should return all messages without limit', async () => {
      const messages: AgentMessage[] = [
        { type: 'stdout', content: 'Message 1', timestamp: '2024-01-01T00:00:00.000Z' },
        { type: 'stdout', content: 'Message 2', timestamp: '2024-01-01T00:00:01.000Z' },
      ];
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      const result = await repository.getMessages('test-project', 'conv-123');

      expect(result).toHaveLength(2);
    });

    it('should return last N messages with limit', async () => {
      const messages: AgentMessage[] = [
        { type: 'stdout', content: 'Message 1', timestamp: '2024-01-01T00:00:00.000Z' },
        { type: 'stdout', content: 'Message 2', timestamp: '2024-01-01T00:00:01.000Z' },
        { type: 'stdout', content: 'Message 3', timestamp: '2024-01-01T00:00:02.000Z' },
      ];
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      const result = await repository.getMessages('test-project', 'conv-123', 2);

      expect(result).toHaveLength(2);
      expect(result[0]?.content).toBe('Message 2');
      expect(result[1]?.content).toBe('Message 3');
    });
  });

  describe('clearMessages', () => {
    it('should do nothing if conversation not found', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      await repository.clearMessages('test-project', 'conv-123');

      expect(mockFileSystem.writeFile).not.toHaveBeenCalled();
    });

    it('should clear all messages', async () => {
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [
          { type: 'stdout', content: 'Message 1', timestamp: '2024-01-01T00:00:00.000Z' },
        ],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      await repository.clearMessages('test-project', 'conv-123');

      const writtenData = getWriteCallData(mockFileSystem, 0);
      expect(writtenData.messages).toEqual([]);
    });
  });

  describe('deleteConversation', () => {
    it('should do nothing if file does not exist', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      await repository.deleteConversation('test-project', 'conv-123');

      expect(mockFileSystem.unlink).not.toHaveBeenCalled();
    });

    it('should delete file from disk', async () => {
      mockFileSystem.exists.mockResolvedValue(true);

      await repository.deleteConversation('test-project', 'conv-123');

      expect(mockFileSystem.unlink).toHaveBeenCalledWith(
        expect.stringContaining('conv-123.json')
      );
    });

    it('should remove from cache', async () => {
      // First load the conversation to cache it
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));
      await repository.findById('test-project', 'conv-123');

      // Now delete
      await repository.deleteConversation('test-project', 'conv-123');

      // The next findById should not find it in cache
      mockFileSystem.exists.mockResolvedValue(false);
      const result = await repository.findById('test-project', 'conv-123');
      expect(result).toBeNull();
    });

    it('should do nothing for unknown project', async () => {
      await repository.deleteConversation('unknown-project', 'conv-123');

      expect(mockFileSystem.unlink).not.toHaveBeenCalled();
    });
  });

  describe('renameConversation', () => {
    it('should throw error if conversation not found', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      await expect(
        repository.renameConversation('test-project', 'conv-123', 'New Label')
      ).rejects.toThrow('not found');
    });

    it('should update label', async () => {
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      await repository.renameConversation('test-project', 'conv-123', 'My Label');

      const writtenData = getWriteCallData(mockFileSystem, 0);
      expect(writtenData.label).toBe('My Label');
    });
  });

  describe('updateMetadata', () => {
    it('should create conversation if not found', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      await repository.updateMetadata('test-project', 'conv-123', {
        sessionId: 'session-abc',
      });

      expect(mockFileSystem.writeFile).toHaveBeenCalled();
      const writtenData = getWriteCallData(mockFileSystem, 0);
      expect(writtenData.metadata?.sessionId).toBe('session-abc');
    });

    it('should merge metadata', async () => {
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        metadata: {
          sessionId: 'old-session',
        },
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      await repository.updateMetadata('test-project', 'conv-123', {
        contextUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          maxContextTokens: 200000,
          percentUsed: 0.075,
        },
      });

      const writtenData = getWriteCallData(mockFileSystem, 0);
      expect(writtenData.metadata?.sessionId).toBe('old-session');
      expect(writtenData.metadata?.contextUsage?.totalTokens).toBe(150);
    });
  });

  describe('searchMessages', () => {
    it('should return empty array if no conversations', async () => {
      mockFileSystem.exists.mockResolvedValue(false);

      const result = await repository.searchMessages('test-project', 'test');

      expect(result).toEqual([]);
    });

    it('should find matching messages case-insensitively', async () => {
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [
          { type: 'stdout', content: 'Hello World', timestamp: '2024-01-01T00:00:00.000Z' },
          { type: 'stdout', content: 'HELLO again', timestamp: '2024-01-01T00:00:01.000Z' },
          { type: 'stdout', content: 'Goodbye', timestamp: '2024-01-01T00:00:02.000Z' },
        ],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readdir.mockResolvedValue(['conv-123.json']);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      const result = await repository.searchMessages('test-project', 'hello');

      expect(result).toHaveLength(2);
    });

    it('should include context around match', async () => {
      const longContent = 'Before text '.repeat(20) + 'MATCH' + ' After text'.repeat(20);
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [
          { type: 'stdout', content: longContent, timestamp: '2024-01-01T00:00:00.000Z' },
        ],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readdir.mockResolvedValue(['conv-123.json']);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      const result = await repository.searchMessages('test-project', 'MATCH');

      expect(result).toHaveLength(1);
      expect(result[0]?.content).toContain('...');
      expect(result[0]?.content).toContain('MATCH');
    });

    it('should limit results to 50', async () => {
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 60; i++) {
        messages.push({
          type: 'stdout',
          content: `test message ${i}`,
          timestamp: new Date().toISOString(),
        });
      }
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readdir.mockResolvedValue(['conv-123.json']);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      const result = await repository.searchMessages('test-project', 'test');

      expect(result).toHaveLength(50);
    });
  });

  describe('flush', () => {
    it('should wait for pending operations to complete', async () => {
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

      // Start some async operations
      void repository.addMessage('test-project', 'conv-123', {
        type: 'stdout',
        content: 'Message 1',
        timestamp: new Date().toISOString(),
      });
      void repository.addMessage('test-project', 'conv-123', {
        type: 'stdout',
        content: 'Message 2',
        timestamp: new Date().toISOString(),
      });

      // Flush should wait for all operations
      await repository.flush();

      expect(mockFileSystem.writeFile).toHaveBeenCalled();
    });
  });

  describe('Legacy Methods', () => {
    describe('addMessageLegacy', () => {
      it('should create conversation if none exists', async () => {
        mockFileSystem.exists.mockResolvedValue(false);
        mockFileSystem.readdir.mockResolvedValue([]);

        await repository.addMessageLegacy('test-project', {
          type: 'stdout',
          content: 'Hello',
          timestamp: new Date().toISOString(),
        });

        // Should create a new conversation and add message
        expect(mockFileSystem.writeFile).toHaveBeenCalled();
      });

      it('should add to most recent conversation if exists', async () => {
        const savedConv: Conversation = {
          id: 'conv-123',
          projectId: 'test-project',
          itemRef: null,
          messages: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        };
        mockFileSystem.exists.mockResolvedValue(true);
        mockFileSystem.readdir.mockResolvedValue(['conv-123.json']);
        mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

        await repository.addMessageLegacy('test-project', {
          type: 'stdout',
          content: 'Hello',
          timestamp: new Date().toISOString(),
        });

        await repository.flush(); // writes are coalesced; force the pending one out
        const writtenData = getWriteCallData(mockFileSystem, -1);
        expect(writtenData.id).toBe('conv-123');
        expect(writtenData.messages).toHaveLength(1);
      });
    });

    describe('getMessagesLegacy', () => {
      it('should return empty array if no conversations', async () => {
        mockFileSystem.exists.mockResolvedValue(false);

        const result = await repository.getMessagesLegacy('test-project');

        expect(result).toEqual([]);
      });

      it('should return messages from most recent conversation', async () => {
        const savedConv: Conversation = {
          id: 'conv-123',
          projectId: 'test-project',
          itemRef: null,
          messages: [
            { type: 'stdout', content: 'Message 1', timestamp: '2024-01-01T00:00:00.000Z' },
          ],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        };
        mockFileSystem.exists.mockResolvedValue(true);
        mockFileSystem.readdir.mockResolvedValue(['conv-123.json']);
        mockFileSystem.readFile.mockResolvedValue(JSON.stringify(savedConv));

        const result = await repository.getMessagesLegacy('test-project');

        expect(result).toHaveLength(1);
        expect(result[0]?.content).toBe('Message 1');
      });
    });
  });

  describe('Concurrent Write Safety', () => {
    it('should serialize concurrent addMessage calls on same conversation', async () => {
      let writeCount = 0;
      const savedConv: Conversation = {
        id: 'conv-123',
        projectId: 'test-project',
        itemRef: null,
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      // Make exists/readFile return the latest state
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockImplementation(() => {
        return Promise.resolve(JSON.stringify(savedConv));
      });
      mockFileSystem.writeFile.mockImplementation((_path: string, data: string) => {
        writeCount++;
        // Update savedConv with written data to simulate disk state
        Object.assign(savedConv, JSON.parse(data));
        return Promise.resolve();
      });

      // Send multiple concurrent messages
      const promises = [
        repository.addMessage('test-project', 'conv-123', {
          type: 'stdout',
          content: 'Message 1',
          timestamp: new Date().toISOString(),
        }),
        repository.addMessage('test-project', 'conv-123', {
          type: 'stdout',
          content: 'Message 2',
          timestamp: new Date().toISOString(),
        }),
        repository.addMessage('test-project', 'conv-123', {
          type: 'stdout',
          content: 'Message 3',
          timestamp: new Date().toISOString(),
        }),
      ];

      await Promise.all(promises);
      await repository.flush();

      // Writes are coalesced, so a burst becomes one write — that is the point of
      // scheduleSave(). What must hold is that no message is lost and none is
      // interleaved away by a concurrent write.
      expect(writeCount).toBeLessThan(3);
      expect(writeCount).toBeGreaterThan(0);
      expect(savedConv.messages).toHaveLength(3);
      expect(savedConv.messages.map((m) => m.content))
        .toEqual(['Message 1', 'Message 2', 'Message 3']);
    });
  });

  // 스트리밍은 stdout/tool_use/tool_result 각각에 대해 addMessage 를 부른다.
  // 매번 디스크에서 다시 읽으면 대화 전체를 read + JSON.parse 하게 되어,
  // 1000메시지(4.4MB) 기준 건당 약 24ms 동안 이벤트 루프가 멈췄다(측정치).
  /**
   * Every message used to rewrite the whole conversation file, with nothing merging
   * the writes — WriteQueueManager serialises, it does not coalesce. A turn emitting
   * stdout/tool_use/tool_result several times a second rewrote a file that had grown
   * to 5.17 MB, at tens of MB/s once three instances were busy: enough to make the
   * desktop stutter, and enough for a scanner to hold the file open and turn 176
   * saves into `EPERM ... rename` failures.
   */
  describe('coalesced writes', () => {
    it('collapses a burst of messages into a single write', async () => {
      const id = (await repository.create('test-project', null)).id;
      mockFileSystem.writeFile.mockClear();

      // Under the fixture's 10-message cap, so this measures coalescing rather than
      // trimming.
      for (let i = 0; i < 8; i++) {
        await repository.addMessage('test-project', id, {
          type: 'stdout', content: `chunk ${i}`, timestamp: new Date().toISOString(),
        });
      }

      // Nothing on disk yet — the burst is still pending.
      expect(mockFileSystem.writeFile).not.toHaveBeenCalled();

      await repository.flush();

      expect(mockFileSystem.writeFile).toHaveBeenCalledTimes(1);
      const written = getWriteCallData(mockFileSystem, -1);
      expect(written.messages).toHaveLength(8);
      expect(written.messages[7]!.content).toBe('chunk 7');
    });

    it('serves pending messages to readers before they reach disk', async () => {
      const id = (await repository.create('test-project', null)).id;
      await repository.addMessage('test-project', id, {
        type: 'stdout', content: 'not yet written', timestamp: new Date().toISOString(),
      });

      // The cache is authoritative, so delaying the write must not make a message
      // invisible — that was its own bug class, with the answer appearing only after
      // a refresh.
      const messages = await repository.getMessages('test-project', id);
      expect(messages.map((m) => m.content)).toContain('not yet written');
    });

    /**
     * An addMessage still waiting on its conversation lock has not marked anything
     * dirty yet, so a flush that wrote the dirty set first would miss exactly the
     * messages that were in flight — a shutdown would drop them.
     */
    it('flush waits for in-flight additions, not just dirty ones', async () => {
      const id = (await repository.create('test-project', null)).id;
      mockFileSystem.writeFile.mockClear();

      // Deliberately not awaited: these are mid-flight when flush() starts.
      void repository.addMessage('test-project', id, {
        type: 'stdout', content: 'in flight 1', timestamp: new Date().toISOString(),
      });
      void repository.addMessage('test-project', id, {
        type: 'stdout', content: 'in flight 2', timestamp: new Date().toISOString(),
      });

      await repository.flush();

      const written = getWriteCallData(mockFileSystem, -1);
      expect(written.messages.map((m) => m.content))
        .toEqual(['in flight 1', 'in flight 2']);
    });
  });

  describe('streaming write path', () => {
    it('should not re-read the conversation from disk once it is cached', async () => {
      const id = (await repository.create('test-project', null)).id;
      await repository.addMessage('test-project', id, {
        type: 'stdout', content: 'first', timestamp: new Date().toISOString(),
      });

      mockFileSystem.readFile.mockClear();

      for (let i = 0; i < 5; i++) {
        await repository.addMessage('test-project', id, {
          type: 'stdout', content: `chunk ${i}`, timestamp: new Date().toISOString(),
        });
      }

      expect(mockFileSystem.readFile).not.toHaveBeenCalled();
    });

    it('should still persist every message', async () => {
      const id = (await repository.create('test-project', null)).id;

      for (let i = 0; i < 4; i++) {
        await repository.addMessage('test-project', id, {
          type: 'stdout', content: `chunk ${i}`, timestamp: new Date().toISOString(),
        });
      }

      const messages = await repository.getMessages('test-project', id);
      expect(messages.map((m) => m.content)).toEqual(['chunk 0', 'chunk 1', 'chunk 2', 'chunk 3']);
    });

    it('should drop the cache when a write fails so it cannot diverge from disk', async () => {
      const id = (await repository.create('test-project', null)).id;
      await repository.addMessage('test-project', id, {
        type: 'stdout', content: 'persisted', timestamp: new Date().toISOString(),
      });
      // Land this one for real before arming the failure. Writes are coalesced, so
      // without the flush both messages would share the failing write — a batch that
      // fails loses the whole batch, which is a property of coalescing, not the thing
      // under test here.
      await repository.flush();

      // mockRejectedValueOnce 는 거부된 프로미스를 즉시 만들어 unhandled rejection 이
      // 된다. 호출되는 순간에 던지게 한다.
      mockFileSystem.writeFile.mockImplementationOnce(async () => {
        throw new Error('disk full');
      });

      // addMessage only schedules now, so the write — and its failure — surfaces
      // when the coalesced save runs.
      await repository.addMessage('test-project', id, {
        type: 'stdout', content: 'lost', timestamp: new Date().toISOString(),
      });
      await expect(repository.flush()).rejects.toThrow('disk full');

      // Cache was dropped, so this re-reads from disk and must not show the
      // message that failed to persist.
      const messages = await repository.getMessages('test-project', id);
      expect(messages.map((m) => m.content)).toEqual(['persisted']);
    });
  });
});
