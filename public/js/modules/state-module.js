/**
 * @module StateModule
 * @description Centralized application state management for Claudito.
 * Provides a single source of truth for all application state.
 */
(function(root, factory) {
  'use strict';

  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StateModule = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  /**
   * Create the default application state
   * @function createDefaultState
   * @memberof module:StateModule
   * @returns {Claudito.ApplicationState} Default state object with all initial values
   * @example
   * const initialState = createDefaultState();
   * console.log(initialState.permissionMode); // 'plan'
   */
  function createDefaultState() {
    return {
      // Project management
      projects: [],
      selectedProjectId: null,
      projectSearchQuery: '',

      // Conversations
      conversations: {},
      // projectId -> error text when the last history load failed, else null.
      // Without this an empty `conversations[projectId]` is ambiguous: it means
      // both "this project has no messages" and "we never managed to load them",
      // and the UI showed the reassuring version of that for both.
      conversationLoadErrors: {},
      // projectId -> true while a history load is in flight. Without this the
      // empty cache of a first render is indistinguishable from "no messages",
      // so every refresh showed "No conversation yet" for the whole duration of
      // a multi-megabyte fetch — the same false claim of deletion, just earlier.
      conversationLoading: {},
      currentConversationId: null,
      currentConversationStats: null,
      currentConversationMetadata: null,
      conversationHistoryOpen: false,

      // WebSocket
      websocket: null,
      wsReconnect: {
        attempts: 0,
        maxAttempts: 50,
        baseDelay: 1000,
        maxDelay: 30000,
        timeout: null
      },

      // Agent state
      agentMode: 'interactive',
      permissionMode: 'plan',
      pendingPermissionMode: null,
      currentAgentMode: null,
      agentStarting: false,
      messageSending: false,
      queuedMessageCount: 0,
      currentSessionId: null,
      currentPlanFile: null,
      waitingVersion: 0,
      activePromptType: null,
      // Mirrors the server's plan lock. null = not yet known, so a persisted
      // plan_mode message is still restored on first load.
      hasPendingPlan: null,
      isModeSwitching: false,

      // Resource status
      resourceStatus: {
        runningCount: 0,
        maxConcurrent: 3,
        queuedCount: 0,
        queuedProjects: []
      },

      // UI state
      activeTab: 'agent-output',
      fontSize: 14,
      agentOutputScrollLock: false,
      debugPanelOpen: false,
      debugRefreshInterval: null,
      agentStatusInterval: null,
      agentReconcileInterval: null,
      roadmapGenerating: false,
      devMode: false,

      // Folder browser
      folderBrowser: {
        currentPath: null
      },

      // File browser
      fileBrowser: {
        expandedDirs: {},
        selectedFile: null,
        rootEntries: []
      },

      // Open files
      openFiles: [],
      activeFilePath: null,

      // Claude files
      claudeFilesState: {
        files: [],
        currentFile: null
      },
      claudeOptimizationPending: false,
      gitCommitMessagePending: false,

      // Pending operations
      pendingDeleteId: null,
      pendingDeleteTask: null,
      pendingDeleteMilestone: null,
      pendingDeletePhase: null,
      pendingRenameConversationId: null,
      pendingDeleteFile: null,
      pendingCreateFile: null,
      pendingCreateFolder: null,
      pendingImages: [],

      // Tasks
      currentTodos: [],

      // Multi-question tracking
      multiQuestionState: {
        activeToolId: null,
        totalQuestions: 0,
        answers: {},
        isMultiQuestion: false
      },

      // Search
      search: {
        isOpen: false,
        query: '',
        matches: [],
        currentIndex: -1,
        filters: {
          user: true,
          assistant: true,
          tool: true,
          system: true
        },
        searchHistory: false,
        historyResults: [],
        options: {
          regex: false,
          caseSensitive: false
        }
      },

      // Debug
      debugExpandedLogs: {},
      debugLogFilters: {
        error: true,
        warn: true,
        info: true,
        debug: true,
        frontend: true
      },

      // Git
      git: {
        expandedDirs: {},
        selectedFile: null
      },
      gitContextTarget: null,
      isGitOperating: false,

      // Context menu
      contextMenuTarget: null,

      // Settings
      sendWithCtrlEnter: true,
      historyLimit: 25
    };
  }

  /**
   * Create a state manager with change tracking
   * @function createStateManager
   * @memberof module:StateModule
   * @param {Claudito.ApplicationState} [initialState] - Optional initial state, defaults to createDefaultState()
   * @returns {StateManager} State manager interface with get/set/update/subscribe methods
   * @example
   * const stateManager = createStateManager();
   * stateManager.set('selectedProjectId', 'abc123');
   * const projectId = stateManager.get('selectedProjectId');
   */
  function createStateManager(initialState) {
    var state = initialState || createDefaultState();
    var changeListeners = {};

    /**
     * Get a value from state by path
     * @function get
     * @memberof StateManager
     * @param {string} [path] - Dot-notation path (e.g., 'search.query'). If omitted, returns entire state
     * @returns {*} The value at the path or undefined if not found
     * @example
     * const query = stateManager.get('search.query');
     * const entireState = stateManager.get();
     */
    function get(path) {
      if (!path) return state;

      var parts = path.split('.');
      var value = state;

      for (var i = 0; i < parts.length; i++) {
        if (value === undefined || value === null) return undefined;
        value = value[parts[i]];
      }

      return value;
    }

    /**
     * Set a value in state and notify listeners
     * @function set
     * @memberof StateManager
     * @param {string} path - Dot-notation path
     * @param {*} value - Value to set
     * @fires StateManager#change
     * @example
     * stateManager.set('currentConversationId', 'conv-123');
     * stateManager.set('wsReconnect.attempts', 5);
     */
    function set(path, value) {
      var parts = path.split('.');
      var target = state;

      for (var i = 0; i < parts.length - 1; i++) {
        if (target[parts[i]] === undefined) {
          target[parts[i]] = {};
        }
        target = target[parts[i]];
      }

      var lastKey = parts[parts.length - 1];
      var oldValue = target[lastKey];
      target[lastKey] = value;

      notifyListeners(path, value, oldValue);
    }

    /**
     * Update multiple values at once
     * @function update
     * @memberof StateManager
     * @param {Object.<string, *>} updates - Object with path: value pairs
     * @fires StateManager#change
     * @example
     * stateManager.update({
     *   'selectedProjectId': 'proj-123',
     *   'activeTab': 'project-files',
     *   'search.query': 'authentication'
     * });
     */
    function update(updates) {
      for (var path in updates) {
        if (Object.prototype.hasOwnProperty.call(updates, path)) {
          set(path, updates[path]);
        }
      }
    }

    /**
     * Reset state to defaults
     * @function reset
     * @memberof StateManager
     * @fires StateManager#change
     * @example
     * stateManager.reset(); // All values back to defaults
     */
    function reset() {
      state = createDefaultState();
      notifyListeners('*', state, null);
    }

    /**
     * Register a change listener for a path
     * @function onChange
     * @memberof StateManager
     * @param {string} path - Path to watch (use '*' for all changes)
     * @param {StateChangeListener} listener - Callback function
     * @returns {void}
     * @example
     * // Listen to specific path
     * stateManager.onChange('selectedProjectId', (newId, oldId) => {
     *   console.log(`Project changed from ${oldId} to ${newId}`);
     * });
     *
     * // Listen to all changes
     * stateManager.onChange('*', (newVal, oldVal, path) => {
     *   console.log(`${path} changed`);
     * });
     */
    function onChange(path, listener) {
      if (!changeListeners[path]) {
        changeListeners[path] = [];
      }
      changeListeners[path].push(listener);
    }

    /**
     * Remove a change listener
     * @function offChange
     * @memberof StateManager
     * @param {string} path - Path the listener was registered for
     * @param {StateChangeListener} listener - Callback to remove
     * @returns {void}
     * @example
     * const myListener = (newVal) => console.log(newVal);
     * stateManager.onChange('activeTab', myListener);
     * // Later...
     * stateManager.offChange('activeTab', myListener);
     */
    function offChange(path, listener) {
      if (!changeListeners[path]) return;

      var index = changeListeners[path].indexOf(listener);

      if (index !== -1) {
        changeListeners[path].splice(index, 1);
      }
    }

    /**
     * Notify listeners of a change
     * @function notifyListeners
     * @memberof StateManager
     * @private
     * @param {string} path - Changed path
     * @param {*} newValue - New value
     * @param {*} oldValue - Old value
     */
    function notifyListeners(path, newValue, oldValue) {
      // Notify specific path listeners
      if (changeListeners[path]) {
        for (var i = 0; i < changeListeners[path].length; i++) {
          try {
            changeListeners[path][i](newValue, oldValue, path);
          } catch (err) {
            console.error('State change listener error:', err);
          }
        }
      }

      // Notify wildcard listeners
      if (changeListeners['*']) {
        for (var j = 0; j < changeListeners['*'].length; j++) {
          try {
            changeListeners['*'][j](newValue, oldValue, path);
          } catch (err) {
            console.error('State change listener error:', err);
          }
        }
      }

      // Notify parent path listeners (e.g., 'search' when 'search.query' changes)
      var parts = path.split('.');

      for (var k = 1; k < parts.length; k++) {
        var parentPath = parts.slice(0, k).join('.');

        if (changeListeners[parentPath]) {
          for (var l = 0; l < changeListeners[parentPath].length; l++) {
            try {
              changeListeners[parentPath][l](get(parentPath), null, parentPath);
            } catch (err) {
              console.error('State change listener error:', err);
            }
          }
        }
      }
    }

    /**
     * Get the raw state object (for backward compatibility)
     * @function getState
     * @memberof StateManager
     * @deprecated Use get() method instead for better encapsulation
     * @returns {Claudito.ApplicationState} The entire state object
     * @example
     * const fullState = stateManager.getState();
     * console.log(fullState.projects);
     */
    function getState() {
      return state;
    }

    /**
     * @typedef {Object} StateManager
     * @property {Function} get - Get value by path
     * @property {Function} set - Set value by path
     * @property {Function} update - Update multiple values
     * @property {Function} reset - Reset to defaults
     * @property {Function} onChange - Subscribe to changes
     * @property {Function} offChange - Unsubscribe from changes
     * @property {Function} getState - Get raw state (deprecated)
     */
    return {
      get: get,
      set: set,
      update: update,
      reset: reset,
      onChange: onChange,
      offChange: offChange,
      getState: getState
    };
  }

  /**
   * @typedef {Function} StateChangeListener
   * @param {*} newValue - New value at the path
   * @param {*} oldValue - Previous value at the path
   * @param {string} path - The path that changed
   */

  // Public API
  return {
    createDefaultState: createDefaultState,
    createStateManager: createStateManager
  };
}));
