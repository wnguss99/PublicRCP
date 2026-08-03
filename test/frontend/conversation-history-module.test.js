/**
 * @jest-environment jsdom
 */

const ConversationHistoryModule = require('../../public/js/modules/conversation-history-module');

describe('ConversationHistoryModule', () => {
  let mockState;
  let mockApi;
  let mockEscapeHtml;
  let mockShowToast;
  let mockShowErrorToast;
  let mockTruncateString;
  let mockFormatConversationDate;
  let mockFormatDuration;
  let mockRenderConversation;
  let mockSetPromptBlockingState;
  let mockSearchModule;

  function createMockJQuery() {
    const mockElement = {
      html: jest.fn().mockReturnThis(),
      text: jest.fn().mockReturnThis(),
      val: jest.fn().mockReturnThis(),
      addClass: jest.fn().mockReturnThis(),
      removeClass: jest.fn().mockReturnThis(),
      toggleClass: jest.fn().mockReturnThis(),
      hasClass: jest.fn().mockReturnValue(false),
      prop: jest.fn().mockReturnThis(),
      attr: jest.fn(),
      css: jest.fn().mockReturnThis(),
      data: jest.fn(),
      empty: jest.fn().mockReturnThis(),
      append: jest.fn().mockReturnThis(),
      on: jest.fn().mockReturnThis(),
      closest: jest.fn().mockReturnValue({ length: 0 }),
      offset: jest.fn().mockReturnValue({ top: 100, left: 50 }),
      outerHeight: jest.fn().mockReturnValue(40)
    };

    return jest.fn().mockReturnValue(mockElement);
  }

  beforeEach(() => {
    localStorage.clear();

    global.$ = createMockJQuery();

    mockState = {
      selectedProjectId: 'test-project-id',
      conversationHistoryOpen: false,
      currentConversationId: null,
      currentConversationStats: null,
      currentConversationMetadata: null,
      conversations: {},
      historyLimit: 25,
      search: {
        isOpen: false
      }
    };

    mockApi = {
      getConversation: jest.fn().mockReturnValue({
        done: jest.fn().mockReturnThis(),
        fail: jest.fn().mockReturnThis()
      }),
      setCurrentConversation: jest.fn().mockReturnValue({
        done: jest.fn().mockReturnThis(),
        fail: jest.fn().mockReturnThis()
      })
    };

    mockEscapeHtml = jest.fn((str) => str);
    mockShowToast = jest.fn();
    mockShowErrorToast = jest.fn();
    mockTruncateString = jest.fn((str, len) => str.substring(0, len));
    mockFormatConversationDate = jest.fn((date) => '2024-01-15');
    mockFormatDuration = jest.fn((ms) => '5m');
    mockRenderConversation = jest.fn();
    mockSetPromptBlockingState = jest.fn();
    mockSearchModule = {
      close: jest.fn()
    };

    // Mock jQuery $.get for loadList
    global.$.get = jest.fn().mockReturnValue({
      done: jest.fn().mockReturnThis(),
      fail: jest.fn().mockReturnThis()
    });

    ConversationHistoryModule.init({
      state: mockState,
      api: mockApi,
      escapeHtml: mockEscapeHtml,
      showToast: mockShowToast,
      showErrorToast: mockShowErrorToast,
      truncateString: mockTruncateString,
      formatConversationDate: mockFormatConversationDate,
      formatDuration: mockFormatDuration,
      renderConversation: mockRenderConversation,
      setPromptHintState: mockSetPromptBlockingState,
      SearchModule: mockSearchModule
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('toggle', () => {
    it('should open when closed', () => {
      mockState.conversationHistoryOpen = false;

      ConversationHistoryModule.toggle();

      expect(mockState.conversationHistoryOpen).toBe(true);
    });

    it('should close when open', () => {
      mockState.conversationHistoryOpen = true;

      ConversationHistoryModule.toggle();

      expect(mockState.conversationHistoryOpen).toBe(false);
    });
  });

  describe('open', () => {
    it('should set conversationHistoryOpen to true', () => {
      ConversationHistoryModule.open();

      expect(mockState.conversationHistoryOpen).toBe(true);
    });

    it('should not open if no project selected', () => {
      mockState.selectedProjectId = null;

      ConversationHistoryModule.open();

      expect(mockState.conversationHistoryOpen).toBe(false);
    });

    it('should position dropdown near button', () => {
      const mockDropdown = global.$();

      ConversationHistoryModule.open();

      expect(global.$).toHaveBeenCalledWith('#btn-show-history');
      expect(global.$).toHaveBeenCalledWith('#conversation-history-dropdown');
      expect(mockDropdown.css).toHaveBeenCalled();
    });

    it('should remove hidden class from dropdown', () => {
      const mockDropdown = global.$();

      ConversationHistoryModule.open();

      expect(mockDropdown.removeClass).toHaveBeenCalledWith('hidden');
    });
  });

  describe('close', () => {
    it('should set conversationHistoryOpen to false', () => {
      mockState.conversationHistoryOpen = true;

      ConversationHistoryModule.close();

      expect(mockState.conversationHistoryOpen).toBe(false);
    });

    it('should add hidden class to dropdown', () => {
      const mockDropdown = global.$();

      ConversationHistoryModule.close();

      expect(global.$).toHaveBeenCalledWith('#conversation-history-dropdown');
      expect(mockDropdown.addClass).toHaveBeenCalledWith('hidden');
    });
  });

  describe('loadList', () => {
    it('should not load if no project selected', () => {
      mockState.selectedProjectId = null;

      ConversationHistoryModule.loadList();

      expect(global.$.get).not.toHaveBeenCalled();
    });

    it('should show loading indicator', () => {
      const mockList = global.$();

      ConversationHistoryModule.loadList();

      expect(global.$).toHaveBeenCalledWith('#conversation-history-list');
      expect(mockList.html).toHaveBeenCalledWith(
        expect.stringContaining('Loading...')
      );
    });

    it('should make API call with correct parameters', () => {
      ConversationHistoryModule.loadList();

      expect(global.$.get).toHaveBeenCalledWith(
        '/api/projects/test-project-id/conversations',
        { limit: 25 }
      );
    });
  });

  describe('renderList', () => {
    it('should show empty message when no conversations', () => {
      const mockList = global.$();

      ConversationHistoryModule.renderList([]);

      expect(mockList.html).toHaveBeenCalledWith(
        expect.stringContaining('No conversations yet')
      );
    });

    it('should render conversation items', () => {
      const mockList = {
        empty: jest.fn().mockReturnThis(),
        html: jest.fn().mockReturnThis(),
        append: jest.fn().mockReturnThis()
      };

      global.$ = jest.fn((selector) => {
        if (selector === '#conversation-history-list') {
          return mockList;
        }

        return createMockJQuery()();
      });

      const conversations = [
        {
          id: 'conv-1',
          label: 'Test Conversation',
          createdAt: '2024-01-15T10:00:00Z',
          messages: [1, 2, 3]
        }
      ];

      ConversationHistoryModule.renderList(conversations);

      expect(mockList.empty).toHaveBeenCalled();
      expect(mockList.append).toHaveBeenCalled();
    });

    it('should mark active conversation', () => {
      mockState.currentConversationId = 'conv-1';
      const mockList = {
        empty: jest.fn().mockReturnThis(),
        html: jest.fn().mockReturnThis(),
        append: jest.fn().mockReturnThis()
      };

      global.$ = jest.fn((selector) => {
        if (selector === '#conversation-history-list') {
          return mockList;
        }

        return createMockJQuery()();
      });

      const conversations = [
        {
          id: 'conv-1',
          label: 'Active Conv',
          createdAt: '2024-01-15T10:00:00Z',
          messages: []
        },
        {
          id: 'conv-2',
          label: 'Other Conv',
          createdAt: '2024-01-14T10:00:00Z',
          messages: []
        }
      ];

      ConversationHistoryModule.renderList(conversations);

      const appendCall = mockList.append.mock.calls[0][0];
      expect(appendCall).toContain('active');
    });

    it('should use itemRef taskTitle when no label', () => {
      const mockList = {
        empty: jest.fn().mockReturnThis(),
        html: jest.fn().mockReturnThis(),
        append: jest.fn().mockReturnThis()
      };

      global.$ = jest.fn((selector) => {
        if (selector === '#conversation-history-list') {
          return mockList;
        }

        return createMockJQuery()();
      });

      const conversations = [
        {
          id: 'conv-1',
          itemRef: { taskTitle: 'Task Title' },
          createdAt: '2024-01-15T10:00:00Z',
          messages: []
        }
      ];

      ConversationHistoryModule.renderList(conversations);

      expect(mockTruncateString).toHaveBeenCalledWith('Task Title', 35);
    });

    it('should default to Interactive Session when no label or itemRef', () => {
      const mockList = {
        empty: jest.fn().mockReturnThis(),
        html: jest.fn().mockReturnThis(),
        append: jest.fn().mockReturnThis()
      };

      global.$ = jest.fn((selector) => {
        if (selector === '#conversation-history-list') {
          return mockList;
        }

        return createMockJQuery()();
      });

      const conversations = [
        {
          id: 'conv-1',
          createdAt: '2024-01-15T10:00:00Z',
          messages: []
        }
      ];

      ConversationHistoryModule.renderList(conversations);

      expect(mockTruncateString).toHaveBeenCalledWith('Interactive Session', 35);
    });
  });

  describe('loadConversation', () => {
    it('should not load if no project selected', () => {
      mockState.selectedProjectId = null;

      ConversationHistoryModule.loadConversation('conv-123');

      expect(mockApi.setCurrentConversation).not.toHaveBeenCalled();
    });

    it('should close search if open', () => {
      mockState.search.isOpen = true;

      ConversationHistoryModule.loadConversation('conv-123');

      expect(mockSearchModule.close).toHaveBeenCalled();
    });

    it('should clear prompt blocking state', () => {
      ConversationHistoryModule.loadConversation('conv-123');

      expect(mockSetPromptBlockingState).toHaveBeenCalledWith(null);
    });

    it('should set currentConversationId', () => {
      ConversationHistoryModule.loadConversation('conv-123');

      expect(mockState.currentConversationId).toBe('conv-123');
    });

    it('should call setCurrentConversation API', () => {
      ConversationHistoryModule.loadConversation('conv-123');

      expect(mockApi.setCurrentConversation).toHaveBeenCalledWith(
        'test-project-id',
        'conv-123'
      );
    });
  });

  describe('updateStats', () => {
    it('should show new session for no stats', () => {
      mockState.currentConversationStats = null;
      const mockStats = global.$();

      ConversationHistoryModule.updateStats();

      expect(global.$).toHaveBeenCalledWith('#conversation-stats');
      expect(mockStats.html).toHaveBeenCalledWith(
        expect.stringContaining('New session')
      );
    });

    it('should show new session for zero messages', () => {
      mockState.currentConversationStats = { messageCount: 0 };
      const mockStats = global.$();

      ConversationHistoryModule.updateStats();

      expect(mockStats.html).toHaveBeenCalledWith(
        expect.stringContaining('New session')
      );
    });

    it('should show message count', () => {
      mockState.currentConversationStats = {
        messageCount: 10,
        toolCallCount: 0,
        durationMs: 0
      };
      const mockStats = global.$();

      ConversationHistoryModule.updateStats();

      expect(mockStats.html).toHaveBeenCalledWith(
        expect.stringContaining('10 msgs')
      );
    });

    it('should show duration when available', () => {
      mockState.currentConversationStats = {
        messageCount: 5,
        toolCallCount: 0,
        durationMs: 300000
      };
      const mockStats = global.$();

      ConversationHistoryModule.updateStats();

      expect(mockFormatDuration).toHaveBeenCalledWith(300000);
    });

    it('should show tool calls when available', () => {
      mockState.currentConversationStats = {
        messageCount: 5,
        toolCallCount: 3,
        durationMs: 0
      };
      const mockStats = global.$();

      ConversationHistoryModule.updateStats();

      expect(mockStats.html).toHaveBeenCalledWith(
        expect.stringContaining('3 tools')
      );
    });

  });

  describe('setupHandlers', () => {
    it('should register click handler for history button', () => {
      const mockBtn = global.$();

      ConversationHistoryModule.setupHandlers();

      expect(global.$).toHaveBeenCalledWith('#btn-show-history');
      expect(mockBtn.on).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('should register document click handler for close', () => {
      const mockDoc = global.$();

      global.$ = jest.fn((selector) => {
        if (selector === document) {
          return mockDoc;
        }

        return createMockJQuery()();
      });

      ConversationHistoryModule.setupHandlers();

      expect(global.$).toHaveBeenCalledWith(document);
      expect(mockDoc.on).toHaveBeenCalledWith('click', expect.any(Function));
    });
  });
});
