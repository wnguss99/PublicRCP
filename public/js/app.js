// Claudito Frontend Application

(function($) {
  'use strict';

  // ============================================================
  // Module References
  // ============================================================
  // These modules are loaded before app.js in index.html
  var LocalStorage = window.LocalStorage;
  var DiffEngine = window.DiffEngine;
  var ApiClient = window.ApiClient;
  var Formatters = window.Formatters;
  var Validators = window.Validators;
  var EscapeUtils = window.EscapeUtils;
  var GitModule = window.GitModule;
  var ShellModule = window.ShellModule;
  var RalphLoopModule = window.RalphLoopModule;
  var DebugModal = window.DebugModal;
  var FileBrowser = window.FileBrowserV2;
  var RoadmapModule = window.RoadmapModule;
  var ModalsModule = window.ModalsModule;
  var SearchModule = window.SearchModule;
  var ConversationHistoryModule = window.ConversationHistoryModule;
  var ImageAttachmentModule = window.ImageAttachmentModule;
  var TaskDisplayModule = window.TaskDisplayModule;
  var PermissionModeModule = window.PermissionModeModule;
  var FolderBrowserModule = window.FolderBrowserModule;
  var PromptTemplatesModule = window.PromptTemplatesModule;
  var ClaudeCommandsModule = window.ClaudeCommandsModule;
  var ResourceMonitor = window.ResourceMonitor;
  var WebSocketModule = window.WebSocketModule;
  var OneOffToolbarModule = window.OneOffToolbarModule;
  var RunConfigsModule = window.RunConfigsModule;
  var InventifyModule = window.InventifyModule;

  // Alias for backward compatibility within this file
  var api = ApiClient;

  // Generate unique client ID for this session
  var clientId = sessionStorage.getItem('claudito-client-id');
  if (!clientId) {
    clientId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem('claudito-client-id', clientId);
  }

  // Application state
  const state = {
    projects: [],
    selectedProjectId: null,
    conversations: {},
    folderBrowser: {
      currentPath: null
    },
    websocket: null,
    wsConnected: false, // Track WebSocket connection state
    wsHasConnected: false, // True once connected at least once, so onopen can tell a reconnect from the first connect
    backfill: { inFlight: false, pendingProjectId: null }, // Coalesces post-reconnect history reloads
    clientId: clientId, // Add clientId for multi-client debugging
    resourceStatus: {
      runningCount: 0,
      maxConcurrent: 3,
      queuedCount: 0,
      queuedProjects: []
    },
    pendingDeleteId: null,
    pendingDeleteTask: null,
    pendingDeleteMilestone: null,
    pendingDeletePhase: null,
    debugPanelOpen: false,
    debugRefreshInterval: null,
    agentStatusInterval: null, // Polling interval for agent status
    agentReconcileInterval: null, // Slow poll that keeps a non-running project's status honest
    roadmapGenerating: false,
    agentOutputScrollLock: false,
    fontSize: 14, // Font size for Claude output (10-24px)
    agentStarting: false, // Prevents concurrent agent starts
    messageSending: false, // Prevents concurrent message sends
    permissionMode: 'plan', // 'acceptEdits' or 'plan'
    pendingPermissionMode: null, // Mode to apply when agent finishes current operation
    currentAgentMode: null, // mode of currently running agent
    currentConversationId: null,
    currentConversationStats: null, // { messageCount, toolCallCount, userMessageCount, durationMs, startedAt }
    currentConversationMetadata: null,
    currentConversationLabel: null,
    conversationHistoryOpen: false,
    queuedMessageCount: 0, // Number of messages waiting to be sent to agent
    sendWithCtrlEnter: true, // Configurable: true = Ctrl+Enter to send, false = Enter to send
    historyLimit: 25, // Maximum conversations shown in history
    pendingRenameConversationId: null, // For rename modal
    pendingDeleteFile: null, // { path, isDirectory, name } for file deletion confirmation
    pendingCreateFile: null, // { parentPath } for file creation modal
    pendingCreateFolder: null, // { parentPath } for folder creation modal
    currentTodos: [], // Current task list from last TodoWrite
    activeTab: 'agent-output', // 'agent-output' or 'project-files'
    projectSearchQuery: '', // Search filter for project list
    contextMenuTarget: null, // { path, isDir, name } for context menu actions
    pendingImages: [], // Array of { id, dataUrl, mimeType, size } for images to send with message
    currentSessionId: null, // Claude session ID for session resumption
    currentPlanFile: null, // Path to current plan file from ExitPlanMode
    allClientResources: {}, // Resources from all clients { clientId: { resources: [], stats: {} } }
    // WebSocket reconnection state
    wsReconnect: {
      attempts: 0,
      maxAttempts: 50,
      baseDelay: 1000,
      maxDelay: 30000,
      timeout: null
    },
    // File browser state
    fileBrowser: {
      expandedDirs: {},
      selectedFile: null,
      rootEntries: []
    },
    // Open files state
    openFiles: [], // [{path, name, content, modified, originalContent}]
    activeFilePath: null,
    // Claude Files state
    claudeFilesState: {
      files: [],
      currentFile: null // { path, name, content, originalContent, size, isGlobal }
    },
    devMode: false,
    // Search state
    search: {
      isOpen: false,
      query: '',
      matches: [],      // Array of highlight span elements
      currentIndex: -1,
      filters: {
        user: true,
        assistant: true,
        tool: true,
        system: true
      },
      searchHistory: false,
      historyResults: [],  // Results from history search API
      options: {
        regex: false,
        caseSensitive: false
      }
    },
    isModeSwitching: false, // UI blocked during permission mode switch
    debugExpandedLogs: {}, // Track expanded log items by ID: { logId: true }
    debugLogFilters: { // Log level filters for debug modal
      error: true,
      warn: true,
      info: true,
      debug: true,
      frontend: true
    },
    waitingVersion: 0, // Version number for waiting status updates
    // Git state
    git: {
      expandedDirs: {}, // Track expanded directories in git tree
      selectedFile: null // Currently selected file for diff
    },
    gitContextTarget: null, // { path, type, status } for git context menu
    activePromptType: null, // 'question' | 'permission' | 'plan_mode' | null - blocks input while prompt is active
    planFeedbackPending: false, // Next message should be sent as plan feedback (after clicking "Request Changes")
    pendingMessageBeforeQuestion: null, // Stores input text that was cleared when Claude asked a question
    justAnsweredQuestion: false, // Flag to prevent auto-restoring messages right after answering a question
    isGitOperating: false, // Blocks git UI during operations
    shellEnabled: true, // Whether shell tab is available (disabled when server bound to 0.0.0.0)
    projectInputs: {}, // Per-project input text: { projectId: 'input text' }
    currentRalphLoopId: null, // Currently running Ralph Loop task ID
    isRalphLoopRunning: false, // Whether Ralph Loop is currently active
    hasUnsavedMcpChanges: false, // Track if MCP server changes haven't been saved
    chromeEnabled: false, // Chrome browser usage for agents
    deferredPlanMessage: null, // Stores ExitPlanMode message when questions are pending
    lastPlanContent: null, // Stores the most recent plan content from ExitPlanMode
    settings: null, // Global settings object
    selectedGitHubRepo: null, // Selected repo full name for GitHub clone
    submittedQuestionToolIds: {}, // Track toolIds already submitted to prevent duplicates
    currentDockerImage: null, // Per-project Docker image override (null = use global)
    currentEffectiveImage: null // Effective Docker image name being used
  };

  // Local storage keys - use module's KEYS
  var LOCAL_STORAGE_KEYS = LocalStorage.KEYS;

  // Local storage utility functions - delegate to module
  function saveToLocalStorage(key, value) {
    return LocalStorage.save(key, value);
  }

  function loadFromLocalStorage(key, defaultValue) {
    return LocalStorage.load(key, defaultValue);
  }

  // API functions - provided by ApiClient module (aliased as 'api' above)

  // Frontend error logging to backend
  function logFrontendError(message, source, line, column, errorObj, errorType) {
    // Add client ID and error type to the error data
    ApiClient.logFrontendError(message, source, line, column, errorObj, state.selectedProjectId, {
      clientId: state.clientId,
      errorType: errorType || 'runtime'
    });

    // Also broadcast via WebSocket for multi-client debugging
    if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
      state.websocket.send(JSON.stringify({
        type: 'frontend_error',
        data: {
          clientId: state.clientId,
          message: message,
          source: source,
          line: line,
          column: column,
          stack: errorObj && errorObj.stack ? errorObj.stack : null,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString(),
          errorType: errorType || 'runtime',
          projectId: state.selectedProjectId
        }
      }));
    }
  }

  // Set up global error handlers
  window.onerror = function(message, source, line, column, error) {
    logFrontendError(message, source, line, column, error);
    // Return false to allow default error handling
    return false;
  };

  window.onunhandledrejection = function(event) {
    var reason = event.reason;
    var message = reason instanceof Error ? reason.message : String(reason);
    var stack = reason instanceof Error ? reason.stack : null;
    logFrontendError('Unhandled Promise Rejection: ' + message, null, null, null, { stack: stack });
  };

  // Error code to user-friendly message mapping
  var ERROR_MESSAGES = {
    'NOT_FOUND': 'The requested resource was not found',
    'VALIDATION_ERROR': 'Please check your input and try again',
    'CONFLICT': 'This action conflicts with the current state',
    'INTERNAL_ERROR': 'An unexpected error occurred. Please try again later',
    'NETWORK_ERROR': 'Unable to connect to the server. Please check your connection',
    'TIMEOUT': 'The request timed out. Please try again'
  };

  function getErrorMessage(xhr) {
    if (xhr.status === 0) {
      return ERROR_MESSAGES.NETWORK_ERROR;
    }

    if (xhr.responseJSON) {
      var response = xhr.responseJSON;

      if (response.error) {
        return response.error;
      }

      if (response.code && ERROR_MESSAGES[response.code]) {
        return ERROR_MESSAGES[response.code];
      }
    }

    switch (xhr.status) {
      case 400: return 'Invalid request. Please check your input';
      case 404: return 'The requested resource was not found';
      case 409: return 'This action conflicts with the current state';
      case 500: return 'Server error. Please try again later';
      case 503: return 'Service temporarily unavailable';
      default: return 'An error occurred. Please try again';
    }
  }

  // Toast notifications
  function showToast(message, type) {
    type = type || 'info';
    var $toast = $('<div class="toast ' + type + '">' + escapeHtml(message) + '</div>');
    $('#toast-container').append($toast);

    setTimeout(function() {
      $toast.fadeOut(200, function() { $(this).remove(); });
    }, 3000);
  }

  function showErrorToast(xhr, defaultMessage) {
    var message = getErrorMessage(xhr) || defaultMessage || 'An error occurred';
    showToast(message, 'error');
  }

  // ============================================================
  // Mermaid Diagram Helper Functions
  // ============================================================

  function copyMermaidDiagram(svgElement) {
    var svgData = new XMLSerializer().serializeToString(svgElement);

    // Use existing copyToClipboard function
    copyToClipboard(svgData);
  }

  function saveMermaidAsImage(svgElement, diagramId) {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');

    // Get SVG data
    var svgData = new XMLSerializer().serializeToString(svgElement);
    var svgSize = svgElement.getBoundingClientRect();

    // Set canvas size
    canvas.width = svgSize.width * 2; // 2x for better quality
    canvas.height = svgSize.height * 2;
    ctx.scale(2, 2);

    // Create image
    var img = new Image();
    var svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(svgBlob);

    img.onload = function() {
      // White background
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw image
      ctx.drawImage(img, 0, 0);

      // Convert to PNG and download
      canvas.toBlob(function(blob) {
        var link = document.createElement('a');
        link.download = 'mermaid-diagram-' + (diagramId || Date.now()) + '.png';
        link.href = URL.createObjectURL(blob);
        link.click();

        // Cleanup
        URL.revokeObjectURL(url);
        URL.revokeObjectURL(link.href);

        showToast('Diagram saved as image', 'success');
      }, 'image/png');
    };

    img.onerror = function() {
      showToast('Failed to save diagram', 'error');
      URL.revokeObjectURL(url);
    };

    img.src = url;
  }

  function openMermaidInNewTab(svgElement) {
    var svgData = new XMLSerializer().serializeToString(svgElement);

    // Create full HTML document with styling
    var html = '<!DOCTYPE html><html><head>' +
      '<title>Mermaid Diagram</title>' +
      '<style>' +
      'body { margin: 20px; background: #1a202c; display: flex; justify-content: center; align-items: center; min-height: 100vh; }' +
      'svg { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }' +
      '</style></head><body>' + svgData + '</body></html>';

    var blob = new Blob([html], { type: 'text/html' });
    var url = URL.createObjectURL(blob);

    window.open(url, '_blank');

    // Cleanup URL after a delay
    setTimeout(function() {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // Use module function
  var escapeHtml = EscapeUtils.escapeHtml;

  // ============================================================
  // Custom Modal Dialogs (replacing alert/confirm/prompt)
  // ============================================================

  // Show a confirmation modal and return a promise
  function showConfirm(title, message, options) {
    options = options || {};
    var confirmText = options.confirmText || 'Confirm';
    var confirmClass = options.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-purple-600 hover:bg-purple-700';

    return new Promise(function(resolve) {
      $('#confirm-modal-title').text(title);
      $('#confirm-modal-message').text(message);
      $('#confirm-modal-ok').text(confirmText).removeClass('bg-red-600 hover:bg-red-700 bg-purple-600 hover:bg-purple-700').addClass(confirmClass);

      var cleanup = function() {
        $('#confirm-modal-ok').off('click.confirm');
        $('#confirm-modal-cancel').off('click.confirm');
        $('#modal-confirm .modal-close').off('click.confirm');
        $('#modal-confirm').addClass('hidden');
      };

      $('#confirm-modal-ok').on('click.confirm', function() {
        cleanup();
        resolve(true);
      });

      $('#confirm-modal-cancel, #modal-confirm .modal-close').on('click.confirm', function() {
        cleanup();
        resolve(false);
      });

      $('#modal-confirm').removeClass('hidden');
    });
  }

  // Show a prompt modal and return a promise with the input value (or null if cancelled)
  function showPrompt(title, label, options) {
    options = options || {};
    var placeholder = options.placeholder || '';
    var defaultValue = options.defaultValue || '';
    var submitText = options.submitText || 'OK';

    return new Promise(function(resolve) {
      $('#prompt-modal-title').text(title);
      $('#prompt-modal-label').text(label);
      $('#prompt-modal-input').val(defaultValue).attr('placeholder', placeholder);
      $('#prompt-modal-ok').text(submitText);

      var cleanup = function() {
        $('#form-prompt').off('submit.prompt');
        $('#modal-prompt .modal-close').off('click.prompt');
        $('#modal-prompt').addClass('hidden');
      };

      $('#form-prompt').on('submit.prompt', function(e) {
        e.preventDefault();
        var value = $('#prompt-modal-input').val().trim();
        cleanup();
        resolve(value || null);
      });

      $('#modal-prompt .modal-close').on('click.prompt', function() {
        cleanup();
        resolve(null);
      });

      $('#modal-prompt').removeClass('hidden');
      $('#prompt-modal-input').focus();
    });
  }

  // Check for unsaved MCP changes and show confirmation dialog
  function checkUnsavedMcpChanges() {
    // If no unsaved changes, allow close immediately
    if (!state.hasUnsavedMcpChanges) {
      return Promise.resolve(true);
    }

    // Show confirmation dialog
    return new Promise(function(resolve) {
      $('#modal-unsaved-changes').removeClass('hidden');

      var cleanup = function() {
        $('#btn-unsaved-save').off('click.unsaved');
        $('#btn-unsaved-discard').off('click.unsaved');
        $('#btn-unsaved-cancel').off('click.unsaved');
        $('#modal-unsaved-changes').addClass('hidden');
      };

      // Save & Close - save settings then close
      $('#btn-unsaved-save').on('click.unsaved', function() {
        cleanup();
        handleSaveSettings($('#form-settings'));
        resolve(true);
      });

      // Discard - reset state and close
      $('#btn-unsaved-discard').on('click.unsaved', function() {
        cleanup();
        state.hasUnsavedMcpChanges = false;
        $('#mcp-unsaved-warning').addClass('hidden');
        // Reload MCP settings to discard in-memory changes
        if (state.settings && state.settings.mcp) {
          McpSettingsModule.loadSettings(state.settings.mcp);
        }
        resolve(true);
      });

      // Cancel - stay in modal
      $('#btn-unsaved-cancel').on('click.unsaved', function() {
        cleanup();
        resolve(false);
      });
    });
  }

  // ============================================================
  // Search functionality
  // ============================================================

  // Use module function
  var escapeRegExp = EscapeUtils.escapeRegExp;

  // Search functions are now in SearchModule

  // File cache functions are now in FileCache module

  // Modal functions
  function openModal(modalId) {
    $('#' + modalId).removeClass('hidden');
  }

  function closeModal(modalId) {
    var $modal = $('#' + modalId);
    $modal.addClass('hidden');

    // Trigger close event for modals that need cleanup
    if (modalId === 'modal-debug') {
      DebugModal.close();
    }
  }

  function closeAllModals() {
    // Check if settings modal is open and has unsaved MCP changes
    if (!$('#modal-settings').hasClass('hidden') && state.hasUnsavedMcpChanges) {
      checkUnsavedMcpChanges().then(function(shouldClose) {
        if (shouldClose) {
          doCloseAllModals();
        }
      });
    } else {
      doCloseAllModals();
    }
  }

  // Extract the actual close logic
  function doCloseAllModals() {
    $('.modal').addClass('hidden');

    // Reset Claude files modal mobile view
    FileBrowser.hideMobileClaudeFileEditor();

    // Clean up debug modal if it was open
    if (state.debugPanelOpen) {
      DebugModal.close();
    }
  }

  var TOOLBAR_DROPDOWNS = ['optimizations-dropdown', 'github-dropdown'];

  function toggleToolbarDropdown(dropdownId, $btn) {
    var $dropdown = $('#' + dropdownId);
    var isOpen = !$dropdown.hasClass('hidden');

    closeAllToolbarDropdowns();
    QuickActionsModule.closeQuickActions();

    if (!isOpen) {
      var offset = $btn.offset();
      $dropdown.css({
        top: offset.top + $btn.outerHeight() + 4,
        left: offset.left
      });
      $dropdown.removeClass('hidden');
    }
  }

  function closeAllToolbarDropdowns() {
    for (var i = 0; i < TOOLBAR_DROPDOWNS.length; i++) {
      $('#' + TOOLBAR_DROPDOWNS[i]).addClass('hidden');
    }
  }

  function openToolDetailModal(toolData) {
    var $modal = $('#modal-tool-detail');
    var $content = $('#tool-detail-content');
    var $name = $('#tool-detail-name');
    var $icon = $('#tool-detail-icon');
    var $status = $('#tool-detail-status');

    // Set header
    $name.text(toolData.name);
    $icon.html(ToolRenderer.getToolIcon(toolData.name));
    $status.removeClass('running completed failed').addClass(toolData.status);

    // Render full tool details
    var html = ToolRenderer.renderToolArgs(toolData.name, toolData.input);

    if (toolData.resultContent) {
      html += '<div class="border-t border-gray-700 mt-3 pt-3">' +
        '<h4 class="text-sm font-medium text-gray-400 mb-2">Result Output</h4>' +
        '<pre class="whitespace-pre-wrap text-xs text-gray-300 bg-gray-800 p-3 rounded max-h-96 overflow-y-auto">' +
        escapeHtml(toolData.resultContent) + '</pre>' +
        '</div>';
    }

    $content.html(html);

    openModal('modal-tool-detail');
  }

  // Use module functions
  var formatFileSize = Formatters.formatFileSize;
  var formatBytes = Formatters.formatBytes;
  var formatNumber = Formatters.formatNumberCompact;

  // Modal functions are now in ModalsModule

  // Project card rendering
  function renderProjectCard(project) {
    var statusClass = project.status || 'stopped';
    var statusText = capitalizeFirst(statusClass);
    var quickActions = renderQuickActions(project);
    var isWaiting = project.isWaitingForInput || false;
    var waitingClass = isWaiting ? ' waiting-for-input' : '';
    var waitingIndicator = isWaiting ? '<span class="waiting-indicator" title="Waiting for your input"></span>' : '';

    return '<div class="project-card' + waitingClass + '" data-id="' + project.id + '">' +
      '<div class="flex justify-between items-start">' +
        '<div class="project-card-name flex-1 truncate">' + escapeHtml(project.name) + '</div>' +
        quickActions +
      '</div>' +
      '<div class="project-card-path">' + escapeHtml(project.path) + '</div>' +
      '<div class="project-card-status">' +
        '<span class="status-badge ' + statusClass + '">' + statusText + '</span>' +
        waitingIndicator +
        (statusClass === 'running' && !isWaiting ? '<span class="running-indicator"></span>' : '') +
      '</div>' +
    '</div>';
  }

  function renderQuickActions(project) {
    var status = project.status || 'stopped';
    var deleteBtn = '<button class="quick-action delete" data-action="delete" data-id="' + project.id + '" title="Delete">' +
      '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>';

    // Show cancel button for queued status
    if (status === 'queued') {
      return '<div class="flex gap-1">' +
        '<button class="quick-action cancel" data-action="cancel" data-id="' + project.id + '" title="Cancel">' +
        '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></button>' +
        '</div>';
    }

    // Only delete button in sidebar (no start/stop buttons)
    return '<div class="flex gap-1">' + deleteBtn + '</div>';
  }

  function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // Project list rendering
  function sortProjects(projects) {
    return projects.slice().sort(function(a, b) {
      var aRunning = a.status === 'running' || a.status === 'queued';
      var bRunning = b.status === 'running' || b.status === 'queued';

      if (aRunning && !bRunning) return -1;
      if (!aRunning && bRunning) return 1;

      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }

  function renderProjectList() {
    var $list = $('#project-list');
    $list.empty();

    if (state.projects.length === 0) {
      $list.html('<div class="text-gray-500 text-sm text-center p-4">No projects yet</div>');

      // Also update overview if visible
      if (!state.selectedProjectId) {
        renderProjectOverview();
      }

      return;
    }

    // Get search filter
    var searchQuery = (state.projectSearchQuery || '').toLowerCase().trim();

    // Filter projects by search query
    var filteredProjects = state.projects;

    if (searchQuery) {
      filteredProjects = state.projects.filter(function(project) {
        return project.name.toLowerCase().includes(searchQuery);
      });
    }

    if (filteredProjects.length === 0) {
      $list.html('<div class="text-gray-500 text-sm text-center p-4">No matching projects</div>');
      updateRunningCount();
      return;
    }

    // Separate running/queued from stopped projects
    var activeProjects = filteredProjects.filter(function(p) {
      return p.status === 'running' || p.status === 'queued';
    }).sort(function(a, b) {
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    var stoppedProjects = filteredProjects.filter(function(p) {
      return p.status !== 'running' && p.status !== 'queued';
    }).sort(function(a, b) {
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    // Render active projects
    if (activeProjects.length > 0) {
      $list.append('<div class="text-xs text-gray-500 uppercase tracking-wider px-2 py-1">Active</div>');
      activeProjects.forEach(function(project) {
        $list.append(renderProjectCard(project));
      });
    }

    // Render separator and stopped projects
    if (stoppedProjects.length > 0) {
      if (activeProjects.length > 0) {
        $list.append('<div class="border-t border-gray-700 my-2"></div>');
      }
      $list.append('<div class="text-xs text-gray-500 uppercase tracking-wider px-2 py-1">Stopped</div>');
      stoppedProjects.forEach(function(project) {
        $list.append(renderProjectCard(project));
      });
    }

    updateSelectedProject();
    updateRunningCount();

    // Also update overview if visible (no project selected)
    if (!state.selectedProjectId) {
      renderProjectOverview();
    }
  }

  function updateSelectedProject() {
    $('.project-card').removeClass('selected');

    if (state.selectedProjectId) {
      $('.project-card[data-id="' + state.selectedProjectId + '"]').addClass('selected');
    }
  }

  function updateRunningCount() {
    var count = state.projects.filter(function(p) { return p.status === 'running'; }).length;
    var queuedCount = state.projects.filter(function(p) { return p.status === 'queued'; }).length;

    $('#running-count').text(count);
    $('#max-concurrent').text(state.resourceStatus.maxConcurrent);
    $('#queued-count').text(queuedCount);

    if (queuedCount > 0) {
      $('#queue-info').removeClass('hidden');
    } else {
      $('#queue-info').addClass('hidden');
    }
  }

  function updateResourceStatus(resourceStatus) {
    state.resourceStatus = resourceStatus;
    $('#max-concurrent').text(resourceStatus.maxConcurrent);
    $('#running-count').text(resourceStatus.runningCount);
    $('#queued-count').text(resourceStatus.queuedCount);

    if (resourceStatus.queuedCount > 0) {
      $('#queue-info').removeClass('hidden');
    } else {
      $('#queue-info').addClass('hidden');
    }
  }

  function updateSlackButtonVisibility() {
    var slackEnabled = state.settings && state.settings.slack && state.settings.slack.enabled === true;

    if (state.selectedProjectId && slackEnabled) {
      $('#btn-project-slack').removeClass('hidden');
    } else {
      $('#btn-project-slack').addClass('hidden');
    }
  }

  function updateEmailButtonVisibility() {
    var emailEnabled = state.settings && state.settings.email && state.settings.email.enabled === true;
    if (emailEnabled) {
      $('body').addClass('email-enabled');
      $('.msg-email-btn').css('display', 'flex');
    } else {
      $('body').removeClass('email-enabled');
      $('.msg-email-btn').css('display', 'none');
    }
  }

  // Project detail rendering
  function renderProjectDetail(project) {
    if (!project) {
      $('#project-detail').addClass('hidden');
      $('#empty-state').removeClass('hidden');
      $('#btn-project-mcp').addClass('hidden');
      $('#btn-project-slack').addClass('hidden');
      renderProjectOverview();
      return;
    }

    $('#empty-state').addClass('hidden');
    $('#project-detail').removeClass('hidden');
    $('#btn-project-mcp').removeClass('hidden');
    updateSlackButtonVisibility();

    $('#project-name').text(project.name);
    $('#mobile-project-name').text(project.name).removeClass('hidden');

    updateProjectStatus(project);
    renderConversation(project.id);
  }

  function renderProjectOverview() {
    var $overview = $('#project-overview');

    if (state.projects.length === 0) {
      $overview.html(
        '<div class="flex flex-col items-center justify-center h-full text-center">' +
          '<svg class="w-16 h-16 text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>' +
          '</svg>' +
          '<h2 class="text-xl font-semibold text-gray-400 mb-2">No Projects Yet</h2>' +
          '<p class="text-sm text-gray-500 mb-4">Create your first project to get started</p>' +
          '<button id="btn-add-project-overview" class="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm">' +
            'Add Project' +
          '</button>' +
        '</div>'
      );

      $('#btn-add-project-overview').on('click', function() {
        $('#modal-add-project').removeClass('hidden');
      });
      return;
    }

    var html = '<div class="mb-6">' +
      '<h2 class="text-xl font-semibold text-white mb-1">Projects</h2>' +
      '<p class="text-sm text-gray-400">Select a project to start working</p>' +
    '</div>';

    html += '<div class="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">';

    var sortedProjects = sortProjects(state.projects);
    sortedProjects.forEach(function(project) {
      html += renderProjectOverviewCard(project);
    });

    html += '</div>';

    $overview.html(html);

    // Attach click handlers for overview cards
    $overview.find('.project-overview-card').on('click', function(e) {
      if ($(e.target).closest('.overview-action').length) return;
      var projectId = $(this).data('id');
      selectProject(projectId);
    });

    $overview.find('.overview-action[data-action="delete"]').on('click', function(e) {
      e.stopPropagation();
      var projectId = $(this).data('id');
      state.pendingDeleteId = projectId;
      var project = findProjectById(projectId);
      $('#delete-project-name').text(project ? project.name : 'Unknown');
      $('#modal-delete-project').removeClass('hidden');
    });

    $overview.find('.overview-action[data-action="start"]').on('click', function(e) {
      e.stopPropagation();
      var projectId = $(this).data('id');
      selectProject(projectId);
    });
  }

  function renderProjectOverviewCard(project) {
    var statusClass = project.status || 'stopped';
    var statusText = capitalizeFirst(statusClass);
    var isWaiting = project.isWaitingForInput || false;
    var waitingClass = isWaiting ? ' waiting-for-input' : '';

    var waitingIndicator = isWaiting ?
      '<span class="ml-2 text-yellow-400 text-xs">(waiting for input)</span>' : '';

    var runningIndicator = (statusClass === 'running' && !isWaiting) ?
      '<span class="running-indicator ml-2"></span>' : '';

    var actionButton = '';

    if (statusClass === 'stopped') {
      actionButton = '<button class="overview-action text-gray-400 hover:text-green-400 p-1" data-action="start" data-id="' + project.id + '" title="Open Project">' +
        '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>' +
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>' +
        '</svg>' +
      '</button>';
    }

    var deleteButton = '<button class="overview-action text-gray-400 hover:text-red-400 p-1" data-action="delete" data-id="' + project.id + '" title="Delete Project">' +
      '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>' +
      '</svg>' +
    '</button>';

    return '<div class="project-overview-card bg-gray-800 rounded-lg p-4 cursor-pointer hover:bg-gray-750 transition-colors border border-gray-700 hover:border-gray-600' + waitingClass + '" data-id="' + project.id + '">' +
      '<div class="flex justify-between items-start mb-2">' +
        '<h3 class="font-semibold text-white truncate flex-1">' + escapeHtml(project.name) + '</h3>' +
        '<div class="flex items-center gap-1 ml-2">' +
          actionButton +
          deleteButton +
        '</div>' +
      '</div>' +
      '<div class="text-xs text-gray-400 truncate mb-3" title="' + escapeHtml(project.path) + '">' +
        '<svg class="w-3 h-3 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>' +
        '</svg>' +
        escapeHtml(project.path) +
      '</div>' +
      '<div class="flex items-center">' +
        '<span class="status-badge ' + statusClass + '">' + statusText + '</span>' +
        waitingIndicator +
        runningIndicator +
      '</div>' +
    '</div>';
  }

  function updateProjectStatus(project) {
    var statusClass = project.status || 'stopped';
    var $badge = $('#project-status');

    $badge.removeClass('stopped running error queued')
          .addClass(statusClass)
          .text(capitalizeFirst(statusClass));

    if (statusClass === 'running') {
    } else if (statusClass === 'queued') {
    } else {
      state.currentAgentMode = null;
    }

    updateStartStopButtons();
    updateInputArea();
  }

  // Conversation rendering
  function renderConversation(projectId) {
    var $conv = $('#conversation');
    var messages = state.conversations[projectId] || [];

    $conv.empty();

    // Filter messages based on debug mode and type
    var filteredMessages = messages.filter(function(msg) {
      // Skip debug messages unless debug panel is open
      if (isDebugMessage(msg) && !state.debugPanelOpen) {
        return false;
      }

      // Skip tool_result messages - they update tool status, not displayed separately
      if (msg.type === 'tool_result') {
        return false;
      }

      // Skip legacy "Session ID: xxx" system messages saved in old conversations
      if (isSessionIdMessage(msg)) {
        return false;
      }

      return true;
    });

    if (filteredMessages.length === 0) {
      $conv.html('<div class="text-gray-500 text-center">No conversation yet</div>');
      return;
    }

    // Reset timestamp context for time differences
    MessageRenderer.resetRenderingContext();

    var emailEnabled = state.settings && state.settings.email && state.settings.email.enabled === true;
    filteredMessages.forEach(function(msg) {
      var $msg = $(MessageRenderer.renderMessage(msg));
      var $emailBtn = $msg.find('.msg-email-btn');
      $emailBtn.css('display', emailEnabled ? 'flex' : 'none');
      if (msg.timestamp) {
        var sentKey = 'email-sent:' + (state.selectedProjectId || '') + ':' + msg.timestamp;
        try { if (localStorage.getItem(sentKey)) $emailBtn.addClass('sent'); } catch(e) {}
      }
      $conv.append($msg);
    });

    // Inject mermaid toolbars after rendering all messages
    if (MessageRenderer.injectMermaidToolbars) {
      MessageRenderer.injectMermaidToolbars();
    }

    restorePromptState(messages);
    updateLastRequestBar();

    // Force scroll to bottom on full render, ignoring scroll lock.
    // Scroll lock is for live sessions only (user scrolled up to read history);
    // when we render the whole conversation from scratch we always want the latest.
    var prevLock = state.agentOutputScrollLock;
    state.agentOutputScrollLock = false;
    scrollConversationToBottom();
    state.agentOutputScrollLock = prevLock;

    // Re-scroll after a short delay to catch async content (Mermaid diagrams,
    // images) that increases scrollHeight after the initial render.
    setTimeout(function() {
      if (!state.agentOutputScrollLock) {
        var $c = $('#conversation-container');
        if ($c.length) $c.scrollTop($c[0].scrollHeight);
      }
    }, 300);
  }

  function restorePromptState(messages) {
    if (!messages || messages.length === 0) return;

    extractPlanFileFromMessages(messages);

    var pendingType = findPendingPromptType(messages);

    if (!pendingType) return;

    // Only restore blocking state when the agent is currently running.
    // Stale plan_mode/question prompts from ended sessions should not block input.
    var project = findProjectById(state.selectedProjectId);
    if (!project || project.status !== 'running') return;

    // The plan_mode message stays in the conversation after the plan is resolved,
    // so replaying it on reload would re-block a composer the server now accepts.
    // The server's hasPendingPlan is the authority.
    if (pendingType === 'plan_mode' && state.hasPendingPlan === false) return;

    setPromptHintState(pendingType);

    if (pendingType === 'plan_mode') {
      var $planContainer = $('.plan-content-container').last();

      if ($planContainer.length > 0) {
        loadPlanContent($planContainer);
      }
    }
  }

  function extractPlanFileFromMessages(messages) {
    for (var i = messages.length - 1; i >= 0; i--) {
      var msg = messages[i];

      if (msg.type !== 'tool_use' || !msg.toolInfo) continue;
      if (msg.toolInfo.name !== 'Write' && msg.toolInfo.name !== 'Edit') continue;
      if (!msg.toolInfo.input || !msg.toolInfo.input.file_path) continue;

      var filePath = msg.toolInfo.input.file_path;

      if (filePath.includes('plans') && filePath.endsWith('.md')) {
        state.currentPlanFile = filePath;
        return;
      }
    }
  }

  function findPendingPromptType(messages) {
    for (var i = messages.length - 1; i >= 0; i--) {
      var msg = messages[i];

      if (msg.type === 'plan_mode' && msg.planModeInfo &&
          msg.planModeInfo.action === 'exit') {
        return 'plan_mode';
      }

      if (msg.type === 'question') return 'question';
      if (msg.type === 'permission') return 'permission';

      if (msg.type === 'tool_use' && msg.toolInfo &&
          msg.toolInfo.name === 'AskUserQuestion' &&
          msg.toolInfo.status !== 'completed') {
        return 'askuser';
      }

      // If we hit a user/assistant/result message, no pending prompt
      if (msg.type === 'user' || msg.type === 'result' ||
          msg.type === 'assistant') {
        return null;
      }
    }

    return null;
  }

  // Message rendering functions are now in MessageRenderer module

  function truncateString(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
  }

  /**
   * Refresh the pinned "last request" bar with the most recent user message of
   * the selected project. CSS handles the one-line + ellipsis; the full text
   * goes into the title attribute for hover.
   */
  function updateConversationNameBar() {
    var $bar = $('#conversation-name-bar');
    if (!$bar.length) return;

    var label = state.currentConversationLabel;
    if (!label) {
      $bar.addClass('hidden');
      $bar.find('.conversation-name-text').text('');
      return;
    }

    $bar.removeClass('hidden');
    $bar.find('.conversation-name-text').text(label);
  }

  function updateLastRequestBar() {
    updateConversationNameBar();

    var $bar = $('#last-request-bar');
    if (!$bar.length) return;

    var messages = state.conversations[state.selectedProjectId] || [];
    var lastUser = null;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user' && messages[i].content) {
        lastUser = messages[i];
        break;
      }
    }

    if (!lastUser) {
      $bar.addClass('hidden').attr('title', '');
      $bar.find('.last-request-text').text('');
      return;
    }

    var oneLine = String(lastUser.content).replace(/\s+/g, ' ').trim();
    $bar.removeClass('hidden').attr('title', oneLine).css('cursor', 'pointer');
    $bar.find('.last-request-text').text(oneLine);
  }

  $(document).on('click', '#last-request-bar', function() {
    var $msgs = $('#conversation-container').find('.conversation-message[data-msg-type="user"]');
    if (!$msgs.length) return;
    var $target = $msgs.last();
    var container = document.getElementById('conversation-container');
    if (!container) return;
    container.scrollTo({ top: $target[0].offsetTop - container.offsetTop - 8, behavior: 'smooth' });
    $target.addClass('msg-highlight');
    setTimeout(function() { $target.removeClass('msg-highlight'); }, 1800);
  });

  function scrollConversationToBottom() {
    if (state.agentOutputScrollLock) {
      // Show "new messages" badge on scroll-to-bottom button
      var $btn = $('#btn-scroll-bottom');
      $btn.removeClass('hidden');

      if (!$btn.find('.new-msg-badge').length) {
        $btn.append('<span class="new-msg-badge absolute -top-1 -right-1 w-3 h-3 bg-purple-500 rounded-full animate-pulse"></span>');
      }

      return;
    }

    var $container = $('#conversation-container');
    $container.scrollTop($container[0].scrollHeight);
  }

  // Check if a message is a debug/system message that should only show in debug mode
  function isDebugMessage(message) {
    // Only messages explicitly marked as debug should be hidden
    return message.isDebug === true;
  }

  // Legacy "Session ID: xxx" system messages were saved into older conversations
  // before the session ID was moved off-screen. Hide them on render.
  function isSessionIdMessage(message) {
    return message
      && message.type === 'system'
      && typeof message.content === 'string'
      && message.content.indexOf('Session ID:') === 0;
  }

  // Defined in utils.js (loaded before this file) so it can be unit tested; see the
  // note there for why the key is not just timestamp + type.
  var messageIdentity = Utils.messageIdentity;

  function appendMessage(projectId, message) {
    if (!state.conversations[projectId]) {
      state.conversations[projectId] = [];
    }

    // Deduplicate: skip a message we already have (loadConversationHistory can
    // race with a WebSocket agent_message).
    //
    // The key used to be just timestamp + type. Timestamps are millisecond
    // precision, so two *different* messages of the same type produced in the same
    // millisecond — routine when Claude issues parallel tool calls — collided and
    // the second was silently dropped from the view while the server had saved
    // both. The output reappeared on refresh, which is indistinguishable from the
    // agent having stalled. Identity now includes the tool id or the content, so
    // only a genuine re-delivery is discarded.
    if (message.timestamp && message.type) {
      var conv = state.conversations[projectId];
      var key = messageIdentity(message);
      var recentKeys = conv.slice(-20).map(messageIdentity);
      if (recentKeys.indexOf(key) !== -1) {
        return;
      }
    }

    state.conversations[projectId].push(message);

    // Update real-time stats
    updateStatsFromMessage(message);

    // Cache Read tool file paths for diff comparison with Write
    if (message.type === 'tool_use' && message.toolInfo) {
      var toolInfo = message.toolInfo;

      if (toolInfo.name === 'Read' && toolInfo.input && toolInfo.input.file_path) {
        FileCache.cacheFile(toolInfo.input.file_path);
      }

      // Track TodoWrite tool calls to update task state
      if (toolInfo.name === 'TodoWrite' && toolInfo.input) {
        TaskDisplayModule.updateCurrentTodos(toolInfo.input);
      }

      // Track Write and Edit tool calls to plan files (for ExitPlanMode)
      if ((toolInfo.name === 'Write' || toolInfo.name === 'Edit') &&
          toolInfo.input && toolInfo.input.file_path) {
        var filePath = toolInfo.input.file_path;

        if (filePath.includes('plans') && filePath.endsWith('.md')) {
          state.currentPlanFile = filePath;

          // Reload plan content if approval prompt is visible
          var $planContainer = $('.plan-content-container');

          if ($planContainer.length > 0) {
            loadPlanContent($planContainer);
          }
        }
      }

      // NOTE: AskUserQuestion blocking is armed further down, inside the
      // selected-project branch. Arming it here disabled the composer of the
      // project the user was looking at because a *different* project asked a
      // question — a card that is not even on screen to answer.
    }

    if (state.selectedProjectId === projectId) {
      // Skip debug messages unless debug panel is open
      if (isDebugMessage(message) && !state.debugPanelOpen) {
        return;
      }

      // Handle tool_result messages - update specific tool status
      if (message.type === 'tool_result' && message.toolInfo) {
        ToolRenderer.updateToolStatus(
          message.toolInfo.id,
          message.toolInfo.status || 'completed',
          message.toolInfo.output || message.toolInfo.resultContent
        );
        return; // Don't render tool_result as a separate message
      }

      // Mark previous running tools as completed when non-tool content arrives
      if (message.type !== 'tool_use' && message.type !== 'user' && message.type !== 'tool_result') {
        markRunningToolsComplete();
      }

      var $conv = $('#conversation');

      // Clear "No conversation yet" placeholder if present
      if ($conv.find('.text-gray-500.text-center').length > 0) {
        $conv.empty();
        // Reset context when starting fresh conversation
        MessageRenderer.resetRenderingContext();
      } else {
        // Set context to last message's timestamp for time differences
        var conversation = state.conversations[state.selectedProjectId];
        if (conversation && conversation.length > 1) {
          var lastMessage = conversation[conversation.length - 2]; // -2 because current message is already added
          if (lastMessage && lastMessage.timestamp) {
            MessageRenderer.setStartingTimestamp(lastMessage.timestamp);
          }
        }
      }

      // Defer ExitPlanMode message when questions are still pending
      if (message.type === 'plan_mode' && message.planModeInfo && message.planModeInfo.action === 'exit' &&
          state.activePromptType === 'askuser') {
        state.deferredPlanMessage = message;
        return;
      }

      var $rendered = $(MessageRenderer.renderMessage(message));
      $conv.append($rendered);

      // Apply email button visibility to newly added message
      var emailEnabled = state.settings && state.settings.email && state.settings.email.enabled === true;
      var $emailBtn = $rendered.find('.msg-email-btn');
      $emailBtn.css('display', emailEnabled ? 'flex' : 'none');
      if (message.timestamp) {
        var sentKey = 'email-sent:' + (state.selectedProjectId || '') + ':' + message.timestamp;
        try { if (localStorage.getItem(sentKey)) $emailBtn.addClass('sent'); } catch(e) {}
      }

      // Inject mermaid toolbars if message contains mermaid diagrams
      if (MessageRenderer.injectMermaidToolbars) {
        MessageRenderer.injectMermaidToolbars();
      }

      // Load plan content for exit plan mode messages
      if (message.type === 'plan_mode' && message.planModeInfo && message.planModeInfo.action === 'exit') {
        loadPlanContent($rendered.find('.plan-content-container'));
      }

      // Block input when interactive prompts appear
      if (message.type === 'question' || message.type === 'permission') {
        setPromptHintState(message.type);
      }

      // Live AskUserQuestion for the project on screen — the card was just
      // rendered above, so there is something to answer.
      if (message.type === 'tool_use' && message.toolInfo &&
          message.toolInfo.name === 'AskUserQuestion' &&
          message.toolInfo.status !== 'completed') {
        setPromptHintState('askuser');
      }

      if (message.type === 'plan_mode' && message.planModeInfo && message.planModeInfo.action === 'exit') {
        setPromptHintState('plan_mode');
        state.lastPlanContent = message.planModeInfo.planContent || '';
      }

      // Block input during compaction
      if (message.type === 'status_change' && message.statusChangeInfo) {
        if (message.statusChangeInfo.status === 'compacting') {
          setPromptHintState('compacting');
        }
      }

      // Unblock input after compaction completes (compaction message follows status_change)
      if (message.type === 'compaction' && state.activePromptType === 'compacting') {
        setPromptHintState(null);
      }

      // Refresh the pinned last-request bar when the user sends a message
      if (message.type === 'user') {
        updateLastRequestBar();
      }

      scrollConversationToBottom();
      // Re-scroll after async content (Mermaid diagrams) finishes rendering
      setTimeout(function() {
        if (!state.agentOutputScrollLock) {
          var $c = $('#conversation-container');
          if ($c.length) $c.scrollTop($c[0].scrollHeight);
        }
      }, 300);
    }
  }

  function loadPlanContent($container) {
    if (!state.currentPlanFile) {
      $container.html('<div class="text-gray-500 text-sm italic">Plan file path not found</div>');
      return;
    }

    $container.html('<div class="text-gray-400 text-sm"><span class="loading-dots">Loading plan</span></div>');

    api.readFile(state.currentPlanFile)
      .done(function(data) {
        var content = data.content || '';

        if (!content.trim()) {
          $container.html('<div class="text-gray-500 text-sm italic">Plan file is empty</div>');
          return;
        }

        // Render markdown content
        var renderedHtml = renderMarkdownContent(content);
        $container.html(
          '<div class="plan-content bg-gray-800/50 rounded p-3 border border-gray-700 max-h-96 overflow-y-auto">' +
            '<div class="prose prose-invert prose-sm max-w-none">' + renderedHtml + '</div>' +
          '</div>'
        );
      })
      .fail(function() {
        $container.html('<div class="text-red-400 text-sm">Failed to load plan file</div>');
      });
  }

  function renderMarkdownContent(content) {
    // Use MessageRenderer for consistent markdown rendering with Mermaid support
    return MessageRenderer.renderMarkdown(content);
  }

  function updateStatsFromMessage(message) {
    // Initialize stats if needed
    if (!state.currentConversationStats) {
      state.currentConversationStats = {
        messageCount: 0,
        toolCallCount: 0,
        userMessageCount: 0,
        durationMs: 0,
        startedAt: message.timestamp || new Date().toISOString()
      };
    }

    var stats = state.currentConversationStats;

    // Increment message count
    stats.messageCount++;

    // Increment tool call count
    if (message.type === 'tool_use') {
      stats.toolCallCount++;
    }

    // Increment user message count
    if (message.type === 'user') {
      stats.userMessageCount++;
    }

    // Update duration based on latest message timestamp
    if (message.timestamp && stats.startedAt) {
      var startTime = new Date(stats.startedAt).getTime();
      var endTime = new Date(message.timestamp).getTime();
      stats.durationMs = Math.max(0, endTime - startTime);
    }

    // Update the display
    ConversationHistoryModule.updateStats();
  }

  function markRunningToolsComplete() {
    $('.tool-status.running').removeClass('running').addClass('completed');
  }
  // Roadmap rendering is now in RoadmapModule

  // Debug modal functions are now in DebugModal module

  // Use module functions for date/time formatting
  var formatDateTime = Formatters.formatDateTime;
  var formatTime = Formatters.formatTime;
  var formatLogTime = Formatters.formatLogTime;

  // Folder browser functions are now in FolderBrowserModule

  // Event handlers
  function setupEventHandlers() {
    setupModalHandlers();
    setupProjectHandlers();
    setupAgentHandlers();
    setupFormHandlers();
    // FolderBrowser handlers are in FolderBrowserModule.setupHandlers()
  }

  function setupModalHandlers() {
    // WebSocket reconnect on failed status
    $('#ws-connection-status').on('click', function() {
      if ($(this).hasClass('ws-failed')) {
        manualReconnect();
      }
    });

    // Mobile menu toggle
    $('#btn-mobile-menu').on('click', function() {
      $('#sidebar').addClass('open');
      $('#mobile-menu-overlay').addClass('active');
    });

    $('#mobile-menu-overlay').on('click', function() {
      $('#sidebar').removeClass('open');
      $('#mobile-menu-overlay').removeClass('active');
    });

    // Close mobile menu when a project is selected
    $(document).on('click', '.project-card', function() {
      if ($(window).width() <= 768) {
        $('#sidebar').removeClass('open');
        $('#mobile-menu-overlay').removeClass('active');
      }
    });

    $('#btn-add-project').on('click', function() {
      openModal('modal-add-project');
    });

    $('#btn-import-github').on('click', function() {
      openGitHubReposBrowser();
    });

    $('#btn-github-list').on('click', function() {
      loadGitHubReposList();
    });

    $('#btn-github-search').on('click', function() {
      searchGitHubRepos();
    });

    $('#github-repo-search').on('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        searchGitHubRepos();
      }
    });

    $('#btn-github-clone-selected').on('click', function() {
      openGitHubCloneDialog();
    });

    $('#btn-github-browse-target').on('click', function() {
      state.folderBrowserCallback = function(selectedPath) {
        $('#github-clone-target').val(selectedPath);
      };
      FolderBrowserModule.open();
    });

    $('#btn-github-do-clone').on('click', function() {
      doGitHubClone();
    });

    // Project search input handler
    $('#project-search').on('input', function() {
      state.projectSearchQuery = $(this).val();
      renderProjectList();
    });

    $('#btn-settings').on('click', function() {
      loadAndShowSettings();
    });

    $('#btn-logout').on('click', function() {
      api.logout();
    });

    // Settings tab switching
    $(document).on('click', '.settings-tab', function() {
      var tabName = $(this).data('tab');

      // Update tab buttons
      $('.settings-tab').removeClass('active border-purple-500 text-white').addClass('border-transparent text-gray-400');
      $(this).addClass('active border-purple-500 text-white').removeClass('border-transparent text-gray-400');

      // Show/hide tab content
      $('.settings-tab-content').addClass('hidden');
      $('#settings-tab-' + tabName).removeClass('hidden');

      // Lazy-load tab data
      if (tabName === 'github') {
        loadGitHubStatus();
      }

      if (tabName === 'slack') {
        loadSlackStatus();
      }

      if (tabName === 'docker' && typeof DockerModule !== 'undefined') {
        DockerModule.onSettingsTabOpen();
      }
    });

    // GitHub tab - Refresh button
    $('#btn-refresh-github-status').on('click', function() {
      loadGitHubStatus();
    });

    // Slack tab handlers
    $('#btn-check-slack-status').on('click', function() {
      loadSlackStatus();
    });

    // Email tab handlers
    $('#btn-test-email-connection').on('click', function() {
      var $indicator = $('#email-status-indicator');
      $indicator.text('Testing...');
      $.post('/api/email/test')
        .done(function(result) {
          if (result.success) {
            $indicator.html('<span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5 align-middle"></span><span class="align-middle">Connected</span>');
          } else {
            $indicator.html('<span class="inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5 align-middle"></span><span class="align-middle">' + (result.error || 'Failed') + '</span>');
          }
        })
        .fail(function(xhr) {
          var msg = (xhr.responseJSON && xhr.responseJSON.error) || 'Not configured';
          $indicator.html('<span class="inline-block w-2 h-2 rounded-full bg-gray-500 mr-1.5 align-middle"></span><span class="align-middle">' + msg + '</span>');
        });
    });

    // Wipe All Data - open confirmation modal
    $('#btn-wipe-all-data').on('click', function() {
      $('#modal-confirm-wipe-all').removeClass('hidden');
    });

    // Wipe All Data - confirm
    $('#btn-confirm-wipe-all').on('click', function() {
      var $btn = $(this);
      $btn.prop('disabled', true).text('Wiping...');

      api.wipeAllData()
        .done(function(result) {
          closeAllModals();
          showToast('All data wiped (' + result.projectsWiped + ' projects)', 'success');
          loadProjects();
        })
        .fail(function(xhr) {
          showErrorToast(xhr, 'Failed to wipe data');
        })
        .always(function() {
          $btn.prop('disabled', false).text('Wipe All Data');
        });
    });

    // Ralph Loop Config tab switching
    $(document).on('click', '.ralph-config-tab', function() {
      var tabName = $(this).data('tab');

      // Update tab buttons
      $('.ralph-config-tab').removeClass('border-purple-500 text-white').addClass('border-transparent text-gray-400');
      $(this).addClass('border-purple-500 text-white').removeClass('border-transparent text-gray-400');

      // Show/hide content
      $('.ralph-config-tab-content').addClass('hidden');
      $('#ralph-config-tab-' + tabName).removeClass('hidden');
    });

    // Permission skip checkbox toggles other permission fields
    $('#input-skip-permissions').on('change', function() {
      updatePermissionFieldsState();
    });

    // Permission presets
    $(document).on('click', '.permission-preset', function() {
      var presetName = $(this).data('preset');
      applyPermissionPreset(presetName);
    });

    $('#btn-view-roadmap').on('click', function() {
      loadAndShowRoadmap();
    });

    $('#btn-toggle-debug').on('click', function() {
      DebugModal.open();
    });

    $('#btn-agent-mode').on('click', function() {
      if (state.isRalphLoopRunning) {
        showToast('Please stop the Ralph Loop before switching to Agent mode', 'warning');
        return;
      }
      // Switch to agent mode - hide the button
      $('#btn-agent-mode').addClass('hidden');
    });

    $('#btn-start-ralph-loop').on('click', function() {
      startRalphLoopFromModal();
    });

    // Pause button handler is dynamically set in updateRalphLoopPauseButton()

    $('#btn-ralph-loop-stop').on('click', function() {
      stopRalphLoop();
    });


    $('#btn-create-roadmap').on('click', function() {
      closeModal('modal-roadmap');
      openModal('modal-create-roadmap');
    });

    $('#btn-close-roadmap-progress').on('click', function() {
      closeModal('modal-roadmap-progress');
      loadAndShowRoadmap();
    });

    $('.modal-close').on('click', function() {
      var $modal = $(this).closest('.modal');

      if ($modal.attr('id') === 'modal-roadmap-progress' && state.roadmapGenerating) {
        return;
      }

      if ($modal.attr('id') === 'modal-settings' && state.hasUnsavedMcpChanges) {
        checkUnsavedMcpChanges().then(function(shouldClose) {
          if (shouldClose) {
            closeAllModals();
          }
        });
      } else {
        closeAllModals();
      }
    });


    // Tool message click handler - open detail modal
    $(document).on('click', '.conversation-message.tool-use', function(e) {
      // Don't open modal if clicking on ask-user-option buttons
      if ($(e.target).closest('.ask-user-option').length > 0) {
        return;
      }

      var toolId = $(this).attr('data-tool-id');
      var toolData = ToolRenderer.getToolData(toolId);

      if (toolData) {
        openToolDetailModal(toolData);
      }
    });

    // Mermaid diagram interactions
    $(document).on('click', '.mermaid-copy', function(e) {
      e.stopPropagation();
      var $wrapper = $(this).closest('.mermaid-wrapper');
      var svg = $wrapper.find('svg')[0];
      copyMermaidDiagram(svg);
    });

    $(document).on('click', '.mermaid-save', function(e) {
      e.stopPropagation();
      var $wrapper = $(this).closest('.mermaid-wrapper');
      var svg = $wrapper.find('svg')[0];
      var diagramId = $wrapper.data('diagram-id');
      saveMermaidAsImage(svg, diagramId);
    });

    $(document).on('click', '.mermaid-open', function(e) {
      e.stopPropagation();
      var $wrapper = $(this).closest('.mermaid-wrapper');
      var svg = $wrapper.find('svg')[0];
      openMermaidInNewTab(svg);
    });

    // Delete task button in roadmap
    $(document).on('click', '.btn-delete-task', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var $btn = $(this);
      state.pendingDeleteTask = {
        phaseId: $btn.data('phase-id'),
        milestoneId: $btn.data('milestone-id'),
        taskIndex: $btn.data('task-index'),
        taskTitle: $btn.data('task-title')
      };
      $('#delete-task-title').text(state.pendingDeleteTask.taskTitle);
      openModal('modal-confirm-delete-task');
    });

    $('#btn-confirm-delete-task').on('click', function() {
      confirmDeleteTask();
    });

    // Delete milestone button in roadmap
    $(document).on('click', '.btn-delete-milestone', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var $btn = $(this);
      state.pendingDeleteMilestone = {
        phaseId: $btn.data('phase-id'),
        milestoneId: $btn.data('milestone-id'),
        milestoneTitle: $btn.data('milestone-title')
      };
      $('#delete-milestone-title').text(state.pendingDeleteMilestone.milestoneTitle);
      openModal('modal-confirm-delete-milestone');
    });

    $('#btn-confirm-delete-milestone').on('click', function() {
      confirmDeleteMilestone();
    });

    // Delete phase button in roadmap
    $(document).on('click', '.btn-delete-phase', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var $btn = $(this);
      state.pendingDeletePhase = {
        phaseId: $btn.data('phase-id'),
        phaseTitle: $btn.data('phase-title')
      };
      $('#delete-phase-title').text(state.pendingDeletePhase.phaseTitle);
      openModal('modal-confirm-delete-phase');
    });

    $('#btn-confirm-delete-phase').on('click', function() {
      confirmDeletePhase();
    });


    // Font size controls for agent output
    $('#btn-font-decrease').on('click', function() {
      if (state.fontSize > 10) {
        state.fontSize -= 2;
        updateFontSize();
      }
    });

    $('#btn-font-increase').on('click', function() {
      if (state.fontSize < 24) {
        state.fontSize += 2;
        updateFontSize();
      }
    });

    // Scroll lock toggle for agent output
    $('#btn-toggle-scroll-lock').on('click', function() {
      state.agentOutputScrollLock = !state.agentOutputScrollLock;
      saveToLocalStorage(LOCAL_STORAGE_KEYS.SCROLL_LOCK, state.agentOutputScrollLock);
      updateScrollLockButton();
    });

    // Detect manual scroll in agent output
    $('#conversation-container').on('scroll', function() {
      var $container = $(this);
      var scrollTop = $container.scrollTop();
      var scrollHeight = $container[0].scrollHeight;
      var containerHeight = $container.outerHeight();
      var isNearBottom = scrollHeight - scrollTop - containerHeight < 50;
      var isNearTop = scrollTop < 50;

      if (!isNearBottom && !state.agentOutputScrollLock) {
        // User scrolled up - pause auto-scroll
        state.agentOutputScrollLock = true;
        updateScrollLockButton();
      } else if (isNearBottom && state.agentOutputScrollLock) {
        // User scrolled back to bottom - re-enable auto-scroll
        state.agentOutputScrollLock = false;
        updateScrollLockButton();
        $('#btn-scroll-bottom').find('.new-msg-badge').remove();
      }

      // Update floating scroll buttons visibility
      updateScrollFloatButtons($container, scrollTop, scrollHeight, containerHeight, isNearTop, isNearBottom);
    });

    // Floating scroll button click handlers
    $('#btn-scroll-top').on('click', function() {
      $('#conversation-container').animate({ scrollTop: 0 }, 200);
    });

    $('#btn-scroll-bottom').on('click', function() {
      var $container = $('#conversation-container');
      $container.animate({ scrollTop: $container[0].scrollHeight }, 200);
      $(this).find('.new-msg-badge').remove();
    });

    $(document).on('keydown', function(e) {
      if (e.key === 'Escape') {
        if (state.search.isOpen) {
          SearchModule.close();
        } else if (!$('#modal-settings').hasClass('hidden') && state.hasUnsavedMcpChanges) {
          checkUnsavedMcpChanges().then(function(shouldClose) {
            if (shouldClose) {
              closeAllModals();
            }
          });
        } else {
          closeAllModals();
        }
      }
    });

    // Search handlers are now in SearchModule.setupHandlers()
  }

  function loadAndShowSettings() {
    api.getSettings()
      .done(function(settings) {
        var perms = settings.claudePermissions || {};

        $('#input-max-concurrent').val(settings.maxConcurrentAgents);
        $('#input-skip-permissions').prop('checked', perms.dangerouslySkipPermissions);
        $('#input-permission-mode').val(perms.defaultMode || 'acceptEdits');
        $('#input-allow-rules').val((perms.allowRules || []).join('\n'));
        $('#input-deny-rules').val((perms.denyRules || []).join('\n'));
        $('#input-agent-prompt').val(settings.agentPromptTemplate || '');
        $('#input-append-system-prompt').val(settings.appendSystemPrompt || '');
        $('#input-send-ctrl-enter').prop('checked', settings.sendWithCtrlEnter !== false);
        $('#input-history-limit').val(settings.historyLimit || 25);
        $('#input-claude-md-max-size').val(settings.claudeMdMaxSizeKB || 50);
        $('#input-desktop-notifications').prop('checked', settings.enableDesktopNotifications || false);
        $('#input-inventify-folder').val(settings.inventifyFolder || '');
        $('#input-ralph-loop-history-limit').val(settings.ralphLoop?.historyLimit || 5);
        updatePermissionFieldsState();

        // Store settings for templates module
        state.settings = settings;
        PromptTemplatesModule.renderSettingsTab();
        updateSlackButtonVisibility();
        updateEmailButtonVisibility();

        // MCP settings
        $('#input-mcp-enabled').prop('checked', settings.mcp?.enabled !== false);
        McpSettingsModule.renderMcpServers();

        // Slack settings
        loadSlackSettingsFields(settings.slack);

        // Email settings
        loadEmailSettingsFields(settings.email);

        // Chrome state
        state.chromeEnabled = settings.chromeEnabled ?? false;
        updateChromeToggleButton();

        // Docker settings
        if (typeof DockerModule !== 'undefined') {
          DockerModule.populateSettingsFields(settings);
        }

        // Agent profiles
        if (typeof AgentProfilesModule !== 'undefined') {
          window._cachedSettings = settings;
          AgentProfilesModule.loadProfiles(settings);
        }

        openModal('modal-settings');
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to load settings');
      });
  }

  function loadGitHubStatus() {
    var $indicator = $('#github-status-indicator');
    $indicator.text('Checking...');

    $.get('/api/integrations/github/status')
      .done(function(status) {
        $indicator.html(renderGitHubStatus(status));
      })
      .fail(function() {
        $indicator.html(
          '<span class="inline-block w-2 h-2 rounded-full bg-gray-500 mr-1.5 align-middle"></span>' +
          '<span class="align-middle">Unable to check GitHub CLI status</span>'
        );
      });
  }

  function renderGitHubStatus(status) {
    if (!status.installed) {
      return '<span class="inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5 align-middle"></span>' +
        '<span class="align-middle">GitHub CLI not installed</span>' +
        '<p class="text-gray-500 mt-1">Install from <code class="text-gray-400">https://cli.github.com</code></p>';
    }

    if (!status.authenticated) {
      return '<span class="inline-block w-2 h-2 rounded-full bg-yellow-500 mr-1.5 align-middle"></span>' +
        '<span class="align-middle">gh ' + status.version + ' &mdash; Not authenticated</span>' +
        '<p class="text-gray-500 mt-1">Run <code class="text-gray-400">gh auth login</code> to authenticate</p>';
    }

    return '<span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5 align-middle"></span>' +
      '<span class="align-middle">gh ' + status.version + ' &mdash; ' + status.username + '</span>';
  }

  function loadSlackSettingsFields(slack) {
    $('#input-slack-enabled').prop('checked', slack && slack.enabled === true);
    $('#input-slack-bot-token').val((slack && slack.botToken) ? '••••••••' : '');
    $('#input-slack-bot-token').data('has-saved-token', !!(slack && slack.botToken));
    $('#input-slack-app-token').val((slack && slack.appToken) ? '••••••••' : '');
    $('#input-slack-app-token').data('has-saved-app-token', !!(slack && slack.appToken));
    $('#input-slack-default-channel').val((slack && slack.defaultChannelId) || '');
  }

  function loadEmailSettingsFields(email) {
    $('#input-email-enabled').prop('checked', !!(email && email.enabled));
    $('#input-email-smtp-host').val((email && email.smtpHost) || '');
    $('#input-email-smtp-port').val((email && email.smtpPort) || 587);
    $('#input-email-smtp-secure').prop('checked', !!(email && email.smtpSecure));
    $('#input-email-smtp-user').val((email && email.smtpUser) || '');
    $('#input-email-smtp-password').val((email && email.smtpPassword) ? '••••••••' : '');
    $('#input-email-smtp-password').data('has-saved-password', !!(email && email.smtpPassword));
    $('#input-email-from-address').val((email && email.fromAddress) || '');
    $('#input-email-default-recipient').val((email && email.defaultRecipient) || '');
  }

  function loadSlackStatus() {
    var $indicator = $('#slack-status-indicator');
    $indicator.text('Checking...');

    $.get('/api/integrations/slack/status')
      .done(function(status) {
        $indicator.html(renderSlackStatus(status));
      })
      .fail(function() {
        $indicator.html(
          '<span class="inline-block w-2 h-2 rounded-full bg-gray-500 mr-1.5 align-middle"></span>' +
          '<span class="align-middle">Unable to check Slack status</span>'
        );
      });
  }

  function renderSlackStatus(status) {
    if (!status.connected) {
      var errorMsg = status.error || 'Not connected';

      return '<span class="inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5 align-middle"></span>' +
        '<span class="align-middle">' + escapeHtml(errorMsg) + '</span>';
    }

    return '<span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5 align-middle"></span>' +
      '<span class="align-middle">Connected to <strong>' + escapeHtml(status.workspaceName || '') + '</strong> as ' + escapeHtml(status.botUserName || '') + '</span>';
  }

  function checkGitHubAvailable() {
    var $ghButton = $('#btn-github-menu');

    api.getGitHubStatus()
      .done(function(status) {
        if (status.installed && status.authenticated) {
          $ghButton.removeClass('hidden');
        } else {
          $ghButton.addClass('hidden');
        }
      })
      .fail(function() {
        $ghButton.addClass('hidden');
      });
  }

  function updatePermissionFieldsState() {
    var skipAll = $('#input-skip-permissions').is(':checked');
    var $fields = $('#input-permission-mode, #input-allow-rules, #input-deny-rules');
    var $presets = $('.permission-preset');

    if (skipAll) {
      $fields.prop('disabled', true).addClass('opacity-50');
      $presets.prop('disabled', true).addClass('opacity-50');
    } else {
      $fields.prop('disabled', false).removeClass('opacity-50');
      $presets.prop('disabled', false).removeClass('opacity-50');
    }
  }

  function parseRulesFromTextarea(value) {
    return value.split('\n')
      .map(function(line) { return line.trim(); })
      .filter(function(line) { return line.length > 0; });
  }

  var permissionPresets = {
    'safe-dev': {
      allowRules: [
        'Read',
        'Task',
        'Glob',
        'Grep',
        'Bash(npm run:*)',
        'Bash(npm test:*)',
        'Bash(npm install)',
        'Bash(node:*)',
        'Bash(tsc:*)',
        'Bash(go run:*)',
        'Bash(go build:*)',
        'Bash(go test:*)',
        'Bash(go mod:*)',
        'Bash(cargo run:*)',
        'Bash(cargo build:*)',
        'Bash(cargo test:*)',
        'Bash(cargo check:*)',
        'Bash(git status)',
        'Bash(git diff:*)',
        'Bash(git log:*)',
        'Bash(git branch:*)',
        'WebSearch',
        'WebFetch'
      ],
      denyRules: [
        'Read(./.env)',
        'Read(./.env.*)',
        'Bash(rm -rf:*)',
        'Bash(git push:*)',
        'Bash(git push)'
      ]
    },
    'git-only': {
      allowRules: [
        'Read',
        'Glob',
        'Grep',
        'Bash(git:*)'
      ],
      denyRules: [
        'Read(./.env)',
        'Read(./.env.*)',
        'Bash(git push:*)',
        'Bash(git push)'
      ]
    },
    'read-only': {
      allowRules: [
        'Read',
        'Glob',
        'Grep'
      ],
      denyRules: [
        'Read(./.env)',
        'Read(./.env.*)',
        'Write',
        'Edit',
        'Bash'
      ]
    },
    'clear-all': {
      allowRules: [],
      denyRules: []
    }
  };

  function applyPermissionPreset(presetName) {
    var preset = permissionPresets[presetName];

    if (!preset) return;

    $('#input-allow-rules').val(preset.allowRules.join('\n'));
    $('#input-deny-rules').val(preset.denyRules.join('\n'));
    showToast('Preset "' + presetName.replace('-', ' ') + '" applied', 'info');
  }

  function handleSaveSettings($form) {
    var newSendWithCtrlEnter = $('#input-send-ctrl-enter').is(':checked');
    var historyLimit = parseInt($('#input-history-limit').val(), 10) || 25;
    var claudeMdMaxSizeKB = parseInt($('#input-claude-md-max-size').val(), 10) || 50;
    var enableDesktopNotifications = $('#input-desktop-notifications').is(':checked');
    var appendSystemPrompt = $('#input-append-system-prompt').val() || '';
    var ralphLoopHistoryLimit = parseInt($('#input-ralph-loop-history-limit').val(), 10) || 5;
    var settings = {
      maxConcurrentAgents: parseInt($('#input-max-concurrent').val(), 10),
      claudePermissions: {
        dangerouslySkipPermissions: $('#input-skip-permissions').is(':checked'),
        defaultMode: $('#input-permission-mode').val() || 'acceptEdits',
        allowRules: parseRulesFromTextarea($('#input-allow-rules').val()),
        denyRules: parseRulesFromTextarea($('#input-deny-rules').val())
      },
      agentPromptTemplate: $('#input-agent-prompt').val(),
      appendSystemPrompt: appendSystemPrompt,
      sendWithCtrlEnter: newSendWithCtrlEnter,
      historyLimit: historyLimit,
      claudeMdMaxSizeKB: claudeMdMaxSizeKB,
      enableDesktopNotifications: enableDesktopNotifications,
      inventifyFolder: $('#input-inventify-folder').val() || '',
      ralphLoop: {
        historyLimit: ralphLoopHistoryLimit
      },
      mcp: {
        enabled: $('#input-mcp-enabled').is(':checked'),
        servers: state.settings.mcp?.servers || []
      },
      docker: typeof DockerModule !== 'undefined' ? DockerModule.collectSettingsFields() : undefined
    };

    // Collect Slack settings with placeholder detection
    var slackBotToken = $('#input-slack-bot-token').val().trim();
    var slackAppToken = $('#input-slack-app-token').val().trim();
    var slack = {
      enabled: $('#input-slack-enabled').is(':checked'),
      defaultChannelId: $('#input-slack-default-channel').val().trim()
    };

    if (slackBotToken !== '••••••••') {
      slack.botToken = slackBotToken;
    }

    if (slackAppToken !== '••••••••') {
      slack.appToken = slackAppToken;
    }

    settings.slack = slack;

    // Collect Email settings with placeholder detection
    var emailPassword = $('#input-email-smtp-password').val().trim();
    var email = {
      enabled: $('#input-email-enabled').is(':checked'),
      smtpHost: $('#input-email-smtp-host').val().trim(),
      smtpPort: parseInt($('#input-email-smtp-port').val(), 10) || 587,
      smtpSecure: $('#input-email-smtp-secure').is(':checked'),
      smtpUser: $('#input-email-smtp-user').val().trim(),
      fromAddress: $('#input-email-from-address').val().trim(),
      defaultRecipient: $('#input-email-default-recipient').val().trim()
    };
    if (emailPassword !== '••••••••') {
      email.smtpPassword = emailPassword;
    }
    settings.email = email;

    // Request notification permission if enabling notifications
    if (enableDesktopNotifications && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    api.updateSettings(settings)
      .done(function(updated) {
        state.resourceStatus.maxConcurrent = updated.maxConcurrentAgents;
        state.sendWithCtrlEnter = updated.sendWithCtrlEnter !== false;
        state.historyLimit = updated.historyLimit || 25;
        state.chromeEnabled = updated.chromeEnabled ?? false;
        state.settings = updated;
        state.hasUnsavedMcpChanges = false;
        $('#mcp-unsaved-warning').addClass('hidden');
        $('#modal-settings .modal-header').removeClass('has-unsaved');
        $('#btn-save-settings').removeClass('has-changes');
        updateRunningCount();
        updateInputHint();
        updateChromeToggleButton();
        updateSlackButtonVisibility();
        updateEmailButtonVisibility();

        if (updated.slack) {
          loadSlackSettingsFields(updated.slack);
        }

        if (updated.email) {
          loadEmailSettingsFields(updated.email);
        }

        if (typeof PermissionModeModule !== 'undefined') {
          PermissionModeModule.updateSkipPermissionsWarning();
        }

        // Refresh docker indicator (global docker settings may have changed)
        loadDockerStatus(state.selectedProjectId);

        closeAllModals();
        showToast('Settings saved', 'success');
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to save settings');
      });
  }

  function updateInputHint() {
    var isMobile = FileBrowser.isMobileView();

    if (state.sendWithCtrlEnter) {
      if (isMobile) {
        $('#input-hint-text').text('Tap Send to send');
        $('#input-message').attr('placeholder', 'Type a message to Claude...');
        $('#btn-send-message').attr('title', 'Send');
      } else {
        $('#input-hint-text').text('Ctrl+Enter to send, Enter for new line');
        $('#input-message').attr('placeholder', 'Type a message to Claude... (Ctrl+Enter to send)');
        $('#btn-send-message').attr('title', 'Send (Ctrl+Enter)');
      }
    } else {
      if (isMobile) {
        $('#input-hint-text').text('Tap Send to send');
        $('#input-message').attr('placeholder', 'Type a message to Claude...');
        $('#btn-send-message').attr('title', 'Send');
      } else {
        $('#input-hint-text').text('Enter to send, Shift+Enter for new line');
        $('#input-message').attr('placeholder', 'Type a message to Claude... (Enter to send, Shift+Enter for new line)');
        $('#btn-send-message').attr('title', 'Send (Enter)');
      }
    }

    // A pending prompt owns the placeholder. This runs on every agent_status and
    // used to overwrite the prompt text immediately; that did not matter while
    // the composer was disabled, but the placeholder is now the only signal that
    // something is waiting for an answer.
    var promptText = promptPlaceholderText(state.activePromptType);

    if (promptText) {
      $('#input-message').attr('placeholder', promptText);
    }

    // Update image hint with attach link
    var attachLink = '<a href="#" id="btn-attach-image" class="text-purple-400 hover:text-purple-300">attach</a>';

    if (isMobile) {
      $('#input-hint-image').html('• Long-press to paste or ' + attachLink);
    } else {
      $('#input-hint-image').html('• Paste images with Ctrl+V or ' + attachLink);
    }
  }

  /**
   * Placeholder for a prompt awaiting an answer, or null when none is pending.
   *
   * Both wordings deliberately say the input still works: every prompt type
   * accepts a typed reply, so "please respond above" would be misleading now
   * that the composer is never taken away.
   */
  function promptPlaceholderText(promptType) {
    if (!promptType) return null;

    if (promptType === 'compacting') {
      return 'Compacting context — you can still type...';
    }

    return 'Answer above, or just type your reply...';
  }

  function updateChromeToggleButton() {
    var $btn = $('#btn-toggle-chrome');

    if (state.chromeEnabled) {
      $btn.removeClass('bg-gray-700 hover:bg-gray-600').addClass('bg-blue-600 hover:bg-blue-700');
      $('#chrome-toggle-label').text('Chrome');
      $btn.attr('title', 'Chrome browser enabled - click to disable');
    } else {
      $btn.removeClass('bg-blue-600 hover:bg-blue-700').addClass('bg-gray-700 hover:bg-gray-600');
      $('#chrome-toggle-label').text('Chrome');
      $btn.attr('title', 'Chrome browser disabled - click to enable');
    }
  }

  // ============================================================
  // Enhanced Loop Settings Functions
  // ============================================================



  // Helper function to format large numbers
  function formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }

  function setupProjectHandlers() {
    $('#project-list').on('click', '.project-card', function(e) {
      if ($(e.target).closest('.quick-action').length) {
        return; // Don't select when clicking quick action
      }
      var projectId = $(this).data('id');
      selectProject(projectId);
    });

    $('#project-list').on('click', '.quick-action', function(e) {
      e.stopPropagation();
      var $btn = $(this);
      var action = $btn.data('action');
      var projectId = $btn.data('id');
      handleQuickAction(action, projectId);
    });
  }

  function setQuickActionLoading(projectId, isLoading) {
    var $card = $('.project-card[data-id="' + projectId + '"]');
    var $buttons = $card.find('.quick-action');

    if (isLoading) {
      $buttons.addClass('loading').prop('disabled', true);
    } else {
      $buttons.removeClass('loading').prop('disabled', false);
    }
  }

  function showContentLoading(message) {
    $('#loading-message').text(message || 'Processing...');
    $('#content-loading').removeClass('hidden');
  }

  function hideContentLoading() {
    $('#content-loading').addClass('hidden');
  }

  function handleQuickAction(action, projectId) {
    if (action === 'delete') {
      showDeleteConfirmation(projectId);
      return;
    }

    if (action === 'start' && state.agentStarting) return;

    setQuickActionLoading(projectId, true);

    if (state.selectedProjectId === projectId && (action === 'start' || action === 'stop')) {
      showContentLoading(action === 'start' ? 'Starting agent...' : 'Stopping agent...');
    }

    switch (action) {
      case 'start':
        state.agentStarting = true;
        api.startAgent(projectId)
          .done(function() {
            showToast('Agent starting...', 'info');
          })
          .fail(function(xhr) {
            showErrorToast(xhr, 'Failed to start agent');
          })
          .always(function() {
            state.agentStarting = false;
            setQuickActionLoading(projectId, false);
            // Only hide loading if still viewing the same project
            if (state.selectedProjectId === projectId) {
              hideContentLoading();
            }
          });
        break;
      case 'stop':
        api.stopAgent(projectId)
          .done(function() {
            showToast('Agent stopping...', 'info');
          })
          .fail(function(xhr) {
            showErrorToast(xhr, 'Failed to stop agent');
          })
          .always(function() {
            setQuickActionLoading(projectId, false);
            // Only hide loading if still viewing the same project
            if (state.selectedProjectId === projectId) {
              hideContentLoading();
            }
          });
        break;
      case 'cancel':
        api.removeFromQueue(projectId)
          .done(function() {
            updateProjectStatusById(projectId, 'stopped');
            showToast('Removed from queue', 'success');
          })
          .fail(function(xhr) {
            showErrorToast(xhr, 'Failed to remove from queue');
          })
          .always(function() {
            setQuickActionLoading(projectId, false);
            // Only hide loading if still viewing the same project
            if (state.selectedProjectId === projectId) {
              hideContentLoading();
            }
          });
        break;
    }
  }

  function showDeleteConfirmation(projectId) {
    var project = findProjectById(projectId);

    if (!project) return;

    state.pendingDeleteId = projectId;
    $('#delete-project-name').text(project.name);
    openModal('modal-confirm-delete');
  }

  function confirmDeleteProject() {
    var projectId = state.pendingDeleteId;

    if (!projectId) return;

    api.deleteProject(projectId)
      .done(function() {
        state.projects = state.projects.filter(function(p) { return p.id !== projectId; });

        if (state.selectedProjectId === projectId) {
          state.selectedProjectId = null;
          saveToLocalStorage(LOCAL_STORAGE_KEYS.SELECTED_PROJECT, null);
          renderProjectDetail(null);
        }

        renderProjectList();
        closeAllModals();
        showToast('Project deleted', 'success');
        state.pendingDeleteId = null;
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to delete project');
      });
  }

  function confirmDeleteTask() {
    var task = state.pendingDeleteTask;

    if (!task || !state.selectedProjectId) return;

    api.deleteRoadmapTask(state.selectedProjectId, task.phaseId, task.milestoneId, task.taskIndex)
      .done(function(data) {
        closeModal('modal-confirm-delete-task');
        RoadmapModule.render(data);
        showToast('Task deleted', 'success');
        state.pendingDeleteTask = null;
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to delete task');
      });
  }

  function confirmDeleteMilestone() {
    var milestone = state.pendingDeleteMilestone;

    if (!milestone || !state.selectedProjectId) return;

    api.deleteRoadmapMilestone(state.selectedProjectId, milestone.phaseId, milestone.milestoneId)
      .done(function(data) {
        closeModal('modal-confirm-delete-milestone');
        RoadmapModule.render(data);
        showToast('Milestone deleted', 'success');
        state.pendingDeleteMilestone = null;
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to delete milestone');
      });
  }

  function confirmDeletePhase() {
    var phase = state.pendingDeletePhase;

    if (!phase || !state.selectedProjectId) return;

    api.deleteRoadmapPhase(state.selectedProjectId, phase.phaseId)
      .done(function(data) {
        closeModal('modal-confirm-delete-phase');
        RoadmapModule.render(data);
        showToast('Phase deleted', 'success');
        state.pendingDeletePhase = null;
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to delete phase');
      });
  }

  function updateScrollLockButton() {
    var $btn = $('#btn-toggle-scroll-lock');

    if (state.agentOutputScrollLock) {
      $btn.addClass('bg-yellow-600').removeClass('bg-gray-700');
      $btn.attr('title', 'Auto-scroll paused. Click to resume.');
    } else {
      $btn.removeClass('bg-yellow-600').addClass('bg-gray-700');
      $btn.attr('title', 'Auto-scroll enabled. Click to pause.');
    }
  }

  function updateScrollFloatButtons($container, scrollTop, scrollHeight, containerHeight, isNearTop, isNearBottom) {
    var $btnTop = $('#btn-scroll-top');
    var $btnBottom = $('#btn-scroll-bottom');
    var hasScrollableContent = scrollHeight > containerHeight + 100;

    if (!hasScrollableContent) {
      $btnTop.addClass('hidden');
      $btnBottom.addClass('hidden');
      return;
    }

    if (isNearTop) {
      $btnTop.addClass('hidden');
    } else {
      $btnTop.removeClass('hidden');
    }

    if (isNearBottom) {
      $btnBottom.addClass('hidden');
    } else {
      $btnBottom.removeClass('hidden');
    }
  }

  function updateFontSize() {
    var size = state.fontSize + 'px';

    // Set CSS variable on document root for global scaling
    document.documentElement.style.setProperty('--claudito-font-size', size);

    $('#font-size-display').text(size);

    // Sync one-off tab toolbars
    if (typeof OneOffToolbarModule !== 'undefined' && OneOffToolbarModule) {
      OneOffToolbarModule.syncFontSize(state.fontSize);
    }

    // Persist to localStorage
    saveToLocalStorage(LOCAL_STORAGE_KEYS.FONT_SIZE, state.fontSize);
  }

  function loadFontSize() {
    var savedSize = loadFromLocalStorage(LOCAL_STORAGE_KEYS.FONT_SIZE, 14);
    state.fontSize = savedSize;

    if (state.fontSize < 10) state.fontSize = 10;
    if (state.fontSize > 24) state.fontSize = 24;

    updateFontSize();
  }

  function loadScrollLockPreference() {
    var savedScrollLock = loadFromLocalStorage(LOCAL_STORAGE_KEYS.SCROLL_LOCK, false);
    state.agentOutputScrollLock = savedScrollLock;
    updateScrollLockButton();
  }

  function setupAgentHandlers() {
    $('#btn-start-agent').on('click', function() {
      startSelectedAgent();
    });

    $('#btn-stop-agent').on('click', function() {
      if (state.isRalphLoopRunning) {
        stopRalphLoop();
      } else {
        stopSelectedAgent();
      }
    });

    $('#btn-restart-agent').on('click', function() {
      if (state.isRalphLoopRunning) {
        stopRalphLoop();
      } else {
        restartSelectedAgent();
      }
    });


    // Permission mode handlers are in PermissionModeModule.setupHandlers()

    // Approval mode toggle handlers
    $('#btn-approval-auto').on('click', function() { changeApprovalMode('auto'); });
    $('#btn-approval-ask').on('click', function() { changeApprovalMode('ask'); });

    // Model selector handler
    $('#project-model-select').on('change', function() {
      handleProjectModelChange($(this).val() || null);
    });

    // Profile selector handler
    $('#project-profile-select').on('change', function() {
      handleProjectProfileChange($(this).val() || null);
    });

    // Cancel button handler
    $('#btn-cancel-agent').on('click', function() {
      // If a one-off tab is active, stop the one-off agent instead
      if (state.activeOneOffTabId && state.selectedProjectId) {
        api.stopOneOffAgent(state.selectedProjectId, state.activeOneOffTabId).fail(function() {
          showToast('Failed to stop agent', 'error');
        });
        return;
      }

      cancelAgentOperation();
    });


    // Message form handler
    $('#form-send-message').on('submit', function(e) {
      e.preventDefault();
      sendMessage();
    });

    // On mobile, restore inputmode when user taps the input area to type again
    $('#input-message').on('touchstart', function() {
      $(this).removeAttr('inputmode');
    });

    // New conversation button - show confirmation dialog
    $('#btn-new-conversation').on('click', function() {
      showNewConversationConfirmation();
    });

    // Confirm new conversation
    $('#btn-confirm-new-conversation').on('click', function() {
      closeModal('modal-confirm-new-conversation');
      startNewConversation();
    });

    // Optimizations dropdown
    $('#btn-optimizations-menu').on('click', function(e) {
      e.stopPropagation();
      toggleToolbarDropdown('optimizations-dropdown', $(this));
    });

    $('#btn-claude-files').on('click', function() {
      closeAllToolbarDropdowns();
      ModalsModule.openClaudeFilesModal();
    });

    $('#btn-optimizations').on('click', function() {
      closeAllToolbarDropdowns();
      TaskDisplayModule.openOptimizationsModal();
    });

    $('#btn-ralph-loop').on('click', function() {
      closeAllToolbarDropdowns();
      openRalphLoopConfigModal();
    });

    // GitHub dropdown
    $('#btn-github-menu').on('click', function(e) {
      e.stopPropagation();
      toggleToolbarDropdown('github-dropdown', $(this));
    });

    $('#btn-view-issues, #btn-create-pr, #btn-view-prs').on('click', function() {
      closeAllToolbarDropdowns();
    });

    // Quick Actions button
    $('#btn-quick-actions').on('click', function(e) {
      e.stopPropagation();
      closeAllToolbarDropdowns();
      QuickActionsModule.toggleQuickActions();
    });

    // Quick Actions dropdown handlers
    $(document).on('click', '.quick-action-item', function() {
      var templateId = $(this).data('template-id');
      QuickActionsModule.handleQuickActionClick(templateId);
    });

    $('#btn-close-quick-actions').on('click', function() {
      QuickActionsModule.closeQuickActions();
    });

    // Click outside to close quick actions
    $(document).on('click', function(e) {
      if (state.quickActionsOpen &&
          !$(e.target).closest('#quick-actions-dropdown').length &&
          !$(e.target).closest('#btn-quick-actions').length) {
        QuickActionsModule.closeQuickActions();
      }

      if (!$(e.target).closest('#optimizations-dropdown, #btn-optimizations-menu, #github-dropdown, #btn-github-menu').length) {
        closeAllToolbarDropdowns();
      }

      // Close docker image dropdown on outside click
      if (!$(e.target).closest('#docker-host-indicator').length) {
        $('#docker-image-dropdown').addClass('hidden');
      }
    });

    // Docker indicator click - toggle image selector dropdown
    $(document).on('click', '#docker-indicator-btn', function(e) {
      e.stopPropagation();
      toggleDockerImageDropdown();
    });

    // Docker image dropdown item selection
    $(document).on('click', '.docker-image-option', function(e) {
      e.stopPropagation();
      var selectedImage = $(this).data('image');
      handleDockerImageSelection(selectedImage);
    });

    // Search button
    $('#btn-search').on('click', function() {
      if (state.search.isOpen) {
        SearchModule.close();
      } else {
        SearchModule.open();
      }
    });

    // MCP Servers button
    $('#btn-project-mcp').on('click', function() {
      if (state.selectedProjectId) {
        var project = findProjectById(state.selectedProjectId);
        if (project) {
          McpProjectModule.openProjectMcpModal(state.selectedProjectId, project.name);
        }
      }
    });

    // Slack Notifications button
    $('#btn-project-slack').on('click', function() {
      if (state.selectedProjectId) {
        var project = findProjectById(state.selectedProjectId);
        if (project) {
          SlackProjectModule.openSlackModal(state.selectedProjectId, project.name);
        }
      }
    });

    $('#btn-toggle-chrome').on('click', function() {
      state.chromeEnabled = !state.chromeEnabled;
      updateChromeToggleButton();

      api.updateSettings({ chromeEnabled: state.chromeEnabled })
        .done(function(updated) {
          state.settings = updated;
          var label = state.chromeEnabled ? 'Chrome enabled' : 'Chrome disabled';
          showToast(label + '. Restart the agent for changes to take effect.', 'info');
        })
        .fail(function(xhr) {
          state.chromeEnabled = !state.chromeEnabled;
          updateChromeToggleButton();
          showErrorToast(xhr, 'Failed to update Chrome setting');
        });
    });

    // Optimization action buttons (dynamically created, so use delegation)
    $(document).on('click', '.optimization-action', function() {
      var action = $(this).data('action');
      var filePath = $(this).data('path');

      closeModal('modal-optimizations');

      if (action === 'create') {
        // Determine template based on file name
        var fileName = filePath.split(/[\\\/]/).pop();
        var template = '';

        if (fileName === 'CLAUDE.md') {
          template = '# Project Context\n\nAdd project-specific instructions for Claude here.\n';
        } else if (fileName === 'ROADMAP.md') {
          template = '# Project Roadmap\n\n## Phase 1: Initial Setup\n\n### Milestone 1.1: Project Foundation\n\n- [ ] First task\n- [ ] Second task\n';
        } else {
          template = '';
        }

        api.writeFile(filePath, template)
          .done(function() {
            showToast(fileName + ' created', 'success');
            TaskDisplayModule.loadOptimizationsBadge(state.selectedProjectId);

            // Refresh file browser if project files tab is active
            if (state.activeTab === 'project-files') {
              var project = findProjectById(state.selectedProjectId);

              if (project) {
                FileBrowser.loadFileTree(project.path);
              }
            }

            // Open the file in editor
            FileBrowser.openFile(filePath, fileName);
          })
          .fail(function(xhr) {
            // Check if parent directory doesn't exist
            if (xhr.status === 500 || xhr.status === 404) {
              // Try to create parent directory first
              var parentPath = filePath.substring(0, filePath.lastIndexOf(/[\\\/]/.test(filePath) ? (filePath.indexOf('\\') !== -1 ? '\\' : '/') : '/'));

              if (parentPath && parentPath !== filePath) {
                api.createFolder(parentPath)
                  .done(function() {
                    // Retry file creation
                    api.writeFile(filePath, template)
                      .done(function() {
                        showToast(fileName + ' created', 'success');
                        TaskDisplayModule.loadOptimizationsBadge(state.selectedProjectId);

                        if (state.activeTab === 'project-files') {
                          var project = findProjectById(state.selectedProjectId);

                          if (project) {
                            FileBrowser.loadFileTree(project.path);
                          }
                        }

                        FileBrowser.openFile(filePath, fileName);
                      })
                      .fail(function() {
                        showToast('Failed to create ' + fileName, 'error');
                      });
                  })
                  .fail(function() {
                    showToast('Failed to create ' + fileName, 'error');
                  });
              } else {
                showToast('Failed to create ' + fileName, 'error');
              }
            } else {
              showToast('Failed to create ' + fileName, 'error');
            }
          });
      } else if (action === 'edit') {
        // Open file in editor
        var fileName = filePath.split(/[\\\/]/).pop();
        FileBrowser.openFile(filePath, fileName);
      } else if (action === 'claude-files') {
        // Open Claude Files modal
        ModalsModule.openClaudeFilesModal();
      }
    });

    // Queued messages indicator (dynamically created, so use delegation)
    $(document).on('click', '#queued-messages-indicator', function() {
      openQueuedMessagesModal();
    });

    // Remove queued message button (dynamically created, so use delegation)
    $(document).on('click', '.btn-remove-queued-message', function(e) {
      e.stopPropagation();
      var $item = $(this).closest('[data-queue-index]');
      var index = parseInt($item.data('queue-index'), 10);

      if (!isNaN(index)) {
        removeQueuedMessage(index);
      }
    });

    // Save Claude file button - handler is in ModalsModule

    // Rename conversation button click
    $(document).on('click', '.btn-rename-conversation', function(e) {
      e.stopPropagation();
      var conversationId = $(this).data('conversation-id');
      var currentLabel = $(this).data('current-label');
      showRenameConversationModal(conversationId, currentLabel);
    });

    // Delete conversation button click
    $(document).on('click', '.btn-delete-conversation', function(e) {
      e.stopPropagation();
      var conversationId = $(this).data('conversation-id');
      var label = $(this).data('conversation-label');

      if (!conversationId || !state.selectedProjectId) return;

      showConfirm('Delete session', 'Delete "' + label + '"? This cannot be undone.', {
        confirmText: 'Delete',
        danger: true
      }).then(function(confirmed) {
        if (!confirmed) return;

        var projectId = state.selectedProjectId;
        api.deleteConversation(projectId, conversationId)
          .done(function() {
            showToast('Session deleted', 'success');

            // If the deleted session was the active one, clear the view
            if (state.currentConversationId === conversationId) {
              state.currentConversationId = null;
              state.conversations[projectId] = [];
              renderConversation(projectId);
            }

            ConversationHistoryModule.loadList();
          })
          .fail(function(xhr) {
            showErrorToast(xhr, 'Failed to delete session');
          });
      });
    });

    // Confirm rename conversation
    $('#btn-confirm-rename').on('click', function() {
      confirmRenameConversation();
    });

    // Enter key in rename input
    $('#input-conversation-label').on('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmRenameConversation();
      }
    });

    // Message input - configurable send key
    $('#input-message').on('keydown', function(e) {
      if (e.key === 'Enter') {
        if (state.sendWithCtrlEnter) {
          // Ctrl+Enter to send mode
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            sendMessage();
          }
          // Plain Enter adds newline (default behavior)
        } else {
          // Enter to send mode (Shift+Enter for newline)
          if (!e.shiftKey) {
            e.preventDefault();
            sendMessage();
          }
        }
      }
    });

    // Image upload link handler (using event delegation since link is dynamically created)
    $(document).on('click', '#btn-attach-image', function(e) {
      e.preventDefault();
      $('#image-upload-input').click();
    });

    // Image file input change handler
    $('#image-upload-input').on('change', function(e) {
      var files = e.target.files;

      for (var i = 0; i < files.length; i++) {
        if (files[i].type.indexOf('image') !== -1) {
          ImageAttachmentModule.processFile(files[i]);
        }
      }

      // Reset input so same file can be selected again
      $(this).val('');
    });

    // Voice input button handler
    (function() {
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        $('#btn-voice-input').attr('title', 'Voice input not supported in this browser').css('opacity', '0.4');
        return;
      }

      var recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'ko-KR';

      var isListening = false;
      var baseText = '';

      recognition.onstart = function() {
        isListening = true;
        baseText = $('#input-message').val();
        if (baseText && !baseText.endsWith(' ')) baseText += ' ';
        $('#btn-voice-input')
          .addClass('text-red-400 voice-listening')
          .removeClass('text-gray-500 hover:text-gray-300')
          .attr('title', 'Stop voice input');
      };

      recognition.onresult = function(e) {
        var interim = '';
        var finalText = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            finalText += e.results[i][0].transcript;
          } else {
            interim += e.results[i][0].transcript;
          }
        }
        if (finalText) baseText += finalText;
        var $input = $('#input-message');
        $input.val(baseText + interim);
        $input[0].dispatchEvent(new Event('input'));
        $input[0].scrollTop = $input[0].scrollHeight;
      };

      recognition.onerror = function(e) {
        if (e.error === 'not-allowed') {
          showToast('마이크 권한이 필요합니다. 브라우저 주소창의 권한 설정을 확인하세요.', 'error');
        } else if (e.error === 'network') {
          showToast('음성 인식에 인터넷 연결이 필요합니다.', 'error');
        } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
          console.warn('Speech recognition error:', e.error);
        }
      };

      recognition.onend = function() {
        isListening = false;
        $('#btn-voice-input')
          .removeClass('text-red-400 voice-listening')
          .addClass('text-gray-500 hover:text-gray-300')
          .attr('title', 'Voice input');
      };

      $(document).on('click', '#btn-voice-input', function() {
        if (isListening) {
          recognition.stop();
        } else {
          recognition.start();
        }
      });
    })();

    // Permission button click handler
    $(document).on('click', '.permission-btn', function() {
      var $btn = $(this);
      var response = $btn.data('response');

      // Send response to agent
      sendPermissionResponse(response);

      // Clear prompt blocking
      state.justAnsweredQuestion = true;
      setPromptHintState(null);
      setTimeout(function() {
        state.justAnsweredQuestion = false;
      }, 100);

      // Disable all buttons in this permission request
      $btn.closest('.permission-actions').find('.permission-btn').prop('disabled', true);
      $btn.addClass('selected');
    });

    // Question option click handler
    $(document).on('click', '.question-option', function() {
      var $btn = $(this);
      var optionIndex = $btn.data('option-index');
      var optionLabel = $btn.data('option-label');

      if (optionIndex === -1) {
        // "Other" option - clear blocking and focus the input
        state.justAnsweredQuestion = true;
        setPromptHintState(null);
        // Clear any pending message for "Other" option
        state.pendingMessageBeforeQuestion = null;
        $('#input-message').focus();
        setTimeout(function() {
          state.justAnsweredQuestion = false;
        }, 100);
        return;
      }

      // Send the selected option as response
      sendQuestionResponse(optionLabel);

      // Clear prompt blocking (but don't restore pending message immediately)
      state.justAnsweredQuestion = true;
      setPromptHintState(null);
      // Reset the flag after a short delay to allow restoring messages later
      setTimeout(function() {
        state.justAnsweredQuestion = false;
      }, 100);

      // Disable all options in this question
      $btn.closest('.question-options').find('.question-option').prop('disabled', true);
      $btn.addClass('selected');
    });

    // Copy assistant answer to clipboard
    $(document).on('click', '.msg-copy-btn', function(e) {
      e.preventDefault();
      e.stopPropagation();

      var $btn = $(this);
      var raw = '';
      try {
        raw = decodeURIComponent($btn.attr('data-raw') || '');
      } catch (err) {
        raw = $btn.attr('data-raw') || '';
      }

      copyTextToClipboard(raw, function() {
        $btn.addClass('copied');
        setTimeout(function() { $btn.removeClass('copied'); }, 1500);
      });
    });

    // Send assistant message as email
    $(document).on('click', '.msg-email-btn', function(e) {
      e.preventDefault();
      e.stopPropagation();

      var $btn = $(this);
      var raw = '';
      try {
        raw = decodeURIComponent($btn.attr('data-raw') || '');
      } catch (err) {
        raw = $btn.attr('data-raw') || '';
      }

      if (!raw) return;

      var subject = (function() {
        var stripped = raw
          .replace(/```[\s\S]*?```/g, '')
          .replace(/`[^`]+`/g, '')
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/[*_~>|\[\]]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        var firstLine = stripped.split(/[.!?\n]/)[0].trim();
        var summary = (firstLine || stripped).slice(0, 60);
        if ((firstLine || stripped).length > 60) summary += '...';
        return '[Claudito] ' + summary;
      })();

      $btn.prop('disabled', true);
      $.ajax({
        url: '/api/email/send',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ body: raw, subject: subject, projectId: state.selectedProjectId }),
      }).done(function() {
        showToast('Email sent', 'success');
        $btn.addClass('sent');
        var ts = $btn.attr('data-msg-ts');
        if (ts) {
          var key = 'email-sent:' + (state.selectedProjectId || '') + ':' + ts;
          try { localStorage.setItem(key, '1'); } catch(e) {}
        }
      }).fail(function(xhr) {
        var msg = (xhr.responseJSON && xhr.responseJSON.error) || 'Failed to send email';
        if (msg === 'Email not configured') {
          showToast('Email not configured. Go to Settings > Email.', 'error');
        } else {
          showToast(msg, 'error');
        }
      }).always(function() {
        $btn.prop('disabled', false);
      });
    });

    // Plan mode approve button handler
    $(document).on('click', '.plan-approve-btn', function() {
      var $btn = $(this);
      var $actions = $btn.closest('.plan-mode-actions');
      $actions.find('button').prop('disabled', true).addClass('opacity-50 cursor-not-allowed');

      // Clear prompt blocking
      setPromptHintState(null);

      var project = findProjectById(state.selectedProjectId);

      if (project && project.status !== 'running') {
        // Agent not running (server restart/crash) — start directly in acceptEdits mode with plan content
        startInteractiveAgentWithMessage(state.lastPlanContent || '', 'acceptEdits');
      } else {
        // Switch to Accept Edits mode and restart agent with implementation message
        PermissionModeModule.approvePlanAndSwitch();
      }
    });

    // Plan mode reject button handler
    $(document).on('click', '.plan-reject-btn', function() {
      var $btn = $(this);
      var $actions = $btn.closest('.plan-mode-actions');
      $actions.find('button').prop('disabled', true).addClass('opacity-50 cursor-not-allowed');

      // Clear prompt blocking
      setPromptHintState(null);

      var project = findProjectById(state.selectedProjectId);

      if (project && project.status !== 'running') {
        // Agent not running (server restart/crash) — start in plan mode and pass 'no'
        startInteractiveAgentWithMessage('no', 'plan');
      } else {
        sendPlanModeResponse('no');
      }
    });

    // Plan mode request changes button handler
    $(document).on('click', '.plan-request-changes-btn', function() {
      var $btn = $(this);
      var $actions = $btn.closest('.plan-mode-actions');
      // Disable all buttons in this plan mode action set
      $actions.find('button').prop('disabled', true).addClass('opacity-50 cursor-not-allowed');

      // Clear prompt blocking so user can type feedback
      setPromptHintState(null);

      // Mark next send as plan feedback so the server accepts it
      state.planFeedbackPending = true;

      // Focus the input field so user can type their feedback
      var $input = $('#agent-input');
      $input.focus();
      showToast('Describe what you\'d like to change in the plan', 'info');
    });

    // AskUserQuestion option button handler
    $(document).on('click', '.ask-user-option', function(e) {
      e.preventDefault();
      e.stopPropagation(); // Prevent tool modal from opening

      var $btn = $(this);
      var toolId = $btn.data('tool-id');
      var questionIndex = $btn.data('question-index');
      var optionIndex = $btn.data('option-index');
      var optionLabel = $btn.data('option-label');
      var $container = $btn.closest('.ask-user-question');

      // Handle "Other" option
      if (optionIndex === -1) {
        handleAskUserOtherOption($btn, toolId, questionIndex, $container);
        return;
      }

      selectQuestionOption($btn, toolId, questionIndex, optionLabel, $container);
    });

    // Submit answers button handler
    $(document).on('click', '.ask-user-submit', function(e) {
      e.preventDefault();
      e.stopPropagation();

      var $btn = $(this);
      var toolId = $btn.data('tool-id');
      var $container = $btn.closest('.ask-user-question');

      submitQuestionAnswers(toolId, $container);
    });
  }

  function handleAskUserOtherOption($btn, toolId, questionIndex, $container) {
    showPrompt('Custom Answer', 'Enter your response:', {
      placeholder: 'Type your answer...',
      submitText: 'Submit'
    }).then(function(customText) {
      if (!customText) return;

      // Update the Other button label to show the custom text
      $btn.find('.font-medium').text('Other: ' + customText);
      selectQuestionOption($btn, toolId, questionIndex, customText, $container);
    });
  }

  function selectQuestionOption($btn, toolId, questionIndex, answerText, $container) {
    var totalQuestions = countAskUserQuestions($container);
    var mqs = getMultiQuestionState();

    // Initialize state if needed
    if (!mqs.activeToolId) {
      mqs.activeToolId = toolId;
      mqs.totalQuestions = totalQuestions;
    }

    // Highlight selected option (allow re-selection)
    highlightSelectedOption($btn, questionIndex, $container);

    // Store the answer
    mqs.answers[questionIndex] = answerText;

    // Show/hide submit button based on whether all questions are answered
    updateQuestionSubmitButton($container);
  }

  function countAskUserQuestions($container) {
    return $container.find('div.flex[data-question-index]').length;
  }

  function highlightSelectedOption($btn, questionIndex, $container) {
    // Clear previous selection for this question
    $container.find('div.flex[data-question-index="' + questionIndex + '"]')
      .find('.ask-user-option')
      .removeClass('bg-purple-600 ring-2 ring-purple-400')
      .addClass('bg-gray-700');

    // Highlight selected
    $btn.removeClass('bg-gray-700').addClass('bg-purple-600 ring-2 ring-purple-400');
  }

  function getMultiQuestionState() {
    if (!state.multiQuestionState) {
      state.multiQuestionState = {
        activeToolId: null,
        totalQuestions: 0,
        answers: {},
        isMultiQuestion: false
      };
    }

    return state.multiQuestionState;
  }

  function updateQuestionSubmitButton($container) {
    var mqs = getMultiQuestionState();
    var totalQuestions = mqs.totalQuestions;
    var answeredCount = Object.keys(mqs.answers).length;
    var $submitBtn = $container.find('.ask-user-submit');

    if (answeredCount >= totalQuestions) {
      $submitBtn.removeClass('hidden');
    } else {
      $submitBtn.addClass('hidden');
    }
  }

  function submitQuestionAnswers(toolId, $container) {
    // Prevent duplicate submissions for the same tool ID
    if (state.submittedQuestionToolIds[toolId]) {
      return;
    }

    state.submittedQuestionToolIds[toolId] = true;

    var mqs = getMultiQuestionState();
    var totalQuestions = mqs.totalQuestions;

    // Build answers map: { "0": "selectedLabel", "1": "selectedLabel", ... }
    var answers = {};

    for (var i = 0; i < totalQuestions; i++) {
      if (mqs.answers[i]) {
        answers[String(i)] = mqs.answers[i];
      }
    }

    var summaryParts = [];

    for (var j = 0; j < totalQuestions; j++) {
      if (answers[String(j)]) {
        summaryParts.push(totalQuestions > 1
          ? 'Q' + (j + 1) + ': ' + answers[String(j)]
          : answers[String(j)]);
      }
    }

    var summary = summaryParts.join(', ');

    // Disable ALL question UIs with this toolId (handles duplicate renders)
    $('.ask-user-question[data-tool-id="' + toolId + '"]').each(function() {
      $(this).find('.ask-user-option')
        .prop('disabled', true)
        .addClass('opacity-50 cursor-not-allowed');
      $(this).find('.ask-user-submit')
        .prop('disabled', true)
        .addClass('opacity-50');
    });

    // Send as tool_result via the answer endpoint
    if (state.selectedProjectId) {
      api.answerAgentQuestion(state.selectedProjectId, toolId, answers)
        .fail(function(xhr) {
          // The card was disabled and the tool id marked as submitted before the
          // request went out, so a failure left the question unanswerable and
          // unresendable. Put it back so the user can retry.
          state.submittedQuestionToolIds[toolId] = false;
          $('.ask-user-question[data-tool-id="' + toolId + '"]').each(function() {
            $(this).find('.ask-user-option')
              .prop('disabled', false)
              .removeClass('opacity-50 cursor-not-allowed');
            $(this).find('.ask-user-submit')
              .prop('disabled', false)
              .removeClass('opacity-50');
          });
          showErrorToast(xhr, 'Failed to send answer');
        });
    }

    clearBlockingAfterAnswer();
    ToolRenderer.updateToolStatus(toolId, 'completed', 'User selected: ' + summary);

    state.multiQuestionState = {
      activeToolId: null,
      totalQuestions: 0,
      answers: {},
      isMultiQuestion: false
    };

    $('#multi-question-progress').remove();
  }

  function clearBlockingAfterAnswer() {
    state.justAnsweredQuestion = true;
    setPromptHintState(null);

    // Send any deferred plan message now that the question is answered
    if (state.deferredPlanMessage) {
      var planMsg = state.deferredPlanMessage;
      state.deferredPlanMessage = null;
      appendMessage(state.selectedProjectId, planMsg);
    }

    setTimeout(function() {
      state.justAnsweredQuestion = false;
    }, 100);
  }

  function sendPlanModeResponse(response) {
    if (!state.selectedProjectId) return;

    api.sendAgentMessage(state.selectedProjectId, response, null, true)
      .fail(function(xhr) {
        console.error('Failed to send plan mode response:', xhr);
        showToast('Failed to send response', 'error');
      });
  }

  function showNewConversationConfirmation() {
    if (!state.selectedProjectId) return;

    // If no messages in current conversation, just start new without confirmation
    var currentMessages = state.conversations[state.selectedProjectId] || [];

    if (currentMessages.length === 0) {
      startNewConversation();
      return;
    }

    openModal('modal-confirm-new-conversation');
  }

  function startNewConversation() {
    if (!state.selectedProjectId) return;

    var projectId = state.selectedProjectId;
    var project = findProjectById(projectId);
    var wasRunning = project && project.status === 'running';

    // Clear search when starting new conversation
    if (state.search.isOpen) {
      SearchModule.close();
    }

    // Clear read file cache when starting new conversation
    FileCache.clear();

    // Clear tasks when starting new conversation
    state.currentTodos = [];
    TaskDisplayModule.updateButtonBadge();

    // Clear session ID to force new session
    state.currentSessionId = null;

    // Clear any prompt blocking
    setPromptHintState(null);

    function clearAndRestart() {
      // Clear current conversation on server
      $.ajax({
        url: '/api/projects/' + projectId + '/conversation/clear',
        method: 'POST'
      }).always(function() {
        // Clear local state regardless of server response
        state.currentConversationId = null;
        state.currentConversationStats = null;
        state.currentConversationMetadata = null;
        state.currentConversationLabel = null;
        state.conversations[projectId] = [];
        renderConversation(projectId);
        ConversationHistoryModule.updateStats();
        showToast('Context cleared', 'info');
      });
    }

    // If agent is running, stop it first then clear
    if (wasRunning) {
      showContentLoading('Clearing context...');
      api.stopAgent(projectId)
        .always(function() {
          updateProjectStatusById(projectId, 'stopped');
          stopAgentStatusPolling();
          clearAndRestart();
          hideContentLoading();
        });
    } else {
      clearAndRestart();
    }
  }

  function showRenameConversationModal(conversationId, currentLabel) {
    state.pendingRenameConversationId = conversationId;
    $('#input-conversation-label').val(currentLabel || '');
    openModal('modal-rename-conversation');
    // Focus input after modal opens
    setTimeout(function() {
      $('#input-conversation-label').focus().select();
    }, 100);
  }

  function confirmRenameConversation() {
    if (!state.selectedProjectId || !state.pendingRenameConversationId) return;

    var newLabel = $('#input-conversation-label').val().trim();

    if (!newLabel) {
      showToast('Please enter a name', 'error');
      return;
    }

    var renamedId = state.pendingRenameConversationId;
    api.renameConversation(state.selectedProjectId, renamedId, newLabel)
      .done(function() {
        closeModal('modal-rename-conversation');
        ConversationHistoryModule.loadList();
        if (state.currentConversationId === renamedId) {
          state.currentConversationLabel = newLabel;
          updateConversationNameBar();
        }
        showToast('Conversation renamed', 'success');
        state.pendingRenameConversationId = null;
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to rename conversation');
      });
  }

  // Use module formatter functions
  var formatConversationDate = Formatters.formatConversationDate;
  var formatDuration = Formatters.formatDuration;


  // Conversation history functions are now in ConversationHistoryModule

  function sendPermissionResponse(response) {
    if (!response || !state.selectedProjectId) return;

    var project = findProjectById(state.selectedProjectId);

    if (!project || project.status !== 'running') return;

    api.sendAgentMessage(state.selectedProjectId, response)
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to send permission response');
      });
  }

  function updateMultiQuestionProgress() {
    var mqs = getMultiQuestionState();
    var answered = Object.keys(mqs.answers).length;
    var total = mqs.totalQuestions;
    var message = 'Answered ' + answered + ' of ' + total + ' questions';

    // Add progress message near input field
    var $progress = $('#multi-question-progress');
    if ($progress.length === 0) {
      $progress = $('<div id="multi-question-progress" class="text-xs text-gray-400 mb-2 px-2"></div>');
      $('#interactive-input-area').prepend($progress);
    }
    $progress.text(message);

    // Update placeholder
    $('#input-message').attr('placeholder', 'Please answer all questions above (' + answered + '/' + total + ')...');
  }

  function sendQuestionResponse(response) {
    if (!response || !state.selectedProjectId) return;

    var project = findProjectById(state.selectedProjectId);

    if (!project || project.status !== 'running') return;

    // Add user response to conversation
    appendMessage(state.selectedProjectId, {
      type: 'user',
      content: response,
      timestamp: new Date().toISOString()
    });

    api.sendAgentMessage(state.selectedProjectId, response)
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to send response');
      });
  }



  // Permission mode functions are now in PermissionModeModule

  /**
   * Start the composer watchdog and give it the facts it needs.
   *
   * Everything here exists so that a disabled composer is always temporary:
   * - onLockReaped clears the matching flag. A stuck state.messageSending makes
   *   sendMessage() return silently, so the app would ignore the user with no
   *   visible reason — the invisible twin of the dead-input bug.
   *
   * There is no unlock button and no user-facing recovery step: the composer is
   * never disabled, so there is nothing for the user to undo.
   *
   * Deliberately no global $.ajaxSetup timeout either — a request that never
   * settles is already covered by each operation's TTL, whereas a blanket
   * timeout would abort legitimately slow calls (repo clone, docker image pull,
   * one-off agents).
   */
  function initComposerGate() {
    ComposerGate.init({
      getSelectedProjectId: function() {
        return state.selectedProjectId;
      },
      onLockReaped: function(reason, why) {
        if (reason === 'sending') state.messageSending = false;
        if (reason === 'starting') state.agentStarting = false;
        if (reason === 'ralph') state.isRalphLoopRunning = false;
        if (reason === 'modeSwitch') state.isModeSwitching = false;
        if (reason === 'prompt') setPromptHintState(null);

        logFrontendError('Stale composer operation retired: ' + reason + ' (' + why + ')',
          'composer-gate', null, null, null, 'composer_lock_reaped');
      }
    });
  }

  /** Delegates to the gate, which owns the "something to click" rule. */
  function hasAnswerableControl(promptType) {
    return ComposerGate.hasAnswerableControl(promptType);
  }

  /**
   * 'compacting' has no card to click, so it cannot use the DOM test. It is
   * bounded by its TTL and by the agent still running: a compaction that fails
   * or a process that dies must not leave the composer locked.
   */
  function isCompactingLive() {
    var project = findProjectById(state.selectedProjectId);
    return !!(project && project.status === 'running');
  }

  function promptLockOptions(promptType) {
    if (promptType === 'compacting') {
      return { isLive: isCompactingLive, ttlMs: ComposerGate.TTL.COMPACTING };
    }

    return {
      isLive: function() {
        var project = findProjectById(state.selectedProjectId);
        if (!project || project.status !== 'running') return false;
        return hasAnswerableControl(promptType);
      },
      ttlMs: ComposerGate.TTL.PROMPT
    };
  }

  /**
   * Record that a prompt is waiting for the user, and say so in the placeholder.
   *
   * Was setPromptBlockingState(), and it no longer blocks anything: the composer
   * stays fully usable while a prompt is on screen. Answering by typing is
   * always valid — every prompt type accepts a typed reply — so taking the input
   * away only ever created dead ends when the prompt was resolved some other way.
   *
   * The tracked 'prompt' operation exists purely so state.activePromptType and
   * this hint cannot get stuck: the watchdog retires it as soon as there is no
   * answerable card left.
   */
  function setPromptHintState(promptType) {
    state.activePromptType = promptType;
    var isPending = promptType !== null;

    if (isPending) {
      ComposerGate.hold('prompt', promptLockOptions(promptType));
    } else {
      ComposerGate.release('prompt');
    }

    if (isPending) {
      $('#input-message').attr('placeholder', promptPlaceholderText(promptType));
    } else {
      $('#input-message').attr('placeholder', 'Type a message to Claude...');

      // Kept for conversations that still carry a stashed draft from the old
      // behaviour; nothing stashes one any more.
      if (state.pendingMessageBeforeQuestion && $('#input-message').val() === '' && !state.justAnsweredQuestion) {
        $('#input-message').val(state.pendingMessageBeforeQuestion);
      }
      state.pendingMessageBeforeQuestion = null;

      // Replay any deferred plan message now that the prompt is resolved
      if (state.deferredPlanMessage) {
        var planMsg = state.deferredPlanMessage;
        state.deferredPlanMessage = null;
        appendMessage(state.selectedProjectId, planMsg);
      }
    }
  }

  /**
   * Keep the composer in agreement with what the server will actually accept.
   *
   * The plan gate lives on the server (agentManager.pendingPlans) and is
   * reported as `hasPendingPlan`. It decides whether a send is *accepted* — it
   * never decides whether the user may type. A send rejected by the gate renders
   * an answerable recovery card (showPlanRecoveryCard), which is the only
   * resolution path that cannot dead-end.
   */
  function syncPlanBlockingState(projectId, fullStatus) {
    if (!fullStatus || typeof fullStatus.hasPendingPlan !== 'boolean') return;
    if (projectId !== state.selectedProjectId) return;

    state.hasPendingPlan = fullStatus.hasPendingPlan;

    if (!fullStatus.hasPendingPlan) {
      if (state.activePromptType === 'plan_mode') {
        setPromptHintState(null);
      }
      // The card's buttons would post to a plan that no longer exists.
      $('.plan-mode-actions button').prop('disabled', true).addClass('opacity-50 cursor-not-allowed');
      return;
    }

    // Only re-arm the hint while the user actually has a card to click, so a
    // poll arriving just after the approve click cannot resurrect a prompt whose
    // buttons are already spent.
    if (state.activePromptType === null && fullStatus.status === 'running' &&
        hasAnswerableControl('plan_mode')) {
      setPromptHintState('plan_mode');
    }
  }

  function setGitOperationState(isOperating) {
    state.isGitOperating = isOperating;

    // Disable all git action buttons
    $('#btn-git-refresh, #btn-git-commit, #btn-git-push, #btn-git-pull, ' +
      '#btn-git-stage-all, #btn-git-unstage-all, ' +
      '#btn-git-new-branch, #btn-git-new-tag, #btn-create-tag')
      .prop('disabled', isOperating);

    // Disable form elements
    $('#git-commit-message, #git-branch-select').prop('disabled', isOperating);

    // Disable dynamically created buttons via pointer-events
    $('.git-stage-btn, .git-unstage-btn, .git-stage-dir-btn, .git-unstage-dir-btn, ' +
      '.git-push-tag-btn, .git-branch-item')
      .css('pointer-events', isOperating ? 'none' : '');

    // Disable context menu buttons
    $('#git-ctx-stage, #git-ctx-unstage, #git-ctx-discard').prop('disabled', isOperating);

    // Visual feedback
    if (isOperating) {
      $('#git-sidebar').addClass('git-operating');
    } else {
      $('#git-sidebar').removeClass('git-operating');
    }
  }

  function updateStartStopButtons() {
    AgentControlsModule.updateStartStopButtons();
  }

  function updateInputArea() {
    AgentControlsModule.updateInputArea();
  }

  function sendMessage() {
    // If a one-off tab is active, route to the one-off agent
    if (state.activeOneOffTabId && typeof OneOffTabsModule !== 'undefined') {
      OneOffTabsModule.sendOneOffMessage(state.activeOneOffTabId);
      return;
    }

    var $input = $('#input-message');
    var message = $input.val().trim();
    var hasImages = state.pendingImages.length > 0;

    if (!message && !hasImages) return;

    // On touch devices, suppress the virtual keyboard by setting inputmode="none".
    // This prevents the keyboard from appearing even if other code paths refocus the input.
    // The attribute is removed on the next touchstart so the user can tap to type again.
    var isTouchDevice = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (isTouchDevice) {
      $input.attr('inputmode', 'none');
      $input.blur();
    }

    // The composer is never disabled, so these collisions have to be refused
    // here instead — and refused *out loud*. A silent return is how a stuck flag
    // turns into "the app ignores me", which is the failure mode users cannot
    // diagnose. Every flag below is retired by ComposerGate if it goes stale, so
    // none of these can become permanent.
    if (state.messageSending || state.agentStarting) {
      showToast('이전 메시지를 보내는 중입니다. 잠시만 기다려주세요.', 'info');
      return;
    }

    if (state.isModeSwitching) {
      showToast('권한 모드 전환 중입니다. 전환이 끝나면 다시 보내주세요.', 'info');
      return;
    }

    // Silent returns are how "the app ignores me" happens. Anything that refuses
    // to send has to say so.
    if (!state.selectedProjectId) {
      showToast('먼저 프로젝트를 선택해주세요.', 'warning');
      return;
    }

    var project = findProjectById(state.selectedProjectId);

    if (!project) {
      showToast('선택된 프로젝트를 찾을 수 없습니다. 목록에서 다시 선택해주세요.', 'error');
      return;
    }

    // If agent is not running, start it first (always interactive mode)
    if (project.status !== 'running') {
      var permOverride = state.planFeedbackPending ? 'plan' : null;
      state.planFeedbackPending = false;
      startInteractiveAgentWithMessage(message, permOverride);
      return;
    }

    if (project.status !== 'running') return;

    doSendMessage(message);
  }

  // formatNumber is already defined above using Formatters.formatNumberCompact

  /**
   * @param {string} message
   * @param {boolean} [noHop] this call is already the second half of a handoff
   *   between sending and starting, so it must not hand off again. The two
   *   recoveries are exact opposites, and a server flapping between states would
   *   otherwise bounce the same message back and forth forever.
   * @param {boolean} [skipEcho] the message is already on screen. Deliberately
   *   separate from noHop: coming *from* the start path nothing was echoed yet
   *   (startInteractiveAgentWithMessage only appends on success), so conflating the
   *   two silently hid the user's own message while the agent answered it.
   */
  function doSendMessage(message, noHop, skipEcho) {
    if (state.messageSending) return;

    var $input = $('#input-message');
    var images = state.pendingImages.slice(); // Copy the array
    var project = findProjectById(state.selectedProjectId);

    state.messageSending = true;

    // Mark as no longer waiting for input since we're sending a message
    // Increment version to ignore stale updates from server
    if (project) {
      project.isWaitingForInput = false;
      state.waitingVersion++;
      renderProjectList();
      AgentControlsModule.setAgentWaiting(false);
    }

    // Disable input while sending
    var isTouchDevice = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

    // Build user message with images
    var userMessage = {
      type: 'user',
      content: message,
      timestamp: new Date().toISOString()
    };

    if (images.length > 0) {
      userMessage.images = images.map(function(img) {
        return { dataUrl: img.dataUrl, mimeType: img.mimeType };
      });
    }

    // Add user message to conversation
    if (!skipEcho) {
      appendMessage(state.selectedProjectId, userMessage);
    }

    updateCancelButton();

    var isPlanFeedback = state.planFeedbackPending;
    state.planFeedbackPending = false;

    var jqXHR = api.sendAgentMessage(state.selectedProjectId, message, images, isPlanFeedback);

    // The lock lives exactly as long as the request does. A request that never
    // settles (dropped tunnel, sleeping phone) is caught by the TTL instead of
    // parking the composer forever, and state.messageSending is released with it
    // so sendMessage() cannot start silently refusing either.
    ComposerGate.hold('sending', {
      isLive: function() {
        // Unknown means alive here, the opposite of the composer's bias. Releasing
        // this lock clears state.messageSending, so guessing "finished" while the
        // POST is still open would let the same message be sent twice. The TTL is
        // what bounds it when we genuinely cannot tell.
        if (!jqXHR.state) return true;
        return jqXHR.state() === 'pending';
      },
      ttlMs: ComposerGate.TTL.SENDING,
      projectId: state.selectedProjectId
    });

    jqXHR
      .done(function() {
        $input.val('').trigger('input');
        ImageAttachmentModule.clearAll();
      })
      .fail(function(xhr) {
        var code = xhr.responseJSON && xhr.responseJSON.code;

        // The server says nothing is running, so this project's status was a
        // stale belief. Start the agent with the same message rather than making
        // the user read an error and press send again — the message is already
        // in hand and the intent is unambiguous.
        if (code === 'AGENT_NOT_RUNNING' && !noHop) {
          updateProjectStatusById(state.selectedProjectId, 'stopped');
          // The bubble is already on screen from the optimistic append above, so
          // the start path must not echo it a second time — and must not hand it
          // back here if it in turn finds an agent already running.
          startInteractiveAgentWithMessage(message, null, true);
          return;
        }

        // The text is deliberately left in the composer on failure — clearing it
        // would destroy what the user wrote. Only .done() clears.
        showErrorToast(xhr, 'Failed to send message');
      })
      .always(function() {
        state.messageSending = false;
        ComposerGate.release('sending');
        if (isTouchDevice) {
          $input.attr('inputmode', 'none');
        } else if (!$input.prop('disabled')) {
          $input.focus();
        }
      });
  }

  // showPlanRecoveryCard() lived here. It repaired the plan card after the server
  // rejected a send with PLAN_APPROVAL_PENDING — a rejection the server no longer
  // issues, because a pending plan now consumes the user's message instead of
  // refusing it. Removed rather than kept "just in case": code no path reaches is
  // code no test covers.

  /**
   * @param {string} message
   * @param {string|null} permissionModeOverride
   * @param {boolean} [fromRecovery] this call is the second half of a handoff from
   *   doSendMessage(). The message is already on screen, so it must not be echoed
   *   again, and no further handoff may be attempted.
   */
  function startInteractiveAgentWithMessage(message, permissionModeOverride, fromRecovery) {
    if (state.agentStarting) {
      showToast('에이전트를 시작하는 중입니다. 잠시만 기다려주세요.', 'info');
      return;
    }

    // Don't start agent if Ralph Loop is running
    if (state.isRalphLoopRunning) {
      showToast('Cannot start agent while Ralph Loop is running', 'warning');
      return;
    }

    var $input = $('#input-message');
    var projectId = state.selectedProjectId;
    var images = state.pendingImages.slice(); // Copy the array
    var project = findProjectById(projectId);

    // Use conversation ID as session ID to resume Claude session
    // (conversation IDs are now UUIDs that match Claude session IDs)
    var sessionId = state.currentConversationId || null;

    state.agentStarting = true;

    // Mark as no longer waiting for input since we're starting with a message
    // Increment version to ignore stale updates from server
    if (project) {
      project.isWaitingForInput = false;
      state.waitingVersion++;
      renderProjectList();
    }

    // Disable input while starting
    var isTouchDevice = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    showContentLoading(sessionId ? 'Resuming session...' : 'Starting agent...');

    var permissionMode = permissionModeOverride || state.permissionMode;
    var startXHR = api.startInteractiveAgent(projectId, message, images, sessionId, permissionMode);

    // Tagged with the project: switching away releases it, so the old
    // same-project guard in .always() can no longer leave a project locked.
    ComposerGate.hold('starting', {
      isLive: function() {
        // Same bias as 'sending': releasing clears state.agentStarting, and a
        // second start attempt against a half-started agent is worse than waiting
        // for the TTL.
        if (!startXHR.state) return true;
        return startXHR.state() === 'pending';
      },
      ttlMs: ComposerGate.TTL.STARTING,
      projectId: projectId
    });

    startXHR
      .done(function(response) {
        state.currentAgentMode = 'interactive';
        updateProjectStatusById(projectId, 'running');
        startAgentStatusPolling(projectId);

        // Show warning if Docker fell back to host execution
        if (response && response.dockerFallback) {
          showToast('Docker container failed to start: ' + (response.dockerFallbackReason || 'unknown error') + '. Falling back to host execution.', 'warning');
        } else if (response && response.containerRestarted) {
          showToast('Docker container was started with image: ' + (response.containerImageName || 'unknown'), 'info');
        }

        // Update session and conversation IDs from response
        if (response && response.sessionId) {
          state.currentSessionId = response.sessionId;
        }
        if (response && response.conversationId) {
          state.currentConversationId = response.conversationId;
        }

        if (!fromRecovery) {
          // Build user message with images
          var userMessage = {
            type: 'user',
            content: message,
            timestamp: new Date().toISOString()
          };

          if (images.length > 0) {
            userMessage.images = images.map(function(img) {
              return { dataUrl: img.dataUrl, mimeType: img.mimeType };
            });
          }

          // Add user message to conversation
          appendMessage(projectId, userMessage);
        }

        // Clear input and images
        $input.val('').trigger('input');
        ImageAttachmentModule.clearAll();
        updateInputArea();
        updateCancelButton();
      })
      .fail(function(xhr) {
        var code = xhr.responseJSON && xhr.responseJSON.code;

        // An agent is already up, so this project's status was a stale belief in
        // the other direction. Deliver the message to the running agent instead
        // of discarding it and showing an error the user can only answer by
        // retyping. Mirrors the AGENT_NOT_RUNNING recovery in doSendMessage().
        if (code === 'AGENT_ALREADY_RUNNING' && !fromRecovery) {
          updateProjectStatusById(projectId, 'running');
          state.agentStarting = false;
          ComposerGate.release('starting');
          // noHop = true, skipEcho = false: nothing was echoed on this path, because
          // this function only appends the user message once the start succeeds.
          doSendMessage(message, true, false);
          return;
        }

        if (xhr.status === 409 && xhr.responseJSON && xhr.responseJSON.code === 'CONFLICT' && xhr.responseJSON.error && xhr.responseJSON.error.includes('limit')) {
          showToast(xhr.responseJSON.error, 'warning');
        } else {
          showErrorToast(xhr, 'Failed to start agent');
        }
      })
      .always(function() {
        state.agentStarting = false;
        // Released unconditionally — the lock is the composer's, not this view's,
        // so it must not survive just because the user changed project mid-start.
        ComposerGate.release('starting');

        if (state.selectedProjectId === projectId) {
          hideContentLoading();
          if (isTouchDevice) {
            $input.attr('inputmode', 'none');
          } else if (!$input.prop('disabled')) {
            $input.focus();
          }
        }
      });
  }

  // Image handling functions
  // Image attachment functions are now in ImageAttachmentModule

  function setupTextareaKeyHandlers() {
    // Prevent Enter from submitting forms in textareas
    // Allow Ctrl+Enter (or Cmd+Enter on Mac) to submit
    $(document).on('keydown', 'textarea', function(e) {
      if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+Enter or Cmd+Enter: submit the form
          e.preventDefault();
          var $form = $(this).closest('form');

          if ($form.length) {
            $form.submit();
          }
        }
        // Plain Enter: allow default behavior (newline)
        // Do nothing - let the textarea handle it naturally
      }
    });
  }

  function setupCharacterCountHandlers() {
    var $textarea = $('#input-edit-roadmap');
    var $charCount = $('#edit-roadmap-char-count');

    function updateCharCount() {
      var length = $textarea.val().length;
      var text = length === 1 ? '1 character' : length + ' characters';
      $charCount.text(text);
    }

    $textarea.on('input', updateCharCount);

    // Reset character count when form is reset
    $('#form-edit-roadmap').on('reset', function() {
      setTimeout(function() {
        updateCharCount();
      }, 0);
    });
  }

  function setupAutoResizeTextareas() {
    function autoResize(textarea) {
      var $textarea = $(textarea);
      var maxHeight = parseInt($textarea.css('max-height'), 10) || 300;

      // Reset height to auto to calculate scroll height
      textarea.style.height = 'auto';

      // Calculate new height
      var newHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = newHeight + 'px';

      // Add expanded class if content exceeds max height
      if (textarea.scrollHeight > maxHeight) {
        $textarea.addClass('expanded');
      } else {
        $textarea.removeClass('expanded');
      }
    }

    // Apply auto-resize to all textareas with the class
    $(document).on('input', '.textarea-auto-resize', function() {
      autoResize(this);
    });

    // Reset height when form is reset
    $(document).on('reset', 'form', function() {
      var $form = $(this);

      setTimeout(function() {
        $form.find('.textarea-auto-resize').each(function() {
          this.style.height = 'auto';
          $(this).removeClass('expanded');
        });
      }, 0);
    });

    // Initialize existing auto-resize textareas
    $('.textarea-auto-resize').each(function() {
      autoResize(this);
    });
  }

  function setupFormHandlers() {
    $('#form-add-project').on('submit', function(e) {
      e.preventDefault();
      handleAddProject($(this));
    });

    $('#form-create-roadmap').on('submit', function(e) {
      e.preventDefault();
      handleCreateRoadmap($(this));
    });

    $('#form-edit-roadmap').on('submit', function(e) {
      e.preventDefault();
      handleEditRoadmap($(this));
    });

    $('#form-roadmap-response').on('submit', function(e) {
      e.preventDefault();
      handleRoadmapResponse($(this));
    });

    $('#form-settings').on('submit', function(e) {
      e.preventDefault();
      handleSaveSettings($(this));
    });

    // Cancel button handler for settings modal
    $('#btn-cancel-settings').on('click', function() {
      if (state.hasUnsavedMcpChanges) {
        checkUnsavedMcpChanges().then(function(shouldClose) {
          if (shouldClose) {
            closeAllModals();
          }
        });
      } else {
        closeAllModals();
      }
    });

    setupTextareaKeyHandlers();
    setupCharacterCountHandlers();
    setupAutoResizeTextareas();

    // MCP servers changed handler
    $(document).on('mcp-servers-changed', function() {
      state.hasUnsavedMcpChanges = true;
      $('#mcp-unsaved-warning').removeClass('hidden');
      $('#modal-settings .modal-header').addClass('has-unsaved');
      $('#btn-save-settings').addClass('has-changes');
    });

    // MCP enabled checkbox handler
    $('#input-mcp-enabled').on('change', function() {
      state.hasUnsavedMcpChanges = true;
      $('#mcp-unsaved-warning').removeClass('hidden');
      $('#modal-settings .modal-header').addClass('has-unsaved');
      $('#btn-save-settings').addClass('has-changes');
    });

    // Folder browser button handlers are in FolderBrowserModule.setupHandlers()

    $('#btn-confirm-delete').on('click', function() {
      confirmDeleteProject();
    });
  }

  // Action handlers
  function selectProject(projectId) {
    var previousId = state.selectedProjectId;

    if (previousId && previousId !== projectId) {
      // Save current input text for the previous project
      var currentInput = $('#input-message').val() || '';
      state.projectInputs[previousId] = currentInput;

      // Don't clear Ralph Loop state - will be loaded from server

      unsubscribeFromProject(previousId);
      stopAgentStatusPolling(); // Stop polling for previous project
      FileCache.clear(); // Clear read file cache when switching projects
      // Clear tasks when switching projects
      state.currentTodos = [];
      TaskDisplayModule.updateButtonBadge();
      // Hide any loading overlay from previous project's operations
      hideContentLoading();
      // Clear file browser state for new project
      state.fileBrowser.expandedDirs = {};
      state.fileBrowser.selectedFile = null;
      state.fileBrowser.rootEntries = [];
      // Clear git state for new project
      state.git.expandedDirs = {};
      state.git.selectedFile = null;
      // Notify shell module of project change
      ShellModule.onProjectChanged(projectId);
      // Notify Ralph Loop module of project change
      if (RalphLoopModule) {
        RalphLoopModule.onProjectChanged();
      }

      // Notify OneOffTabsModule of project change
      if (typeof OneOffTabsModule !== 'undefined') {
        OneOffTabsModule.onProjectChanged(projectId);
        if (projectId) {
          OneOffTabsModule.loadActiveOneOffAgents(projectId);
        }
      }

      // Notify GitHubIssuesModule of project change
      if (typeof GitHubIssuesModule !== 'undefined') {
        GitHubIssuesModule.onProjectChanged(projectId);
      }

      // Notify RunConfigsModule of project change
      if (RunConfigsModule) {
        RunConfigsModule.onProjectChanged();
      }
    }

    state.selectedProjectId = projectId;

    // Restore per-project permission mode
    PermissionModeModule.onProjectChanged(projectId);

    // Load per-project approval mode + rehydrate pending approvals
    if (typeof ApprovalModule !== 'undefined') {
      ApprovalModule.loadMode(projectId, function(mode) {
        updateApprovalModeButtons(mode);
      });
      ApprovalModule.rehydrateForProject(projectId);
    }

    // Restore input text for the new project
    var savedInput = state.projectInputs[projectId] || '';
    $('#input-message').val(savedInput).trigger('input');
    state.currentAgentMode = null; // Reset on project change
    setPromptHintState(null); // Clear any prompt hint on project change
    // Nothing held for the project we just left can be answered on this screen.
    ComposerGate.releaseAll('project changed');
    var project = findProjectById(projectId);

    // Store current project with full data including path
    state.currentProject = project;

    // Save selected project to localStorage
    saveToLocalStorage(LOCAL_STORAGE_KEYS.SELECTED_PROJECT, projectId);

    // Clear stale conversation state so renderConversation shows placeholder
    // instead of old messages while the AJAX history load is in flight.
    state.conversations[projectId] = [];

    subscribeToProject(projectId);
    loadConversationHistory(projectId);
    updateSelectedProject();
    renderProjectDetail(project);
    loadAgentStatus(projectId);
    loadRalphLoopStatus(projectId);
    loadDockerStatus(projectId);
    TaskDisplayModule.loadOptimizationsBadge(projectId);
    checkGitHubAvailable();

    // Restore saved tab preference and refresh tab content
    var savedTab = loadFromLocalStorage(LOCAL_STORAGE_KEYS.ACTIVE_TAB, 'agent-output');

    if (savedTab && savedTab !== state.activeTab) {
      switchTab(savedTab);
    } else {
      // Even if same tab, refresh its content for the new project
      refreshCurrentTabContent();
    }

    // Refresh debug panel if open
    if (state.debugPanelOpen) {
      DebugModal.refresh();
    }
  }

  function loadAgentStatus(projectId) {
    // Note: WebSocket now sends status immediately on subscribe,
    // but we keep this API call as a fallback for initial load
    api.getAgentStatus(projectId)
      .done(function(data) {
        var project = findProjectById(projectId);

        // Capture session ID if present
        if (data.sessionId) {
          state.currentSessionId = data.sessionId;
        }

        // Sync permission mode from server
        if (data.permissionMode) {
          PermissionModeModule.syncFromServer(data.permissionMode, projectId);

          if (typeof OneOffToolbarModule !== 'undefined' && OneOffToolbarModule) {
            OneOffToolbarModule.syncPermissionMode(state.permissionMode);
          }
        }

        // Update isWaitingForInput on the project (only if server version is newer)
        if (project && typeof data.isWaitingForInput === 'boolean') {
          var serverVersion = data.waitingVersion || 0;
          var projectVersion = project.waitingVersion || 0;

          // When subscribing to a project, always accept the server state if version is different
          if (serverVersion > projectVersion || serverVersion === 0) {
            project.waitingVersion = serverVersion;
            project.isWaitingForInput = data.isWaitingForInput;

            // Update global state
            if (serverVersion > state.waitingVersion) {
              state.waitingVersion = serverVersion;
            }

            // Sync the working indicator only with this fresher status. Doing it
            // unconditionally would let a stale poll (server reports isWaiting=false
            // for ~3s after a turn ends) override the accurate WebSocket turn-end
            // signal and restart the verb animation.
            if (projectId === state.selectedProjectId) {
              AgentControlsModule.setAgentWaiting(data.isWaitingForInput);
            }
          }
        }

        if (data.status === 'running' && data.mode) {
          state.currentAgentMode = data.mode;
          state.queuedMessageCount = data.queuedMessageCount || 0;
          showAgentRunningIndicator(true);
          // Re-sync waiting state: showAgentRunningIndicator resets agentWaiting to false
          if (projectId === state.selectedProjectId && typeof data.isWaitingForInput === 'boolean') {
            AgentControlsModule.setAgentWaiting(data.isWaitingForInput);
          }
          updateQueuedMessagesDisplay();
          startAgentStatusPolling(projectId); // Start polling as fallback
        } else {
          showAgentRunningIndicator(false);
          state.queuedMessageCount = 0;
          updateQueuedMessagesDisplay();
          stopAgentStatusPolling();
        }

        // Must run before updateInputArea(): it reads state.activePromptType, so
        // the plan lock has to be reconciled first or the composer flips to the
        // wrong state for one render.
        syncPlanBlockingState(projectId, data);

        updateStartStopButtons();
        updateInputArea();
        updateCancelButton();
        PermissionModeModule.updatePendingIndicator();
      })
      .fail(function() {
        updateStartStopButtons();
        updateInputArea();
        showAgentRunningIndicator(false);
        state.queuedMessageCount = 0;
        updateQueuedMessagesDisplay();
        stopAgentStatusPolling();
        updateCancelButton();
        PermissionModeModule.updatePendingIndicator();
      });

    // Also get current conversation from project
    $.get('/api/projects/' + projectId)
      .done(function(project) {
        state.currentConversationId = project.currentConversationId || null;
        // Stats will be updated when loadConversationHistory completes
      });

    // Load project model configuration
    loadProjectModel(projectId);

    // Load project agent profile
    loadProjectAgentProfile(projectId);
  }

  function loadDockerStatus(projectId) {
    if (!projectId) {
      $('#docker-host-indicator').addClass('hidden');
      return;
    }

    api.getProjectDocker(projectId)
      .done(function(data) {
        updateDockerIndicator(data.effectiveDocker, data.imageName, data.dockerImage);
      })
      .fail(function() {
        $('#docker-host-indicator').addClass('hidden');
      });
  }

  function getShortImageName(imageName) {
    if (!imageName) return '';

    // Strip common registry prefixes and show just name:tag
    var parts = imageName.split('/');
    return parts[parts.length - 1] || imageName;
  }

  function updateDockerIndicator(effectiveDocker, imageName, dockerImage) {
    var $indicator = $('#docker-host-indicator');
    var $icon = $('#docker-indicator-icon');
    var $btn = $('#docker-indicator-btn');
    var $label = $('#docker-indicator-label');

    $indicator.removeClass('hidden');

    // Store current docker image state for dropdown
    state.currentDockerImage = dockerImage || null;
    state.currentEffectiveImage = imageName || null;

    if (effectiveDocker) {
      $indicator.removeClass('text-gray-500').addClass('text-cyan-400');
      $icon.html('<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 3H3v7h18V3zM21 14H3v7h18v-7zM7 6.5h.01M7 17.5h.01"/>');
      var shortName = getShortImageName(imageName);
      $label.text(shortName).removeClass('hidden');
      $btn.attr('title', 'Docker: ' + (imageName || 'default') + ' (click to change)');
    } else {
      $indicator.removeClass('text-cyan-400').addClass('text-gray-500');
      $icon.html('<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>');
      $label.text('').addClass('hidden');
      $btn.attr('title', 'Running on host machine');
    }
  }

  function toggleDockerImageDropdown() {
    var $dropdown = $('#docker-image-dropdown');

    if (!$dropdown.hasClass('hidden')) {
      $dropdown.addClass('hidden');
      return;
    }

    // Only show dropdown when Docker is effective
    if (!state.currentEffectiveImage) return;

    $dropdown.html('<div class="px-3 py-2 text-gray-400 text-xs">Loading images...</div>');
    $dropdown.removeClass('hidden');

    api.getDockerImages()
      .done(function(images) {
        renderDockerImageDropdown(images);
      })
      .fail(function() {
        $dropdown.html('<div class="px-3 py-2 text-red-400 text-xs">Failed to load images</div>');
      });
  }

  function renderDockerImageDropdown(images) {
    var $dropdown = $('#docker-image-dropdown');
    var html = '';
    var currentImage = state.currentDockerImage;

    // "Use default" option
    var isDefault = !currentImage;
    html += '<button class="docker-image-option w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors flex items-center gap-2' +
      (isDefault ? ' text-cyan-400' : ' text-gray-300') + '" data-image="">' +
      (isDefault ? '<span class="text-cyan-400">*</span>' : '<span class="w-2"></span>') +
      '<span>Default (global setting)</span></button>';

    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var fullName = img.name + ':' + img.tag;
      var isSelected = currentImage === fullName;
      html += '<button class="docker-image-option w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors flex items-center gap-2' +
        (isSelected ? ' text-cyan-400' : ' text-gray-300') + '" data-image="' + escapeHtml(fullName) + '">' +
        (isSelected ? '<span class="text-cyan-400">*</span>' : '<span class="w-2"></span>') +
        '<span>' + escapeHtml(fullName) + '</span></button>';
    }

    if (images.length === 0) {
      html += '<div class="px-3 py-2 text-gray-500 text-xs">No images found</div>';
    }

    $dropdown.html(html);
  }

  function handleDockerImageSelection(selectedImage) {
    var $dropdown = $('#docker-image-dropdown');
    $dropdown.addClass('hidden');

    var projectId = state.selectedProjectId;
    if (!projectId) return;

    var dockerImage = selectedImage || null;

    api.setProjectDocker(projectId, { dockerImage: dockerImage })
      .done(function() {
        loadDockerStatus(projectId);
        showToast('Image will take effect on next agent start', 'info');
      })
      .fail(function() {
        showToast('Failed to update Docker image', 'error');
      });
  }

  function loadRalphLoopStatus(projectId) {
    if (!projectId) return;

    api.getRalphLoops(projectId)
      .done(function(loops) {
        // Find active loop (worker_running, reviewer_running, or paused)
        var activeLoop = loops.find(function(loop) {
          return loop.status === 'worker_running' ||
                 loop.status === 'reviewer_running' ||
                 loop.status === 'paused';
        });

        if (activeLoop) {
          state.currentRalphLoopId = activeLoop.taskId;

          // Set iteration info from the loaded loop
          if (activeLoop.currentIteration !== undefined && activeLoop.config && activeLoop.config.maxTurns !== undefined) {
            state.ralphLoopCurrentIteration = activeLoop.currentIteration;
            state.ralphLoopMaxTurns = activeLoop.config.maxTurns;
          }

          updateRalphLoopControls(activeLoop.status);

          // Notify Ralph Loop module if it exists
          if (window.RalphLoopModule) {
            RalphLoopModule.setCurrentLoop(activeLoop);
          }
        } else {
          // No active loop - ensure UI is clear
          state.currentRalphLoopId = null;
          state.ralphLoopCurrentIteration = null;
          state.ralphLoopMaxTurns = null;
          updateRalphLoopControls(null);
        }
      })
      .fail(function() {
        // On error, ensure UI is clear
        state.currentRalphLoopId = null;
        state.ralphLoopCurrentIteration = null;
        state.ralphLoopMaxTurns = null;
        updateRalphLoopControls(null);
      });
  }

  // 모델 목록/표시명/기본값의 유일한 출처는 백엔드 src/config/models.ts 이고,
  // 프론트에서는 ModelCatalog 모듈이 그 사본을 들고 있는다.
  // (자세한 배경은 public/js/modules/model-catalog.js 주석 참고)
  var MODEL_SELECT_IDS = [
    'project-model-select',
    'ralph-config-worker-model',
    'ralph-config-reviewer-model'
  ];

  function populateModelSelects() {
    MODEL_SELECT_IDS.forEach(function(id) {
      ModelCatalog.populateSelect($('#' + id));
    });
  }

  function loadModelCatalog() {
    return ModelCatalog.load()
      .done(populateModelSelects)
      .fail(function() {
        // 카탈로그를 못 받으면 드롭다운이 비어 버린다. 조용히 넘어가면 사용자는
        // "모델을 못 고르는" 상태를 원인 없이 겪게 되므로 표면화한다.
        showToast('모델 목록을 불러오지 못했습니다. 새로고침 해주세요.', 'warning');
      });
  }

  function loadProjectModel(projectId) {
    api.getProjectModel(projectId)
      .done(function(data) {
        // data = { projectModel, defaultModel, effectiveModel, availableModels }
        // 이 응답 자체가 목록의 출처이기도 하다. 카탈로그가 아직 안 왔으면 여기서 채운다.
        if (!ModelCatalog.isLoaded() && data.availableModels) {
          ModelCatalog.setModels(data.availableModels);
          populateModelSelects();
        }

        ModelCatalog.setDefault(data.defaultModel);

        // override 가 없으면 실제로 적용되는 값(effectiveModel = 백엔드 기본값)을 보여준다.
        // 예전에는 'claude-sonnet-4-6' 을 박아둬서, 실제로는 Opus 5 로 돌면서
        // 화면만 Sonnet 4.6 이라고 표시하는 거짓말을 했다.
        $('#project-model-select').val(data.projectModel || data.effectiveModel || '');
        state.currentProjectModel = data.projectModel;
        state.effectiveModel = data.effectiveModel;
        state.globalDefaultModel = data.defaultModel;
        updateModelSelectorTitle(data);
      })
      .fail(function() {
        state.currentProjectModel = null;
      });
  }

  function loadProjectAgentProfile(projectId) {
    // Populate the profile selector with available profiles
    api.getSettings()
      .done(function(settings) {
        var profiles = (settings && settings.agentProfiles) || [];
        var $select = $('#project-profile-select');
        $select.empty();

        profiles.forEach(function(p) {
          var label = p.name + (p.isDefault ? ' (default)' : '');
          $select.append('<option value="' + p.id + '">' + label + '</option>');
        });

        // Now load the project's selected profile
        api.getProjectAgentProfile(projectId)
          .done(function(data) {
            var profileId = data.agentProfileId || (data.effectiveProfile && data.effectiveProfile.id) || '';
            $select.val(profileId);
            state.currentProjectProfileId = data.agentProfileId;
          })
          .fail(function() {
            // Default to first option
            state.currentProjectProfileId = null;
          });
      });
  }

  function updateModelSelectorTitle(modelData) {
    var title;

    if (modelData.projectModel) {
      title = 'Using: ' + getModelDisplayName(modelData.projectModel) + ' (project override)';
    } else {
      // 기본값 이름도 하드코딩하지 않는다 - 백엔드 DEFAULT_MODEL 이 바뀌면 같이 바뀐다.
      var fallback = modelData.effectiveModel || modelData.defaultModel;
      title = fallback
        ? 'Using: ' + getModelDisplayName(fallback) + ' (default)'
        : 'Select Claude model for this project';
    }

    $('#model-selector').attr('title', title);
  }

  function getModelDisplayName(modelId) {
    return ModelCatalog.getDisplayName(modelId);
  }

  function handleProjectModelChange(model) {
    var projectId = state.selectedProjectId;

    if (!projectId) return;

    api.setProjectModel(projectId, model)
      .done(function(response) {
        state.currentProjectModel = model;
        state.effectiveModel = response.effectiveModel || model || state.globalDefaultModel;

        var displayName = model ? getModelDisplayName(model) : 'Default';
        showToast('Model changed to ' + displayName, 'success');

        updateModelSelectorTitle({
          projectModel: model,
          effectiveModel: state.effectiveModel,
          globalDefault: state.globalDefaultModel
        });

        // Sync one-off tab toolbars
        if (typeof OneOffToolbarModule !== 'undefined' && OneOffToolbarModule) {
          OneOffToolbarModule.syncModel(model);
        }

        // Note: If an agent is running, it will continue with the old model
        // until it is restarted. The backend handles restart if needed.
        var project = findProjectById(projectId);

        if (project && project.status === 'running') {
          showToast('Agent will use the new model after restart', 'info');
        }
      })
      .fail(function(xhr) {
        // 저장에 실패했으므로 드롭다운을 서버가 실제로 갖고 있는 값으로 되돌린다.
        $('#project-model-select').val(state.currentProjectModel || state.effectiveModel || '');
        showErrorToast(xhr, 'Failed to change model');
      });
  }

  function handleProjectProfileChange(profileId) {
    var projectId = state.selectedProjectId;

    if (!projectId) return;

    api.updateProjectAgentProfile(projectId, profileId)
      .done(function(response) {
        state.currentProjectProfileId = profileId;
        var profileName = response.effectiveProfile ? response.effectiveProfile.name : 'Default';
        showToast('Agent profile changed to ' + profileName, 'success');

        var project = findProjectById(projectId);

        if (project && project.status === 'running') {
          showToast('Agent will use the new profile after restart', 'info');
        }
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to change agent profile');
      });
  }

  function showAgentRunningIndicator(isRunning, statusText) {
    AgentControlsModule.showAgentRunningIndicator(isRunning, statusText);
  }

  function checkShellEnabled(projectId) {
    api.isShellEnabled(projectId)
      .done(function(data) {
        state.shellEnabled = data.enabled;
      })
      .fail(function() {
        // If we can't check, assume enabled (fallback)
        state.shellEnabled = true;
      });
  }

  function showShellDisabledNotification() {
    var message = 'Shell is disabled because the server is bound to all interfaces (0.0.0.0). ' +
      'To enable, set CLAUDITO_FORCE_SHELL_ENABLED=1 or bind to a specific host (e.g., HOST=127.0.0.1).';
    showToast(message, 'warning');
  }

  /**
   * Reload history after the socket came back, without letting a flapping
   * connection turn into a pile of overlapping requests.
   *
   * A phone can reconnect several times in a few seconds, and a conversation holds
   * up to 1000 messages, so firing a full load per reconnect would put real weight
   * on the server for all three users at once. Skipping reconnects instead would
   * reintroduce the gap this exists to close, so the loads are *coalesced*: at most
   * one in flight, and if reconnects happened while it ran, exactly one more
   * follows. Correctness kept, concurrency bounded at one.
   */
  function backfillAfterReconnect(projectId) {
    if (!projectId) return;

    if (state.backfill.inFlight) {
      state.backfill.pendingProjectId = projectId;
      return;
    }

    state.backfill.inFlight = true;

    loadConversationHistory(projectId).always(function() {
      state.backfill.inFlight = false;
      var pending = state.backfill.pendingProjectId;
      state.backfill.pendingProjectId = null;

      if (pending) {
        backfillAfterReconnect(pending);
      }
    });
  }

  function loadConversationHistory(projectId) {
    return $.get('/api/projects/' + projectId + '/conversation')
      .done(function(data) {
        state.conversations[projectId] = data.messages || [];
        state.currentConversationStats = data.stats || null;
        state.currentConversationMetadata = data.metadata || null;
        state.currentConversationLabel = data.label || null;

        if (state.selectedProjectId === projectId) {
          renderConversation(projectId);
          ConversationHistoryModule.updateStats();
        }
      });
  }

  function findProjectById(id) {
    return state.projects.find(function(p) { return p.id === id; });
  }

  /**
   * Copy text to the clipboard. Uses the async Clipboard API when available
   * (https/localhost), falling back to a hidden textarea + execCommand so it
   * still works when Claudito is served over plain HTTP on a LAN.
   */
  function copyTextToClipboard(text, onSuccess) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      document.body.removeChild(ta);
      if (ok) {
        if (onSuccess) onSuccess();
      } else {
        showToast('Failed to copy', 'error');
      }
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        if (onSuccess) onSuccess();
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  function updateApprovalModeButtons(mode) {
    var $auto = $('#btn-approval-auto');
    var $ask = $('#btn-approval-ask');
    if (mode === 'ask') {
      $auto.removeClass('perm-active');
      $ask.addClass('perm-active');
    } else {
      $ask.removeClass('perm-active');
      $auto.addClass('perm-active');
    }
  }

  function changeApprovalMode(mode) {
    if (!state.selectedProjectId) return;
    if (typeof ApprovalModule === 'undefined') return;

    var project = findProjectById(state.selectedProjectId);
    var wasRunning = project && project.status === 'running';

    ApprovalModule.setMode(state.selectedProjectId, mode, function(ok) {
      if (!ok) return;
      updateApprovalModeButtons(mode);
      if (wasRunning) {
        showToast('Approval mode applies to the next agent start (restart to apply now)', 'info');
      }
    });
  }

  function handleAddProject($form) {
    var formData = {
      name: $form.find('[name="name"]').val(),
      path: $form.find('[name="path"]').val(),
      createNew: $form.find('[name="createNew"]').is(':checked')
    };

    api.addProject(formData)
      .done(function(project) {
        state.projects.push(project);
        renderProjectList();
        closeAllModals();
        $form[0].reset();
        showToast('Project added successfully', 'success');
        selectProject(project.id);
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to add project');
      });
  }

  // =========================================================================
  // GitHub Import
  // =========================================================================

  function openGitHubReposBrowser() {
    api.getGitHubStatus()
      .done(function(status) {
        if (!status.installed) {
          showToast('GitHub CLI is not installed. Install from https://cli.github.com', 'error');
          return;
        }

        if (!status.authenticated) {
          showToast('GitHub CLI is not authenticated. Run "gh auth login" first.', 'error');
          return;
        }

        state.selectedGitHubRepo = null;
        $('#github-repos-list').html(
          '<div class="text-center text-gray-500 text-sm py-8">Click "My Repos" to list your repositories or use Search</div>'
        );
        $('#btn-github-clone-selected').prop('disabled', true);
        openModal('modal-github-repos');
      })
      .fail(function() {
        showToast('Failed to check GitHub CLI status', 'error');
      });
  }

  function loadGitHubReposList() {
    var params = {};
    var owner = $('#github-repo-owner').val();
    var language = $('#github-repo-language').val();

    if (owner) params.owner = owner;

    if (language) params.language = language;

    params.limit = 50;

    $('#github-repos-list').html('<div class="text-center text-gray-400 text-sm py-8">Loading...</div>');

    api.getGitHubRepos(params)
      .done(function(repos) {
        renderGitHubReposList(repos);
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to load repos');
        $('#github-repos-list').html('<div class="text-center text-red-400 text-sm py-8">Failed to load repositories</div>');
      });
  }

  function searchGitHubRepos() {
    var query = $('#github-repo-search').val();

    if (!query) {
      showToast('Enter a search query', 'info');
      return;
    }

    var params = { query: query, limit: 50 };
    var language = $('#github-repo-language').val();

    if (language) params.language = language;

    $('#github-repos-list').html('<div class="text-center text-gray-400 text-sm py-8">Searching...</div>');

    api.searchGitHubRepos(params)
      .done(function(repos) {
        renderGitHubReposList(repos);
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to search repos');
        $('#github-repos-list').html('<div class="text-center text-red-400 text-sm py-8">Search failed</div>');
      });
  }

  function renderGitHubReposList(repos) {
    if (!repos || repos.length === 0) {
      $('#github-repos-list').html('<div class="text-center text-gray-500 text-sm py-8">No repositories found</div>');
      return;
    }

    repos.sort(function(a, b) {
      return a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase());
    });

    var html = repos.map(function(repo) {
      var langBadge = repo.language
        ? '<span class="text-xs bg-gray-700 px-1.5 py-0.5 rounded">' + escapeHtml(repo.language) + '</span>'
        : '';
      var visBadge = repo.isPrivate
        ? '<span class="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded">Private</span>'
        : '<span class="text-xs bg-green-900 text-green-300 px-1.5 py-0.5 rounded">Public</span>';

      return '<div class="github-repo-item p-2 rounded cursor-pointer hover:bg-gray-700 border border-transparent transition-colors" data-repo="' + escapeHtml(repo.fullName) + '">' +
        '<div class="flex items-center justify-between">' +
          '<div class="flex items-center gap-2 min-w-0">' +
            '<span class="text-sm font-medium text-white truncate">' + escapeHtml(repo.fullName) + '</span>' +
            visBadge +
            langBadge +
          '</div>' +
          '<span class="text-xs text-gray-500 flex-shrink-0">' + repo.stargazerCount + ' stars</span>' +
        '</div>' +
        (repo.description
          ? '<p class="text-xs text-gray-400 mt-1 truncate">' + escapeHtml(repo.description) + '</p>'
          : '') +
      '</div>';
    }).join('');

    $('#github-repos-list').html(html);
    state.selectedGitHubRepo = null;
    $('#btn-github-clone-selected').prop('disabled', true);

    $('#github-repos-list').off('click', '.github-repo-item').on('click', '.github-repo-item', function() {
      $('.github-repo-item').removeClass('border-purple-500 bg-gray-700').addClass('border-transparent');
      $(this).addClass('border-purple-500 bg-gray-700').removeClass('border-transparent');
      state.selectedGitHubRepo = $(this).data('repo');
      $('#btn-github-clone-selected').prop('disabled', false);
    });
  }

  function openGitHubCloneDialog() {
    if (!state.selectedGitHubRepo) return;

    $('#github-clone-repo').val(state.selectedGitHubRepo);
    $('#github-clone-target').val('');
    $('#github-clone-branch').val('');
    $('#github-clone-name').val('');
    $('#github-clone-progress').addClass('hidden').html('');
    $('#btn-github-do-clone').prop('disabled', false);
    openModal('modal-github-clone');
  }

  function doGitHubClone() {
    var repo = $('#github-clone-repo').val();
    var targetDir = $('#github-clone-target').val();
    var branch = $('#github-clone-branch').val();
    var projectName = $('#github-clone-name').val();

    if (!targetDir) {
      showToast('Please select a target directory', 'info');
      return;
    }

    var data = { repo: repo, targetDir: targetDir };

    if (branch) data.branch = branch;

    if (projectName) data.projectName = projectName;

    $('#btn-github-do-clone').prop('disabled', true);
    $('#github-clone-progress').removeClass('hidden').html('Cloning...');

    api.cloneGitHubRepo(data)
      .done(function(result) {
        if (result.success && result.project) {
          state.projects.push(result.project);
          renderProjectList();
          closeAllModals();
          showToast('Repository cloned and added as project', 'success');
          selectProject(result.project.id);
        } else {
          $('#github-clone-progress').html('<span class="text-red-400">' + escapeHtml(result.error || 'Clone failed') + '</span>');
          $('#btn-github-do-clone').prop('disabled', false);
        }
      })
      .fail(function(xhr) {
        var msg = 'Clone failed';

        try {
          var body = JSON.parse(xhr.responseText);
          msg = body.error || msg;
        } catch (e) { /* ignore */ }

        $('#github-clone-progress').html('<span class="text-red-400">' + escapeHtml(msg) + '</span>');
        $('#btn-github-do-clone').prop('disabled', false);
      });
  }

  function loadAndShowRoadmap() {
    if (!state.selectedProjectId) return;

    api.getProjectRoadmap(state.selectedProjectId)
      .done(function(data) {
        if (!data || !data.parsed) {
          openModal('modal-create-roadmap');
        } else {
          RoadmapModule.render(data);
          openModal('modal-roadmap');
        }
      })
      .fail(function() {
        openModal('modal-create-roadmap');
      });
  }

  function handleCreateRoadmap($form) {
    var prompt = $form.find('[name="prompt"]').val();

    if (!prompt || !state.selectedProjectId) {
      showToast('Please enter a project description', 'error');
      return;
    }

    closeAllModals();
    showRoadmapProgress();
    $form[0].reset();

    api.generateRoadmap(state.selectedProjectId, prompt)
      .done(function(result) {
        if (result.success) {
          showToast('Roadmap generated successfully', 'success');
        }
      })
      .fail(function(xhr) {
        state.roadmapGenerating = false;
        $('#roadmap-progress-spinner').addClass('hidden');
        $('#roadmap-progress-footer').removeClass('hidden');
        showErrorToast(xhr, 'Failed to generate roadmap');
      });
  }

  function handleEditRoadmap($form) {
    var prompt = $form.find('[name="editPrompt"]').val();

    if (!prompt || !state.selectedProjectId) {
      showToast('Please describe the changes you want', 'error');
      return;
    }

    closeAllModals();
    showRoadmapProgress();
    $form[0].reset();

    api.modifyRoadmap(state.selectedProjectId, prompt)
      .done(function(result) {
        state.roadmapGenerating = false;
        $('#roadmap-progress-spinner').addClass('hidden');
        $('#roadmap-question-input').addClass('hidden');
        $('#roadmap-progress-footer').removeClass('hidden');
        showToast('Roadmap modified successfully', 'success');
      })
      .fail(function(xhr) {
        state.roadmapGenerating = false;
        $('#roadmap-progress-spinner').addClass('hidden');
        $('#roadmap-question-input').addClass('hidden');
        $('#roadmap-progress-footer').removeClass('hidden');
        showErrorToast(xhr, 'Failed to modify roadmap');
      });
  }

  function handleRoadmapResponse($form) {
    var response = $form.find('[name="response"]').val();

    if (!response || !state.selectedProjectId) {
      return;
    }

    $form[0].reset();
    $('#roadmap-question-input').addClass('hidden');

    api.sendRoadmapResponse(state.selectedProjectId, response)
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to send response');
        $('#roadmap-question-input').removeClass('hidden');
      });
  }

  function startSelectedAgent() {
    if (!state.selectedProjectId) return;

    if (state.agentStarting) return;

    var projectId = state.selectedProjectId;
    var mode = 'interactive'; // Always interactive mode now

    state.agentStarting = true;
    setQuickActionLoading(projectId, true);
    showContentLoading('Starting agent...');
    $('#btn-start-agent').prop('disabled', true);

    var startPromise;

    if (mode === 'interactive') {
      startPromise = api.startInteractiveAgent(projectId, null, null, null, state.permissionMode);
    } else {
      startPromise = api.startAgent(projectId);
    }

    startPromise
      .done(function() {
        state.currentAgentMode = mode;
        updateProjectStatusById(projectId, 'running');
        startAgentStatusPolling(projectId);
        appendMessage(projectId, {
          type: 'system',
          content: mode === 'interactive' ?
            'Interactive session started. Type a message to begin.' :
            'Autonomous agent started...'
        });
        showToast('Agent started in ' + mode + ' mode', 'success');
        updateInputArea();
      })
      .fail(function(xhr) {
        if (xhr.status === 409 && xhr.responseJSON && xhr.responseJSON.code === 'CONFLICT' && xhr.responseJSON.error && xhr.responseJSON.error.includes('limit')) {
          showToast(xhr.responseJSON.error, 'warning');
        } else {
          showErrorToast(xhr, 'Failed to start agent');
        }
      })
      .always(function() {
        state.agentStarting = false;
        setQuickActionLoading(projectId, false);
        // Only hide loading and re-enable button if still viewing the same project
        if (state.selectedProjectId === projectId) {
          hideContentLoading();
          $('#btn-start-agent').prop('disabled', false);
        }
      });
  }

  function stopSelectedAgent() {
    if (!state.selectedProjectId) return;

    var projectId = state.selectedProjectId;
    setQuickActionLoading(projectId, true);
    showContentLoading('Stopping agent...');
    $('#btn-stop-agent').prop('disabled', true);
    $('#btn-restart-agent').prop('disabled', true);

    api.stopAgent(projectId)
      .done(function() {
        updateProjectStatusById(projectId, 'stopped');
        stopAgentStatusPolling();
        if (projectId === state.selectedProjectId) {
          showAgentRunningIndicator(false);
        }
        appendMessage(projectId, {
          type: 'system',
          content: 'Agent stopped.'
        });
        showToast('Agent stopped', 'success');
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to stop agent');
      })
      .always(function() {
        setQuickActionLoading(projectId, false);
        // Only hide loading and re-enable button if still viewing the same project
        if (state.selectedProjectId === projectId) {
          hideContentLoading();
          $('#btn-stop-agent').prop('disabled', false);
          $('#btn-restart-agent').prop('disabled', false);
        }
      });
  }

  function restartSelectedAgent() {
    if (!state.selectedProjectId) return;

    var projectId = state.selectedProjectId;
    var sessionId = state.currentSessionId;
    var permissionMode = state.permissionMode;

    showToast('Restarting agent...', 'info');
    $('#btn-stop-agent').prop('disabled', true);
    $('#btn-restart-agent').prop('disabled', true);

    // Helper function to start agent with delay
    function startAgentWithDelay() {
      api.startInteractiveAgent(projectId, '', [], sessionId, permissionMode)
        .done(function(response) {
          state.currentAgentMode = 'interactive';
          updateProjectStatusById(projectId, 'running');
          startAgentStatusPolling(projectId);

          if (response && response.sessionId) {
            state.currentSessionId = response.sessionId;
          }

          appendMessage(projectId, {
            type: 'system',
            content: 'Agent restarted',
            timestamp: new Date().toISOString()
          });

          showToast('Agent restarted', 'success');
        })
        .fail(function(xhr) {
          showErrorToast(xhr, 'Failed to restart agent');
          updateProjectStatusById(projectId, 'stopped');
        })
        .always(function() {
          $('#btn-stop-agent').prop('disabled', false);
          $('#btn-restart-agent').prop('disabled', false);
        });
    }

    // If already stopped, just start
    var project = findProjectById(projectId);
    if (project && project.status === 'stopped') {
      startAgentWithDelay();
    } else {
      // Stop first, then start
      api.stopAgent(projectId)
        .done(function() {
          updateProjectStatusById(projectId, 'stopped');
          setTimeout(startAgentWithDelay, 1000);
        })
        .fail(function(xhr) {
          showErrorToast(xhr, 'Failed to stop agent for restart');
          $('#btn-restart-agent').prop('disabled', false);
        });
    }
  }

  function cancelAgentOperation() {
    var projectId = state.selectedProjectId;

    if (!projectId) return;

    var project = findProjectById(projectId);

    if (!project || project.status !== 'running') return;

    // Cancel pending permission mode change if any
    state.pendingPermissionMode = null;
    PermissionModeModule.updatePendingIndicator();

    $('#btn-cancel-agent').prop('disabled', true);

    api.stopAgent(projectId)
      .done(function() {
        updateProjectStatusById(projectId, 'stopped');
        stopAgentStatusPolling();
        appendMessage(projectId, {
          type: 'system',
          content: 'Operation cancelled by user.'
        });
        showToast('Operation cancelled', 'info');
        updateCancelButton();
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to cancel operation');
      })
      .always(function() {
        $('#btn-cancel-agent').prop('disabled', false);
      });
  }

  function updateCancelButton() {
    AgentControlsModule.updateCancelButton();
  }

  // Agent status polling - reduced to 10 seconds as fallback (WebSocket is primary)
  function startAgentStatusPolling(projectId) {
    stopAgentStatusPolling();
    state.agentStatusInterval = setInterval(function() {
      checkAgentStatus(projectId);
    }, 10000);
  }

  /**
   * Stops the fast poll but keeps a slow reconcile running for the selected
   * project.
   *
   * Polling used to stop outright whenever the UI believed the agent was not
   * running, which made a single missed `agent_status` frame permanent: the badge
   * stayed on Error and nothing ever asked again. On a phone the WebSocket drops
   * constantly, and the only way out was switching project and back — which is
   * exactly what re-subscribing did. The slow poll makes the UI converge on its
   * own instead.
   */
  function stopAgentStatusPolling() {
    if (state.agentStatusInterval) {
      clearInterval(state.agentStatusInterval);
      state.agentStatusInterval = null;
    }

    if (state.agentReconcileInterval) {
      clearInterval(state.agentReconcileInterval);
      state.agentReconcileInterval = null;
    }

    var projectId = state.selectedProjectId;
    if (!projectId) return;

    state.agentReconcileInterval = setInterval(function() {
      // Give up as soon as the fast poll takes over again, or the user moves on.
      if (state.agentStatusInterval || state.selectedProjectId !== projectId) {
        clearInterval(state.agentReconcileInterval);
        state.agentReconcileInterval = null;
        return;
      }

      checkAgentStatus(projectId);
    }, 30000);
  }

  function checkAgentStatus(projectId) {
    api.getAgentStatus(projectId)
      .done(function(response) {
        var project = findProjectById(projectId);
        var actualStatus = response.status || 'stopped';

        // Capture session ID if present
        if (response.sessionId) {
          state.currentSessionId = response.sessionId;
        }

        // This poll runs every 10s and the route reconciles the plan lock before
        // answering, so a stale lock converges here within one interval even if
        // no WebSocket event ever arrives.
        syncPlanBlockingState(projectId, response);

        // Update isWaitingForInput from polling response (only if server version is newer)
        if (project && typeof response.isWaitingForInput === 'boolean') {
          var serverVersion = response.waitingVersion || 0;
          var projectVersion = project.waitingVersion || 0;

          if (serverVersion > projectVersion) {
            project.waitingVersion = serverVersion;
            var wasWaiting = project.isWaitingForInput;
            project.isWaitingForInput = response.isWaitingForInput;

            // Update global state for selected project
            if (state.selectedProjectId === projectId && serverVersion > state.waitingVersion) {
              state.waitingVersion = serverVersion;
            }

            // If waiting state changed, update UI and apply pending mode changes
            if (wasWaiting !== response.isWaitingForInput) {
              // Always re-render project list to update sidebar indicator
              renderProjectList();

              if (state.selectedProjectId === projectId) {
                updateCancelButton();

                if (response.isWaitingForInput) {
                  PermissionModeModule.applyPendingIfNeeded();
                }
              }
            }
          }
        }

        // Update queued message count
        var oldQueuedCount = state.queuedMessageCount;
        state.queuedMessageCount = response.queuedMessageCount || 0;

        if (state.queuedMessageCount !== oldQueuedCount) {
          updateQueuedMessagesDisplay();
        }

        // If agent stopped but UI shows running, update UI
        if (actualStatus !== 'running' && project && project.status === 'running') {
          updateProjectStatusById(projectId, actualStatus);
          stopAgentStatusPolling();
          if (projectId === state.selectedProjectId) {
            showAgentRunningIndicator(false);
          }
          state.currentAgentMode = null;
          state.queuedMessageCount = 0;
          updateQueuedMessagesDisplay();
          updateInputArea();
        }
      })
      .fail(function() {
        // On error, assume agent stopped
        stopAgentStatusPolling();
      });
  }

  function updateQueuedMessagesDisplay() {
    var $indicator = $('#queued-messages-indicator');
    var count = state.queuedMessageCount;
    var messageText = count === 1 ? 'message' : 'messages';

    if (count > 0) {
      if ($indicator.length === 0) {
        // Create indicator if it doesn't exist
        var html = '<button id="queued-messages-indicator" class="flex items-center gap-1 text-xs text-yellow-400 bg-yellow-900/30 hover:bg-yellow-900/50 px-2 py-0.5 rounded cursor-pointer transition-colors" title="Click to view queued messages">' +
          '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>' +
          '</svg>' +
          '<span class="queued-text">' + count + ' queued ' + messageText + '</span>' +
        '</button>';
        $('#agent-status-label').after(html);
      } else {
        $indicator.find('.queued-text').text(count + ' queued ' + messageText);
      }
    } else {
      $indicator.remove();
    }
  }

  function openQueuedMessagesModal() {
    if (!state.selectedProjectId) {
      return;
    }

    api.getQueuedMessages(state.selectedProjectId)
      .done(function(data) {
        var messages = data.messages || [];
        var $content = $('#queued-messages-modal-content');

        if (messages.length === 0) {
          $content.html('<div class="text-gray-500 text-center py-4">No queued messages</div>');
        } else {
          var html = '<div class="space-y-3">';

          for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];
            html += '<div class="bg-gray-900 rounded p-3" data-queue-index="' + i + '">' +
              '<div class="flex items-center justify-between mb-2">' +
                '<div class="flex items-center gap-2">' +
                  '<span class="text-xs font-medium text-yellow-400">#' + (i + 1) + '</span>' +
                  '<span class="text-xs text-gray-500">Waiting to be sent</span>' +
                '</div>' +
                '<button class="btn-remove-queued-message text-gray-500 hover:text-red-400 p-1 rounded hover:bg-gray-800 transition-colors" title="Remove from queue">' +
                  '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
                    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>' +
                  '</svg>' +
                '</button>' +
              '</div>' +
              '<div class="text-sm text-gray-200 whitespace-pre-wrap break-words">' + escapeHtml(msg) + '</div>' +
            '</div>';
          }

          html += '</div>';
          $content.html(html);
        }

        openModal('modal-queued-messages');
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to load queued messages');
      });
  }

  function openRalphLoopConfigModal() {
    if (!state.selectedProjectId) {
      showToast('Please select a project first', 'warning');
      return;
    }

    // Load current Ralph Loop status if any
    api.getRalphLoops(state.selectedProjectId)
      .done(function(loops) {
        // Check if there's an active loop
        var activeLoop = loops.find(function(loop) {
          return loop.status === 'worker_running' || loop.status === 'reviewer_running' || loop.status === 'paused';
        });

        if (activeLoop) {
          showToast('A Ralph Loop is already running for this project', 'warning');
          return;
        }

        // Reset form with default values from settings
        $('#ralph-config-task-description').val('');
        $('#ralph-config-max-turns').val(state.settings?.ralphLoop?.defaultMaxTurns || 5);
        // 설정에 없거나 카탈로그에서 사라진 모델이면 백엔드 기본값으로 떨어뜨린다.
        $('#ralph-config-worker-model').val(ModelCatalog.resolve(state.settings?.ralphLoop?.defaultWorkerModel));
        $('#ralph-config-reviewer-model').val(ModelCatalog.resolve(state.settings?.ralphLoop?.defaultReviewerModel));
        $('#ralph-config-worker-system-prompt').val('');
        $('#ralph-config-reviewer-system-prompt').val('');

        // Load and display default prompts
        var defaultWorkerPrompt = state.settings?.ralphLoop?.defaultWorkerSystemPrompt || '';
        var defaultReviewerPrompt = state.settings?.ralphLoop?.defaultReviewerSystemPrompt || '';
        $('#ralph-default-worker-prompt').text(defaultWorkerPrompt);
        $('#ralph-default-reviewer-prompt').text(defaultReviewerPrompt);

        // Reset to first tab
        $('.ralph-config-tab').removeClass('border-purple-500 text-white').addClass('border-transparent text-gray-400');
        $('.ralph-config-tab:first').addClass('border-purple-500 text-white').removeClass('border-transparent text-gray-400');
        $('.ralph-config-tab-content').addClass('hidden');
        $('#ralph-config-tab-config').removeClass('hidden');

        // Open the modal
        openModal('modal-ralph-loop-config');
      })
      .fail(function() {
        // If we can't check status, open anyway
        // Reset form with default values from settings
        $('#ralph-config-task-description').val('');
        $('#ralph-config-max-turns').val(state.settings?.ralphLoop?.defaultMaxTurns || 5);
        // 설정에 없거나 카탈로그에서 사라진 모델이면 백엔드 기본값으로 떨어뜨린다.
        $('#ralph-config-worker-model').val(ModelCatalog.resolve(state.settings?.ralphLoop?.defaultWorkerModel));
        $('#ralph-config-reviewer-model').val(ModelCatalog.resolve(state.settings?.ralphLoop?.defaultReviewerModel));
        $('#ralph-config-worker-system-prompt').val('');
        $('#ralph-config-reviewer-system-prompt').val('');

        // Load and display default prompts
        var defaultWorkerPrompt = state.settings?.ralphLoop?.defaultWorkerSystemPrompt || '';
        var defaultReviewerPrompt = state.settings?.ralphLoop?.defaultReviewerSystemPrompt || '';
        $('#ralph-default-worker-prompt').text(defaultWorkerPrompt);
        $('#ralph-default-reviewer-prompt').text(defaultReviewerPrompt);

        // Reset to first tab
        $('.ralph-config-tab').removeClass('border-purple-500 text-white').addClass('border-transparent text-gray-400');
        $('.ralph-config-tab:first').addClass('border-purple-500 text-white').removeClass('border-transparent text-gray-400');
        $('.ralph-config-tab-content').addClass('hidden');
        $('#ralph-config-tab-config').removeClass('hidden');

        openModal('modal-ralph-loop-config');
      });
  }

  function startRalphLoopFromModal() {
    if (!state.selectedProjectId) {
      return;
    }

    // Don't start Ralph Loop if agent is already running
    var project = findProjectById(state.selectedProjectId);
    if (project && project.status === 'running') {
      showToast('Cannot start Ralph Loop while agent is running', 'warning');
      return;
    }

    var taskDescription = $('#ralph-config-task-description').val().trim();
    if (!taskDescription) {
      showToast('Please enter a task description', 'warning');
      return;
    }

    var config = {
      taskDescription: taskDescription,
      maxTurns: parseInt($('#ralph-config-max-turns').val(), 10) || 5,
      workerModel: $('#ralph-config-worker-model').val(),
      reviewerModel: $('#ralph-config-reviewer-model').val(),
      workerSystemPrompt: $('#ralph-config-worker-system-prompt').val().trim() || undefined,
      reviewerSystemPrompt: $('#ralph-config-reviewer-system-prompt').val().trim() || undefined
    };

    // Close the modal
    closeModal('modal-ralph-loop-config');

    // Start the Ralph Loop
    api.startRalphLoop(state.selectedProjectId, config)
      .done(function(loopState) {
        showToast('Ralph Loop started', 'success');

        // Track the current Ralph Loop
        state.currentRalphLoopId = loopState.taskId;

        // Set initial iteration info from the returned state
        if (loopState.currentIteration !== undefined && loopState.config && loopState.config.maxTurns !== undefined) {
          state.ralphLoopCurrentIteration = loopState.currentIteration;
          state.ralphLoopMaxTurns = loopState.config.maxTurns;
        }

        updateRalphLoopControls('worker_running');

        // Mark project as running
        updateProjectStatusById(state.selectedProjectId, 'running');

        // Show Ralph Loop output in the agent conversation
        appendMessage(state.selectedProjectId, {
          type: 'system',
          content: 'Ralph Loop started: ' + taskDescription,
          timestamp: new Date().toISOString()
        });
      })
      .fail(function(xhr) {
        var message = xhr.responseJSON ? xhr.responseJSON.error : 'Failed to start Ralph Loop';
        showErrorToast(xhr, message);
      });
  }

  function handleRalphLoopMessage(type, data) {
    // Only show messages for the selected project
    if (data.projectId && data.projectId !== state.selectedProjectId) {
      return;
    }

    var message;
    var timestamp = new Date().toISOString();

    switch (type) {
      case 'ralph_loop_status':
        // Store iteration info in state
        if (data.currentIteration !== undefined && data.maxTurns !== undefined) {
          state.ralphLoopCurrentIteration = data.currentIteration;
          state.ralphLoopMaxTurns = data.maxTurns;
        }

        // Update the Ralph Loop controls
        updateRalphLoopControls(data.status);

        if (data.status === 'idle' || data.status === 'failed') {
          state.currentRalphLoopId = null;
          state.ralphLoopCurrentIteration = null;
          state.ralphLoopMaxTurns = null;
          // Mark project as stopped when Ralph Loop goes idle or fails
          updateProjectStatusById(state.selectedProjectId, 'stopped');
          return; // Don't show idle/failed status changes
        }

        // Track the current Ralph Loop
        if (data.taskId) {
          state.currentRalphLoopId = data.taskId;
        }

        message = {
          type: 'system',
          content: 'Ralph Loop: ' + formatRalphLoopStatus(data.status),
          timestamp: timestamp
        };
        break;

      case 'ralph_loop_iteration':
        // Update current iteration in state
        if (data.iteration !== undefined) {
          state.ralphLoopCurrentIteration = data.iteration;
          // Update the status display to show new iteration
          updateRalphLoopControls(state.isRalphLoopRunning ? 'worker_running' : 'reviewer_running');
        }

        message = {
          type: 'system',
          content: '--- Ralph Loop Iteration ' + data.iteration + ' started ---',
          timestamp: timestamp
        };
        break;

      case 'ralph_loop_output':
        message = {
          type: 'assistant',
          content: data.content,
          timestamp: data.timestamp || timestamp,
          ralphLoopPhase: data.phase // Add phase info for custom header
        };
        break;

      case 'ralph_loop_worker_complete':
        var workerMsg = 'Worker completed iteration ' + data.summary.iterationNumber;
        if (data.summary.filesModified && data.summary.filesModified.length > 0) {
          workerMsg += '\nFiles modified: ' + data.summary.filesModified.join(', ');
        }
        message = {
          type: 'system',
          content: workerMsg,
          timestamp: timestamp
        };
        break;

      case 'ralph_loop_reviewer_complete':
        var reviewerMsg = 'Reviewer decision: ' + data.feedback.decision;
        if (data.feedback.feedback) {
          reviewerMsg += '\nFeedback: ' + data.feedback.feedback;
        }
        message = {
          type: 'system',
          content: reviewerMsg,
          timestamp: timestamp
        };
        break;

      case 'ralph_loop_complete':
        message = {
          type: 'system',
          content: '=== Ralph Loop completed: ' + data.finalStatus + ' ===',
          timestamp: timestamp
        };
        // Clean up Ralph Loop state
        state.currentRalphLoopId = null;
        state.ralphLoopCurrentIteration = null;
        state.ralphLoopMaxTurns = null;
        updateRalphLoopControls(null);
        // Mark project as stopped
        updateProjectStatusById(state.selectedProjectId, 'stopped');

        // Clear the conversation history after completion
        // Delay clearing to ensure the completion message is shown first
        setTimeout(function() {
          var projectId = state.selectedProjectId;
          $.ajax({
            url: '/api/projects/' + projectId + '/conversation/clear',
            method: 'POST'
          }).done(function() {
            // Clear local state
            state.currentConversationId = null;
            state.currentConversationStats = null;
            state.currentConversationMetadata = null;
            state.currentConversationLabel = null;
            state.conversations[projectId] = [];
            renderConversation(projectId);
            ConversationHistoryModule.updateStats();
            showToast('Ralph Loop completed - history cleared', 'info');
          }).fail(function() {
            // Even if server fails, clear local state
            state.conversations[projectId] = [];
            renderConversation(projectId);
            ConversationHistoryModule.updateStats();
          });
        }, 1000); // 1 second delay to show completion message
        break;

      case 'ralph_loop_error':
        message = {
          type: 'system',
          content: 'Ralph Loop error: ' + data.error,
          timestamp: timestamp
        };
        // Clean up on error
        state.currentRalphLoopId = null;
        state.ralphLoopCurrentIteration = null;
        state.ralphLoopMaxTurns = null;
        updateRalphLoopControls(null);
        // Mark project as stopped
        updateProjectStatusById(state.selectedProjectId, 'stopped');
        break;

      case 'ralph_loop_tool_use':
        console.log('Frontend received ralph_loop_tool_use:', data);
        message = {
          type: 'tool_use',
          toolInfo: {
            name: data.tool_name,
            id: data.tool_id,
            input: data.parameters,
            status: 'running'
          },
          timestamp: data.timestamp || timestamp,
          ralphLoopPhase: data.phase
        };
        console.log('Created tool_use message:', message);
        break;

      default:
        return;
    }

    // Append the message to the conversation
    if (message) {
      appendMessage(state.selectedProjectId, message);
    }
  }

  function formatRalphLoopStatus(status) {
    switch (status) {
      case 'worker_running': return 'Worker running...';
      case 'reviewer_running': return 'Reviewer evaluating...';
      case 'paused': return 'Paused';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      default: return status;
    }
  }

  function formatRalphLoopStatusForLabel(status) {
    return AgentControlsModule.formatRalphLoopStatusForLabel(status);
  }

  function updateRalphLoopPauseButton(status) {
    var $pauseBtn = $('#btn-ralph-loop-pause');

    if (status === 'paused') {
      $pauseBtn
        .html('<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
              '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>' +
              '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>' +
              '</svg>Resume')
        .off('click')
        .on('click', function() {
          resumeRalphLoop();
        });
    } else {
      $pauseBtn
        .html('<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
              '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"/>' +
              '</svg>Pause')
        .off('click')
        .on('click', function() {
          pauseRalphLoop();
        });
    }
  }

  function pauseRalphLoop() {
    if (!state.selectedProjectId || !state.currentRalphLoopId) {
      return;
    }

    api.pauseRalphLoop(state.selectedProjectId, state.currentRalphLoopId)
      .done(function() {
        showToast('Ralph Loop paused', 'info');
        updateRalphLoopControls('paused');
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to pause Ralph Loop');
      });
  }

  function stopRalphLoop() {
    if (!state.selectedProjectId || !state.currentRalphLoopId) {
      return;
    }

    var projectId = state.selectedProjectId;

    api.stopRalphLoop(projectId, state.currentRalphLoopId)
      .done(function() {
        showToast('Ralph Loop stopped', 'info');
        state.currentRalphLoopId = null;
        updateRalphLoopControls(null);
        // Mark project as stopped
        updateProjectStatusById(projectId, 'stopped');

        // Clear the conversation history
        $.ajax({
          url: '/api/projects/' + projectId + '/conversation/clear',
          method: 'POST'
        }).done(function() {
          // Clear local state
          state.currentConversationId = null;
          state.currentConversationStats = null;
          state.currentConversationMetadata = null;
          state.currentConversationLabel = null;
          state.conversations[projectId] = [];
          renderConversation(projectId);
          ConversationHistoryModule.updateStats();
          showToast('Ralph Loop history cleared', 'info');
        }).fail(function() {
          // Even if server fails, clear local state
          state.conversations[projectId] = [];
          renderConversation(projectId);
          ConversationHistoryModule.updateStats();
        });
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to stop Ralph Loop');
      });
  }

  function updateRalphLoopControls(status) {
    AgentControlsModule.updateRalphLoopControls(status);
  }

  function resumeRalphLoop() {
    if (!state.selectedProjectId || !state.currentRalphLoopId) {
      return;
    }

    api.resumeRalphLoop(state.selectedProjectId, state.currentRalphLoopId)
      .done(function() {
        showToast('Ralph Loop resumed', 'success');
        updateRalphLoopControls('worker_running');
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to resume Ralph Loop');
      });
  }

  function removeQueuedMessage(index) {
    if (!state.selectedProjectId) {
      return;
    }

    api.removeQueuedMessage(state.selectedProjectId, index)
      .done(function() {
        showToast('Message removed from queue', 'success');
        state.queuedMessageCount = Math.max(0, state.queuedMessageCount - 1);
        updateQueuedMessagesDisplay();

        // Refresh the modal content
        openQueuedMessagesModal();
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to remove message from queue');
      });
  }


  function updateProjectStatusById(projectId, status) {
    var project = findProjectById(projectId);

    if (project) {
      project.status = status;
      renderProjectList();

      if (state.selectedProjectId === projectId) {
        updateProjectStatus(project);
      }
    }
  }

  // Load initial data
  function loadProjects() {
    api.getProjects()
      .done(function(projects) {
        state.projects = projects || [];
        renderProjectList();

        // Update current project if selected
        if (state.selectedProjectId) {
          var currentProject = findProjectById(state.selectedProjectId);
          if (currentProject) {
            state.currentProject = currentProject;
          }
        }

        // Restore saved project selection
        var savedProjectId = loadFromLocalStorage(LOCAL_STORAGE_KEYS.SELECTED_PROJECT, null);

        if (savedProjectId && findProjectById(savedProjectId)) {
          selectProject(savedProjectId);
        }
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to load projects');
      });
  }

  // WebSocket connection with exponential backoff
  function connectWebSocket() {
    // Clear any pending reconnect timeout
    if (state.wsReconnect.timeout) {
      clearTimeout(state.wsReconnect.timeout);
      state.wsReconnect.timeout = null;
    }

    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host;

    try {
      state.websocket = new WebSocket(wsUrl);
    } catch (err) {
      console.error('WebSocket creation failed:', err);
      scheduleReconnect();
      return;
    }

    state.websocket.onopen = function() {
      console.log('WebSocket connected');
      var wasReconnect = state.wsHasConnected === true;
      state.wsConnected = true; // Track connection state
      state.wsHasConnected = true;
      state.wsReconnect.attempts = 0;
      updateConnectionStatus('connected');

      // Re-subscribe to current project if any
      if (state.selectedProjectId) {
        subscribeToProject(state.selectedProjectId);

        // Re-subscribing only restores the *stream*; everything that happened
        // while the socket was down was never delivered and is not replayed. The
        // reply to the last message could be sitting on the server while the chat
        // looks frozen — which is why switching project and back "fixed" it: that
        // path reloads history. Do it here instead of making the user find out.
        if (wasReconnect) {
          backfillAfterReconnect(state.selectedProjectId);
          checkAgentStatus(state.selectedProjectId);
        }
      }
    };

    state.websocket.onmessage = function(event) {
      var message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    };

    state.websocket.onclose = function(event) {
      console.log('WebSocket disconnected (code: ' + event.code + ')');
      state.wsConnected = false; // Track connection state
      updateConnectionStatus('disconnected');
      scheduleReconnect();
    };

    state.websocket.onerror = function(error) {
      console.error('WebSocket error:', error);
      updateConnectionStatus('error');
    };
  }

  function scheduleReconnect() {
    if (state.wsReconnect.attempts >= state.wsReconnect.maxAttempts) {
      console.error('Max WebSocket reconnection attempts reached');
      updateConnectionStatus('failed');
      return;
    }

    state.wsReconnect.attempts++;
    var delay = calculateBackoffDelay();
    console.log('WebSocket reconnecting in ' + delay + 'ms (attempt ' + state.wsReconnect.attempts + ')');
    updateConnectionStatus('reconnecting', delay);

    state.wsReconnect.timeout = setTimeout(connectWebSocket, delay);
  }

  function calculateBackoffDelay() {
    // Exponential backoff with jitter
    var exponentialDelay = state.wsReconnect.baseDelay * Math.pow(2, state.wsReconnect.attempts - 1);
    var cappedDelay = Math.min(exponentialDelay, state.wsReconnect.maxDelay);
    // Add random jitter (0-25% of delay)
    var jitter = Math.random() * 0.25 * cappedDelay;
    return Math.floor(cappedDelay + jitter);
  }

  function updateConnectionStatus(status, nextRetryMs) {
    var $indicator = $('#ws-connection-status');
    if ($indicator.length === 0) return;

    $indicator.removeClass('ws-connected ws-disconnected ws-reconnecting ws-error ws-failed');
    $indicator.removeClass('cursor-pointer').addClass('cursor-default');

    switch (status) {
      case 'connected':
        $indicator.addClass('ws-connected').attr('title', 'Connected').html(
          '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="5"/></svg>'
        );
        break;
      case 'disconnected':
      case 'reconnecting':
        var retryText = nextRetryMs ? ' (retry in ' + Math.ceil(nextRetryMs / 1000) + 's)' : '';
        $indicator.addClass('ws-reconnecting').attr('title', 'Reconnecting' + retryText).html(
          '<svg class="w-3 h-3 animate-pulse" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="5"/></svg>'
        );
        break;
      case 'error':
        $indicator.addClass('ws-error').attr('title', 'Connection error').html(
          '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="5"/></svg>'
        );
        break;
      case 'failed':
        $indicator.addClass('ws-failed cursor-pointer').removeClass('cursor-default')
          .attr('title', 'Connection failed - click to retry').html(
          '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"/></svg>'
        );
        break;
    }
  }

  function manualReconnect() {
    state.wsReconnect.attempts = 0;
    connectWebSocket();
  }

  function handleWebSocketMessage(message) {
    switch (message.type) {
      case 'agent_message':
        handleAgentMessage(message.projectId, message.data);
        break;
      case 'context_usage':
        if (message.projectId === state.selectedProjectId) {
          updateContextUsageIndicator(message.data);
        }
        break;
      case 'agent_status':
        handleAgentStatus(message.projectId, message.data);
        break;
      case 'queue_change':
        handleQueueChange(message.data);
        break;
      case 'roadmap_message':
        handleRoadmapMessage(message.projectId, message.data);
        break;
      case 'agent_waiting':
        handleAgentWaiting(message.projectId, message.data);
        break;
      case 'session_recovery':
        handleSessionRecovery(message.projectId, message.data);
        break;
      case 'docker_fallback_warning':
        if (message.data && message.data.reason) {
          showToast('Docker container failed: ' + message.data.reason + '. Falling back to host execution.', 'warning');
        }
        break;
      case 'shell_output':
        ShellModule.handleShellOutput(message.data);
        break;
      case 'shell_exit':
        ShellModule.handleShellExit(message.data);
        break;
      case 'shell_error':
        ShellModule.handleShellError(message.data);
        break;
      case 'ralph_loop_status':
      case 'ralph_loop_iteration':
      case 'ralph_loop_output':
      case 'ralph_loop_complete':
      case 'ralph_loop_worker_complete':
      case 'ralph_loop_reviewer_complete':
      case 'ralph_loop_error':
      case 'ralph_loop_tool_use':
        handleRalphLoopMessage(message.type, message.data);
        if (RalphLoopModule) {
          RalphLoopModule.handleWebSocketMessage(message.type, message.data);
        }
        break;
      case 'resource_event':
        handleResourceEvent(message.data);
        break;
      case 'frontend_error':
        // Pass frontend errors to DebugModal if it has a handler
        if (DebugModal && DebugModal.handleFrontendError) {
          DebugModal.handleFrontendError(message.data);
        }
        break;
      case 'oneoff_message':
        if (typeof OneOffTabsModule !== 'undefined') {
          OneOffTabsModule.appendMessage(message.projectId, message.data.oneOffId, message.data);
        }

        if (InventifyModule) {
          InventifyModule.handleOneOffMessage(message.data.oneOffId, message.data);
        }
        break;
      case 'oneoff_status':
        if (typeof OneOffTabsModule !== 'undefined') {
          OneOffTabsModule.updateStatus(message.projectId, message.data.oneOffId, message.data.status);
        }

        if (InventifyModule) {
          InventifyModule.handleOneOffStatus(message.data.oneOffId, message.data.status);
        }
        break;
      case 'oneoff_waiting':
        if (typeof OneOffTabsModule !== 'undefined') {
          OneOffTabsModule.updateWaiting(
            message.projectId, message.data.oneOffId,
            message.data.isWaiting, message.data.version
          );
        }

        if (InventifyModule) {
          InventifyModule.handleOneOffWaiting(message.data.oneOffId, message.data.isWaiting);
        }
        break;
      case 'github_clone_progress':
        if (message.data) {
          var $progress = $('#github-clone-progress');

          if (!$progress.hasClass('hidden')) {
            var cls = message.data.phase === 'error' ? 'text-red-400' : 'text-gray-400';
            $progress.append('<div class="' + cls + '">' + escapeHtml(message.data.message) + '</div>');
            $progress.scrollTop($progress[0].scrollHeight);
          }
        }
        break;
      case 'run_config_output':
        if (RunConfigsModule) {
          RunConfigsModule.handleOutput(message.data);
        }
        break;
      case 'run_config_status':
        if (RunConfigsModule) {
          RunConfigsModule.handleStatusChange(message.data);
        }
        break;
      case 'docker_build_progress':
        if (typeof DockerModule !== 'undefined') {
          DockerModule.handleBuildProgress(message.data);
        }
        break;
      case 'approval_request':
        if (typeof ApprovalModule !== 'undefined') {
          ApprovalModule.handleApprovalRequest(message);
        }
        break;
      case 'approval_resolved':
        if (typeof ApprovalModule !== 'undefined') {
          ApprovalModule.handleApprovalResolved(message);
        }
        break;
    }
  }

  function handleAgentWaiting(projectId, data) {
    var project = findProjectById(projectId);

    // data is now { isWaiting, version }
    var isWaiting = data.isWaiting;
    var serverVersion = data.version || 0;
    var projectVersion = (project && project.waitingVersion) || 0;

    // Skip update if server version is not newer than this project's version
    if (serverVersion <= projectVersion) {
      return;
    }

    // Always update UI for the selected project regardless of project list state
    if (state.selectedProjectId === projectId) {
      state.waitingVersion = serverVersion;
      AgentControlsModule.setAgentWaiting(isWaiting);
      updateCancelButton();

      if (isWaiting) {
        PermissionModeModule.applyPendingIfNeeded();
        // Force scroll to show the last response when the agent finishes a turn
        var $c = $('#conversation-container');
        if ($c.length) {
          state.agentOutputScrollLock = false;
          $c.scrollTop($c[0].scrollHeight);
        }
      }
    }

    // Update project-level version tracking if project is in the list
    if (project) {
      project.waitingVersion = serverVersion;
      project.isWaitingForInput = isWaiting;
      renderProjectList();

      // Send desktop notification if enabled and waiting
      if (isWaiting && state.settings && state.settings.enableDesktopNotifications) {
        sendWaitingNotification(project);
      }
    }
  }

  function handleResourceEvent(data) {
    // Store resource data from all clients
    if (data && data.clientId) {
      state.allClientResources[data.clientId] = {
        resource: data.resource,
        stats: data.stats,
        action: data.action,
        lastUpdate: Date.now()
      };

      // Update debug modal if it's open and showing resources tab
      if ($('#debug-modal').is(':visible') && $('#debug-tab-resources').is(':visible')) {
        DebugModal.renderResourcesTab();
      }
    }
  }

  function sendWaitingNotification(project) {
    if (!('Notification' in window)) {
      return;
    }

    if (Notification.permission === 'granted') {
      new Notification('Claudito - Input Required', {
        body: project.name + ' is waiting for your input',
        icon: '/favicon.ico',
        tag: 'waiting-' + project.id
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(function(permission) {
        if (permission === 'granted') {
          new Notification('Claudito - Input Required', {
            body: project.name + ' is waiting for your input',
            icon: '/favicon.ico',
            tag: 'waiting-' + project.id
          });
        }
      });
    }
  }

  function handleQueueChange(resourceStatus) {
    updateResourceStatus(resourceStatus);
  }

  function handleAgentMessage(projectId, message) {
    appendMessage(projectId, message);

    // result type = turn complete → immediately show "Waiting for your input"
    // all other messages = agent actively working → clear waiting indicator
    if (projectId === state.selectedProjectId) {
      AgentControlsModule.setAgentWaiting(message.type === 'result');
      var project = findProjectById(projectId);

      if (project && project.isWaitingForInput) {
        project.isWaitingForInput = false;
        renderProjectList();
      }

      // Update context usage indicator from message payload
      if (message.contextUsage) {
        updateContextUsageIndicator(message.contextUsage);
      }
    }

    // Check for commit message response
    if (state.gitCommitMessagePending && message.type === 'assistant' && message.content) {
      // Check if it looks like a commit message (short, no markdown, conventional format)
      var lines = message.content.trim().split('\n');
      if (lines.length === 1 || (lines.length === 2 && lines[1] === '')) {
        var commitMsg = lines[0].trim();
        // Basic validation for conventional commit format
        if (commitMsg.match(/^(feat|fix|docs|style|refactor|test|chore|perf|build|ci)(\(.+\))?:\s*.+/i) ||
            commitMsg.length < 100) {
          $('#git-commit-message').val(commitMsg);
          showToast('Commit message generated!', 'success');
          state.gitCommitMessagePending = false;
        }
      }
    }
  }

  /**
   * Show how full the context is.
   *
   * The guard used to be `!contextUsage.percentUsed`, which is also true at 0 — so a
   * genuine 0% never appeared, and after a /compact the bar kept its old high value
   * instead of dropping, because the function returned before touching the DOM. It
   * has to test for a usable number, not for truthiness.
   */
  function updateContextUsageIndicator(contextUsage) {
    if (!contextUsage || typeof contextUsage.percentUsed !== 'number') return;

    // Compaction discarded the context these numbers describe, and the CLI does
    // not report the new size. Showing the old figure made /compact look like it
    // had done nothing; show "unknown" until the next turn measures it.
    // Empty track, not a full grey one: a filled bar reads as "context is full",
    // which is the opposite of what just happened. The dash carries the meaning.
    if (contextUsage.awaitingRefresh) {
      $('#context-usage-bar').css({ width: '0%', background: '#3f3f46' });
      $('#context-usage-label').text('–').css('color', '#a1a1aa');
      $('#context-usage-indicator')
        .attr('title', '컨텍스트가 압축됐습니다 — 다음 응답에서 사용량이 갱신됩니다')
        .removeClass('hidden');
      return;
    }

    var pct = Math.max(0, Math.min(100, Math.round(contextUsage.percentUsed)));
    var color = pct < 50 ? '#4ade80' : pct < 75 ? '#facc15' : pct < 90 ? '#f97316' : '#f87171';
    $('#context-usage-bar').css({ width: pct + '%', background: color });
    $('#context-usage-label').text(pct + '%').css('color', color);

    // The percentage alone hides how much room is left in absolute terms, which is
    // what decides whether a long task will survive without compacting.
    var used = contextUsage.totalTokens || 0;
    var max = contextUsage.maxContextTokens || 0;

    if (max > 0) {
      $('#context-usage-indicator').attr(
        'title',
        'Context ' + formatNumber(used) + ' / ' + formatNumber(max) +
        ' (' + formatNumber(Math.max(0, max - used)) + ' left before compact)'
      );
    }

    $('#context-usage-indicator').removeClass('hidden');
  }

  $(document).on('click', '#context-usage-indicator', function() {
    var project = findProjectById(state.selectedProjectId);
    var isWaiting = project && project.isWaitingForInput;

    // Was `state.agentStatus`, which this app never sets — so the guard silently did
    // nothing and clicking the bar mid-turn queued a /compact into a busy agent. The
    // project's own status is the value that exists.
    if (project && project.status === 'running' && !isWaiting) {
      showToast('작업이 끝난 뒤에 /compact 를 실행할 수 있습니다.', 'info');
      return;
    }

    $('#input-message').val('/compact');
    sendMessage();
  });

  function handleAgentStatus(projectId, data) {
    // Data can be a full status object or a string (for backward compatibility)
    var status = typeof data === 'object' ? data.status : data;
    var fullStatus = typeof data === 'object' ? data : null;

    // If the main agent is stopped but one-off agents are active, show as running in the sidebar
    if (status === 'stopped' && fullStatus && fullStatus.hasActiveOneOffAgents) {
      status = 'running';
    }

    updateProjectStatusById(projectId, status);
    updateAgentOutputHeader(projectId, status);

    // Sync waiting state for ALL projects (not just selected)
    // This ensures sidebar indicators update correctly
    if (fullStatus && status === 'running') {
      var serverVersion = fullStatus.waitingVersion || 0;
      var project = findProjectById(projectId);
      var projectVersion = (project && project.waitingVersion) || 0;

      // Update if server version is newer than this project's tracked version
      if (serverVersion > projectVersion || serverVersion === 0) {
        if (project) {
          var waitingChanged = project.isWaitingForInput !== fullStatus.isWaitingForInput;
          project.isWaitingForInput = fullStatus.isWaitingForInput;
          project.waitingVersion = serverVersion;

          // Re-render sidebar if waiting state changed
          if (waitingChanged) {
            renderProjectList();
          }
        }
      }
    }

    // Update running indicator for selected project
    if (projectId === state.selectedProjectId) {
      showAgentRunningIndicator(status === 'running');
      // Re-sync waiting state: showAgentRunningIndicator resets agentWaiting to false
      if (status === 'running' && fullStatus && typeof fullStatus.isWaitingForInput === 'boolean') {
        AgentControlsModule.setAgentWaiting(fullStatus.isWaitingForInput);
      }
      updateStartStopButtons();
      updateCancelButton();

      // Sync permission mode from server if provided
      if (fullStatus && fullStatus.permissionMode) {
        PermissionModeModule.syncFromServer(fullStatus.permissionMode, projectId);

        if (typeof OneOffToolbarModule !== 'undefined' && OneOffToolbarModule) {
          OneOffToolbarModule.syncPermissionMode(state.permissionMode);
        }
      }

      // Sync agent mode if provided
      if (fullStatus && fullStatus.mode) {
        state.currentAgentMode = fullStatus.mode;
      }

      // Sync session ID if provided
      if (fullStatus && fullStatus.sessionId) {
        state.currentSessionId = fullStatus.sessionId;
      }

      // Update context usage indicator
      updateContextUsageIndicator(fullStatus && fullStatus.contextUsage);

      // Reconcile the plan lock with the server before anything re-enables the
      // input below — the server is the only authority on whether a send passes.
      syncPlanBlockingState(projectId, fullStatus);

      // Update waiting indicator in main panel
      if (fullStatus && status === 'running') {
        var serverVersion = fullStatus.waitingVersion || 0;

        if (serverVersion > state.waitingVersion || serverVersion === 0) {
          state.waitingVersion = serverVersion;
        }
      }
    }

    // Reset mode selector and waiting state when agent stops
    if (status !== 'running' && projectId === state.selectedProjectId) {
      state.currentAgentMode = null;

      // Clear the stale prompt hint (plan_mode, question, permission, etc.).
      // Discard deferred plan messages first so replaying them doesn't re-arm it.
      state.deferredPlanMessage = null;
      setPromptHintState(null);

      // Re-assert a usable composer. Redundant on this path, deliberately kept:
      // this runs whenever an agent stops, which is exactly when leftover state
      // from a crashed or restarted run would otherwise show up.
      updateInputArea();

      // Clear pending permission mode change when agent stops
      state.pendingPermissionMode = null;
      PermissionModeModule.updatePendingIndicator();
    }

    // Clear waiting state in project when agent stops
    if (status !== 'running') {
      var project = findProjectById(projectId);

      if (project && project.isWaitingForInput) {
        project.isWaitingForInput = false;
        renderProjectList();
      }
    }
  }

  function handleSessionRecovery(projectId, data) {
    if (projectId !== state.selectedProjectId) {
      return;
    }

    // Update the current conversation ID to the new one
    state.currentConversationId = data.newConversationId;
    state.currentSessionId = data.newConversationId;

    // Clear the output screen
    $('#agent-output').empty();

    // Show a system message explaining what happened
    appendMessage(projectId, {
      type: 'system',
      content: data.reason,
      timestamp: new Date().toISOString()
    });

    // Show a toast notification
    showToast(data.reason, 'warning');

    // Reset conversation stats for the new conversation
    state.currentConversationStats = {
      messageCount: 0,
      toolCallCount: 0,
      userMessageCount: 0,
      durationMs: 0,
      startedAt: new Date().toISOString()
    };
    state.currentConversationMetadata = null;
    state.currentConversationLabel = null;
    ConversationHistoryModule.updateStats();

    // Reload conversation history dropdown
    loadConversationHistory(projectId);
  }

  function updateAgentOutputHeader(projectId, status) {
    // No longer needed - removed duplicate "Agent Output (live)" header
    // The agent status is already shown in the toolbar
  }

  function handleRoadmapMessage(projectId, message) {
    if (projectId !== state.selectedProjectId || !state.roadmapGenerating) {
      return;
    }

    appendRoadmapOutput(message);

    // Handle question - show response input
    if (message.type === 'question') {
      $('#roadmap-question-input').removeClass('hidden');
      $('#input-roadmap-response').focus();
    }

    if (message.type === 'system' && message.content.includes('complete')) {
      state.roadmapGenerating = false;
      $('#roadmap-progress-spinner').addClass('hidden');
      $('#roadmap-question-input').addClass('hidden');
      $('#roadmap-progress-footer').removeClass('hidden');
    }

    if (message.type === 'system' && message.content.includes('failed')) {
      state.roadmapGenerating = false;
      $('#roadmap-progress-spinner').addClass('hidden');
      $('#roadmap-question-input').addClass('hidden');
      showToast('Roadmap generation failed', 'error');
    }
  }

  function appendRoadmapOutput(message) {
    var $output = $('#roadmap-progress-output');
    var typeClass = message.type === 'stderr' ? 'text-red-400' :
                    message.type === 'system' ? 'text-blue-400' :
                    message.type === 'question' ? 'text-yellow-400 font-semibold' : 'text-gray-300';
    $output.append('<div class="' + typeClass + '">' + escapeHtml(message.content) + '</div>');
    $output.parent().scrollTop($output.parent()[0].scrollHeight);
  }

  function showRoadmapProgress() {
    state.roadmapGenerating = true;
    $('#roadmap-progress-output').empty();
    $('#roadmap-progress-spinner').removeClass('hidden');
    $('#roadmap-progress-footer').addClass('hidden');
    $('#roadmap-question-input').addClass('hidden');
    $('#input-roadmap-response').val('');
    openModal('modal-roadmap-progress');
  }

  function subscribeToProject(projectId) {
    if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
      state.websocket.send(JSON.stringify({
        type: 'subscribe',
        projectId: projectId
      }));
    }
  }

  function unsubscribeFromProject(projectId) {
    if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
      state.websocket.send(JSON.stringify({
        type: 'unsubscribe',
        projectId: projectId
      }));
    }
  }


  // Tab switching functions
  function switchTab(tabName) {
    state.activeTab = tabName;

    // Save to localStorage
    saveToLocalStorage(LOCAL_STORAGE_KEYS.ACTIVE_TAB, tabName);

    // Update tab button states
    $('.tab-button').removeClass('active').addClass('text-gray-400 border-transparent').removeClass('text-white border-purple-500');
    $('#tab-' + tabName).addClass('active text-white border-purple-500').removeClass('text-gray-400 border-transparent');

    // Show/hide tab content
    $('.tab-content').addClass('hidden');
    $('#tab-content-' + tabName).removeClass('hidden');

    // Show/hide input area based on tab
    if (tabName === 'project-files' || tabName === 'git' || tabName === 'shell' || tabName === 'ralph-loop' || tabName === 'run-configs') {
      $('#interactive-input-area').addClass('hidden');
    } else {
      $('#interactive-input-area').removeClass('hidden');
    }

    // If switching to project files, load the file tree
    if (tabName === 'project-files' && state.selectedProjectId) {
      var project = findProjectById(state.selectedProjectId);

      if (project && project.path) {
        FileBrowser.loadFileTree(project.path);
      }
    }

    // If switching to git tab, load git status
    if (tabName === 'git' && state.selectedProjectId) {
      GitModule.loadGitStatus();
    }

    // If switching to shell tab, activate the terminal
    if (tabName === 'shell') {
      ShellModule.onTabActivated();
    }

    // If switching to ralph-loop tab, activate it and load status
    if (tabName === 'ralph-loop' && state.selectedProjectId) {
      if (window.RalphLoopModule) {
        window.RalphLoopModule.onTabActivated();
      }
      loadRalphLoopStatus(state.selectedProjectId);
    }

    // If switching to run-configs tab, activate it
    if (tabName === 'run-configs' && RunConfigsModule) {
      RunConfigsModule.onTabActivated();
    }

  }

  /**
   * Refresh the content of the current tab (used when switching projects)
   */
  function refreshCurrentTabContent() {
    if (!state.selectedProjectId) return;

    if (state.activeTab === 'project-files') {
      var project = findProjectById(state.selectedProjectId);

      if (project && project.path) {
        FileBrowser.loadFileTree(project.path);
      }
    } else if (state.activeTab === 'git') {
      GitModule.loadGitStatus();
    } else if (state.activeTab === 'shell') {
      ShellModule.onTabActivated();
    } else if (state.activeTab === 'ralph-loop') {
      loadRalphLoopStatus(state.selectedProjectId);
    } else if (state.activeTab === 'run-configs' && RunConfigsModule) {
      RunConfigsModule.onTabActivated();
    }
  }

  function setupTabHandlers() {
    $('#tab-agent-output').on('click', function() {
      switchTab('agent-output');
    });

    $('#tab-project-files').on('click', function() {
      // Reset mobile file editor view when switching to files tab
      FileBrowser.hideMobileFileEditor();
      switchTab('project-files');
    });

    $('#tab-git').on('click', function() {
      switchTab('git');
    });

    $('#tab-shell').on('click', function() {
      if (!state.shellEnabled) {
        showShellDisabledNotification();
        return;
      }
      switchTab('shell');
    });

    $('#tab-run-configs').on('click', function() {
      switchTab('run-configs');
    });

  }

  // Load settings on init to get sendWithCtrlEnter preference and notification settings
  function loadInitialSettings() {
    api.getSettings()
      .done(function(settings) {
        state.settings = settings;
        state.hasUnsavedMcpChanges = false; // Reset on initial load
        state.sendWithCtrlEnter = settings.sendWithCtrlEnter !== false;
        state.chromeEnabled = settings.chromeEnabled ?? false;
        updateChromeToggleButton();
        updateInputHint();

        if (typeof PermissionModeModule !== 'undefined') {
          PermissionModeModule.updateSkipPermissionsWarning();
        }
      });
  }

  // Initialize application
  /**
   * Check authentication status and load app if authenticated
   */
  function checkAuthenticationOnLoad() {
    ApiClient.getAuthStatus()
      .done(function(response) {
        if (response && response.authenticated) {
          // User is authenticated, proceed with app initialization
          loadProjects();
          loadResourceStatus();
          loadInitialSettings();
          loadFontSize();
          loadScrollLockPreference();
          loadDevModeStatus();
          loadAppVersion();
          connectWebSocket();
          setupResizeHandler();
          setupVisibilityHandler();
        } else {
          // User is not authenticated, redirect to login
          window.location.href = '/login';
        }
      })
      .fail(function() {
        // API call failed, redirect to login as fallback
        window.location.href = '/login';
      });
  }

  function init() {
    // Initialize Mermaid for diagram rendering
    if (window.mermaid) {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          primaryColor: '#6366f1',
          primaryTextColor: '#e5e7eb',
          primaryBorderColor: '#4f46e5',
          lineColor: '#9ca3af',
          secondaryColor: '#374151',
          tertiaryColor: '#1f2937',
          background: '#111827',
          mainBkg: '#1f2937',
          secondBkg: '#374151',
          tertiaryBkg: '#111827'
        }
      });
    }

    // Initialize ApiClient (sets up global 401 redirect handler)
    ApiClient.init();

    initComposerGate();

    // 모델 드롭다운은 이제 비어 있는 상태로 시작한다. 여기서 채우지 않으면
    // 사용자는 모델을 아예 고를 수 없으므로, 로그인 직후 한 번 받아온다.
    loadModelCatalog();

    // Initialize ResourceMonitor to track asset loading failures
    if (ResourceMonitor) {
      ResourceMonitor.init({
        onError: function(error) {
          // Log resource errors to backend
          logFrontendError(error.message, error.url, null, null, error, error.type);
        },
        onResource: function(event) {
          // Send all resource events to backend for global monitoring
          if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
            state.websocket.send(JSON.stringify({
              type: 'resource_event',
              data: {
                type: event.type,
                url: event.url,
                status: event.status,
                duration: event.duration,
                error: event.error,
                method: event.method,
                statusCode: event.statusCode,
                timestamp: event.timestamp || new Date().toISOString(),
                clientId: state.clientId,
                userAgent: navigator.userAgent,
                hostname: window.location.hostname
              }
            }));
          }
        }
      });

      // Start periodic resource stats broadcasting
      ResourceMonitor.startPeriodicBroadcast(function(stats) {
        if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
          state.websocket.send(JSON.stringify({
            type: 'resource_event',
            data: {
              clientId: state.clientId,
              stats: stats,
              timestamp: new Date().toISOString()
            }
          }));
        }
      }, 30000); // Broadcast every 30 seconds
    }

    // Initialize FileCache with dependencies
    FileCache.init({
      api: api
    });

    // Initialize GitModule with dependencies
    GitModule.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      showToast: showToast,
      showPrompt: showPrompt,
      showConfirm: showConfirm,
      getErrorMessage: getErrorMessage,
      highlightCode: ToolRenderer.highlightCode,
      getLanguageFromPath: DiffEngine.getLanguageFromPath,
      findProjectById: findProjectById,
      switchTab: switchTab,
      FileBrowser: FileBrowser,
      computeWordDiff: DiffEngine.computeWordDiff
    });

    // Initialize ShellModule with dependencies
    ShellModule.init({
      state: state,
      api: api,
      showToast: showToast,
      showErrorToast: showErrorToast
    });

    // Initialize RalphLoopModule with dependencies
    if (RalphLoopModule) {
      RalphLoopModule.init({
        state: state,
        escapeHtml: EscapeUtils.escapeHtml,
        showToast: showToast,
        ApiClient: api,
        openModal: openModal,
        closeModal: closeModal
      });
    }

    // Initialize DebugModal with dependencies
    DebugModal.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      showToast: showToast,
      showConfirm: showConfirm,
      openModal: openModal,
      formatDateTime: formatDateTime,
      formatLogTime: formatLogTime,
      formatBytes: formatBytes,
      WebSocketModule: WebSocketModule,
      ResourceMonitor: ResourceMonitor
    });

    // Initialize FileBrowser with dependencies
    FileBrowser.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      showToast: showToast,
      showConfirm: showConfirm,
      openModal: openModal,
      closeModal: closeModal,
      findProjectById: findProjectById,
      highlightCode: ToolRenderer.highlightCode,
      getLanguageFromPath: DiffEngine.getLanguageFromPath,
      Validators: Validators
    });

    // Initialize RoadmapModule with dependencies
    RoadmapModule.init({
      state: state,
      escapeHtml: escapeHtml,
      showToast: showToast,
      closeModal: closeModal,
      findProjectById: findProjectById,
      doSendMessage: doSendMessage,
      startInteractiveAgentWithMessage: startInteractiveAgentWithMessage,
      api: api,
      updateProjectStatusById: updateProjectStatusById,
      startAgentStatusPolling: startAgentStatusPolling,
      appendMessage: appendMessage,
      PermissionModeModule: PermissionModeModule
    });

    // Initialize GitHubIssuesModule with dependencies
    if (typeof GitHubIssuesModule !== 'undefined') {
      GitHubIssuesModule.init({
        state: state,
        api: api,
        escapeHtml: escapeHtml,
        showToast: showToast,
        openModal: openModal,
        closeModal: closeModal,
        doSendMessage: doSendMessage,
        startInteractiveAgentWithMessage: startInteractiveAgentWithMessage,
        findProjectById: findProjectById,
        updateProjectStatusById: updateProjectStatusById,
        startAgentStatusPolling: startAgentStatusPolling,
        appendMessage: appendMessage
      });
    }

    // Initialize GitHubPRModule with dependencies
    if (typeof GitHubPRModule !== 'undefined') {
      GitHubPRModule.init({
        state: state,
        api: api,
        escapeHtml: escapeHtml,
        showToast: showToast,
        openModal: openModal,
        closeModal: closeModal,
        doSendMessage: doSendMessage,
        startInteractiveAgentWithMessage: startInteractiveAgentWithMessage,
        findProjectById: findProjectById,
      });
    }

    // Initialize ModalsModule with dependencies
    ModalsModule.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      showToast: showToast,
      showErrorToast: showErrorToast,
      openModal: openModal,
      closeModal: closeModal,
      switchTab: switchTab,
      Formatters: Formatters,
      FileBrowser: FileBrowser,
      marked: window.marked,
      hljs: window.hljs,
      findProjectById: findProjectById
    });

    // Initialize OneOffToolbarModule with dependencies
    if (typeof OneOffToolbarModule !== 'undefined') {
      // Expose app-level functions via state so toolbar can call them
      state.handleProjectModelChange = handleProjectModelChange;
      state.updateFontSize = updateFontSize;

      OneOffToolbarModule.init({
        state: state,
        escapeHtml: escapeHtml,
        escapeRegExp: escapeRegExp,
        openModal: openModal,
        showToast: showToast,
        PermissionModeModule: PermissionModeModule,
        TaskDisplayModule: TaskDisplayModule
      });
    }

    // Initialize OneOffTabsModule with dependencies
    if (typeof OneOffTabsModule !== 'undefined') {
      OneOffTabsModule.init({
        state: state,
        api: api,
        escapeHtml: escapeHtml,
        showToast: showToast,
        showConfirm: function(message, onConfirm) {
          showConfirm('Confirm', message).then(function(confirmed) {
            if (confirmed && onConfirm) {
              onConfirm();
            }
          });
        },
        MessageRenderer: MessageRenderer,
        ToolRenderer: ToolRenderer,
        FileCache: typeof FileCache !== 'undefined' ? FileCache : null,
        TaskDisplayModule: TaskDisplayModule,
        OneOffToolbarModule: typeof OneOffToolbarModule !== 'undefined' ? OneOffToolbarModule : null
      });
    }

    ConversationHistoryModule.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      showToast: showToast,
      showErrorToast: showErrorToast,
      truncateString: truncateString,
      formatConversationDate: Formatters.formatConversationDate,
      formatDuration: Formatters.formatDuration,
      renderConversation: renderConversation,
      setPromptHintState: setPromptHintState,
      SearchModule: SearchModule
    });

    SearchModule.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      escapeRegExp: escapeRegExp,
      formatDateTime: formatDateTime,
      loadConversation: ConversationHistoryModule.loadConversation
    });

    ImageAttachmentModule.init({
      state: state,
      showToast: showToast,
      scrollConversationToBottom: scrollConversationToBottom
    });

    TaskDisplayModule.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      truncateString: truncateString,
      formatTodoStatus: Formatters.formatTodoStatus,
      openModal: openModal,
      showToast: showToast
    });

    PermissionModeModule.init({
      state: state,
      api: api,
      showToast: showToast,
      showErrorToast: showErrorToast,
      findProjectById: findProjectById,
      updateProjectStatusById: updateProjectStatusById,
      startAgentStatusPolling: startAgentStatusPolling,
      appendMessage: appendMessage,
      renderProjectList: renderProjectList,
      openModal: openModal,
      closeModal: closeModal
    });

    if (typeof ApprovalModule !== 'undefined') {
      ApprovalModule.init({
        state: state,
        api: api,
        showToast: showToast,
        showErrorToast: showErrorToast
      });
      ApprovalModule.bindHandlers();
    }

    AgentControlsModule.init({
      state: state,
      findProjectById: findProjectById,
      updateProjectStatusById: updateProjectStatusById,
      updateInputHint: updateInputHint,
      updateRalphLoopPauseButton: updateRalphLoopPauseButton
    });

    FolderBrowserModule.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      openModal: openModal,
      closeModal: closeModal,
      showToast: showToast
    });

    PromptTemplatesModule.init({
      state: state,
      escapeHtml: escapeHtml,
      showToast: showToast,
      openModal: openModal,
      closeAllModals: closeAllModals,
      sendMessage: sendMessage
    });

    QuickActionsModule.init({
      state: state,
      escapeHtml: escapeHtml,
      showToast: showToast,
      sendMessage: sendMessage,
      PromptTemplatesModule: PromptTemplatesModule
    });

    McpSettingsModule.init({
      state: state,
      escapeHtml: escapeHtml,
      showToast: showToast,
      openModal: openModal,
      closeModal: closeModal,
      closeAllModals: closeAllModals
    });

    McpProjectModule.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      showToast: showToast,
      openModal: openModal,
      closeAllModals: closeAllModals,
      appendMessage: appendMessage
    });

    SlackProjectModule.init({
      state: state,
      api: api,
      escapeHtml: escapeHtml,
      showToast: showToast,
      openModal: openModal,
      closeAllModals: closeAllModals,
    });

    ClaudeCommandsModule.init({
      escapeHtml: escapeHtml,
      openModal: openModal,
      closeAllModals: closeAllModals,
      sendCommand: function(command) {
        $('#input-message').val(command);
        sendMessage();
      }
    });

    if (RunConfigsModule) {
      RunConfigsModule.init({
        state: state,
        api: api,
        showToast: showToast,
        showErrorToast: showErrorToast,
        escapeHtml: escapeHtml
      });
    }

    if (InventifyModule) {
      InventifyModule.init({
        api: api,
        escapeHtml: escapeHtml,
        state: state,
        FolderBrowserModule: FolderBrowserModule,
        subscribeToProject: subscribeToProject,
        unsubscribeFromProject: unsubscribeFromProject,
        selectProject: selectProject,
        loadProjects: loadProjects,
        startInteractiveAgentWithMessage: startInteractiveAgentWithMessage,
      });
    }

    if (typeof DockerModule !== 'undefined') {
      DockerModule.init({
        api: api,
        state: state,
        showToast: showToast,
        showErrorToast: showErrorToast,
      });
    }

    if (typeof AgentProfilesModule !== 'undefined') {
      AgentProfilesModule.setupEventHandlers();
    }

    // Inventify folder browse button in settings
    $(document).on('click', '#btn-settings-inventify-browse', function() {
      state.folderBrowserCallback = function(selectedPath) {
        if (selectedPath) {
          $('#input-inventify-folder').val(selectedPath);
        }
      };
      FolderBrowserModule.open();
    });

    ToolRenderer.init({
      escapeHtml: escapeHtml,
      truncateString: truncateString,
      DiffEngine: DiffEngine,
      FileCache: FileCache,
      TaskDisplayModule: TaskDisplayModule,
      hljs: window.hljs,
      formatTimestamp: MessageRenderer.formatTimestamp
    });

    MessageRenderer.init({
      escapeHtml: escapeHtml,
      ToolRenderer: ToolRenderer,
      marked: window.marked,
      mermaid: window.mermaid
    });

    setupEventHandlers();
    setupTabHandlers();
    FileBrowser.setupHandlers();
    FileBrowser.setupDragAndDrop();
    GitModule.setupGitHandlers();
    ShellModule.setupHandlers();
    DebugModal.setupHandlers();
    RoadmapModule.setupHandlers();
    ModalsModule.setupHandlers();
    SearchModule.setupHandlers();
    ConversationHistoryModule.setupHandlers();
    ImageAttachmentModule.setupHandlers();
    TaskDisplayModule.setupHandlers();
    PermissionModeModule.setupHandlers();
    FolderBrowserModule.setupHandlers();

    if (RunConfigsModule) {
      RunConfigsModule.setupHandlers();
    }

    // Check authentication status first
    checkAuthenticationOnLoad();
  }

  // Handle window resize for mobile/desktop hint updates
  function setupResizeHandler() {
    var resizeTimeout;

    $(window).on('resize', function() {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(function() {
        updateInputHint();
      }, 250);
    });
  }

  // Handle page visibility changes (mobile tab switching, app backgrounding)
  function setupVisibilityHandler() {
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') {
        // Page became visible - verify WebSocket and reconnect if needed
        if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
          console.log('Page visible, WebSocket not connected - reconnecting...');
          connectWebSocket();
        } else if (state.selectedProjectId) {
          // Re-subscribe to current project in case subscription was lost
          subscribeToProject(state.selectedProjectId);
        }
      }
    });
  }

  function loadDevModeStatus() {
    api.getDevStatus()
      .done(function(data) {
        state.devMode = data.devMode;

        if (state.devMode) {
          $('#btn-toggle-debug').removeClass('hidden');
        }
      });
  }

  function loadResourceStatus() {
    api.getAgentResourceStatus()
      .done(function(data) {
        updateResourceStatus(data);
      });
  }

  function loadAppVersion() {
    api.getHealth()
      .done(function(data) {
        if (data.version) {
          $('#app-version').text('v' + data.version);
        }

        if (data.shellEnabled !== undefined) {
          state.shellEnabled = data.shellEnabled;
        }

        handleClaudeCliInfo(data.claudeCli);
      });
  }

  function handleClaudeCliInfo(claudeCli) {
    console.log('[claudito] Claude CLI info:', claudeCli);

    if (!claudeCli || !claudeCli.installed) {
      console.warn('[claudito] Claude CLI not installed or info missing');
      $('#claude-auth-warning-message').text(
        'Claude CLI is not installed. Please install it and log in before using Claudito.'
      );
      openModal('modal-claude-auth-warning');
      return;
    }

    if (!claudeCli.auth || !claudeCli.auth.loggedIn) {
      console.warn('[claudito] Claude CLI not authenticated');
      openModal('modal-claude-auth-warning');
      return;
    }

    updateClaudeCliFooter(claudeCli);
  }

  function updateClaudeCliFooter(claudeCli) {
    var email = claudeCli.auth.email || '';
    var plan = claudeCli.auth.subscriptionType || '';
    var version = claudeCli.version || '';

    $('#claude-cli-email').text(email);
    $('#claude-cli-plan').text(plan);
    $('#claude-cli-version').text(version);
    $('#claude-cli-info').removeClass('hidden');
  }

  // Start the app when document is ready
  $(document).ready(init);

})(jQuery);
