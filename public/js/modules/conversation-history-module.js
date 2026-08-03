/**
 * Conversation History Module
 * Handles conversation history dropdown, loading, and switching
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ConversationHistoryModule = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // Dependencies injected via init()
  var state = null;
  var api = null;
  var escapeHtml = null;
  var showToast = null;
  var showErrorToast = null;
  var truncateString = null;
  var formatConversationDate = null;
  var formatDuration = null;
  var renderConversation = null;
  var setPromptHintState = null;
  var SearchModule = null;

  function init(deps) {
    state = deps.state;
    api = deps.api;
    escapeHtml = deps.escapeHtml;
    showToast = deps.showToast;
    showErrorToast = deps.showErrorToast;
    truncateString = deps.truncateString;
    formatConversationDate = deps.formatConversationDate;
    formatDuration = deps.formatDuration;
    renderConversation = deps.renderConversation;
    setPromptHintState = deps.setPromptHintState;
    SearchModule = deps.SearchModule;
  }

  function toggleConversationHistory() {
    if (state.conversationHistoryOpen) {
      closeConversationHistory();
    } else {
      openConversationHistory();
    }
  }

  function openConversationHistory() {
    if (!state.selectedProjectId) return;

    state.conversationHistoryOpen = true;

    // Position dropdown near the button
    var $btn = $('#btn-show-history');
    var offset = $btn.offset();
    var $dropdown = $('#conversation-history-dropdown');

    $dropdown.css({
      top: offset.top + $btn.outerHeight() + 4,
      left: offset.left
    });

    $dropdown.removeClass('hidden');
    loadConversationHistoryList();
  }

  function closeConversationHistory() {
    state.conversationHistoryOpen = false;
    $('#conversation-history-dropdown').addClass('hidden');
  }

  function loadConversationHistoryList() {
    if (!state.selectedProjectId) return;

    var $list = $('#conversation-history-list');
    $list.html('<div class="p-2 text-xs text-gray-500">Loading...</div>');

    $.get('/api/projects/' + state.selectedProjectId + '/conversations', { limit: state.historyLimit })
      .done(function(data) {
        renderConversationHistoryList(data.conversations || []);
      })
      .fail(function() {
        $list.html('<div class="p-2 text-xs text-red-400">Failed to load history</div>');
      });
  }

  function renderConversationHistoryList(conversations) {
    var $list = $('#conversation-history-list');
    $list.empty();

    if (conversations.length === 0) {
      $list.html('<div class="p-2 text-xs text-gray-500">No conversations yet</div>');
      return;
    }

    conversations.forEach(function(conv) {
      var isActive = conv.id === state.currentConversationId;
      var activeClass = isActive ? ' active' : '';
      var date = formatConversationDate(conv.createdAt);
      // Use custom label, or itemRef taskTitle, or default
      var itemRef = conv.itemRef || conv.milestoneItem;
      var label = conv.label || (itemRef ? itemRef.taskTitle : 'Interactive Session');
      var messageCount = conv.messages ? conv.messages.length : 0;

      $list.append(
        '<div class="conversation-history-item' + activeClass + '" data-conversation-id="' + conv.id + '">' +
          '<div class="conv-row flex items-center justify-between">' +
            '<div class="conv-label flex-1 min-w-0">' + escapeHtml(truncateString(label, 35)) + '</div>' +
            '<button class="btn-rename-conversation p-1 text-gray-500 hover:text-white rounded transition-colors flex-shrink-0" data-conversation-id="' + conv.id + '" data-current-label="' + escapeHtml(label) + '" title="Rename">' +
              '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
                '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>' +
              '</svg>' +
            '</button>' +
            '<button class="btn-delete-conversation p-1 text-gray-500 hover:text-red-400 rounded transition-colors flex-shrink-0" data-conversation-id="' + conv.id + '" data-conversation-label="' + escapeHtml(label) + '" title="Delete">' +
              '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
                '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>' +
              '</svg>' +
            '</button>' +
          '</div>' +
          '<div class="conv-meta">' +
            '<span class="conv-date">' + date + '</span>' +
            '<span class="conv-messages">' + messageCount + ' msgs</span>' +
          '</div>' +
          '<div class="conv-session-id" title="Session ID: ' + escapeHtml(conv.id) + '">' +
            escapeHtml(conv.id) +
          '</div>' +
        '</div>'
      );
    });
  }

  function loadConversation(conversationId) {
    if (!state.selectedProjectId) return;

    // Clear search when switching conversations
    if (state.search.isOpen && SearchModule) {
      SearchModule.close();
    }

    // Clear any prompt blocking when switching conversations
    if (setPromptHintState) {
      setPromptHintState(null);
    }

    state.currentConversationId = conversationId;

    // Set this as the current conversation on the backend so new messages go there
    api.setCurrentConversation(state.selectedProjectId, conversationId)
      .done(function(result) {
        // Fetch the conversation messages
        api.getConversation(state.selectedProjectId, conversationId)
          .done(function(data) {
            state.conversations[state.selectedProjectId] = data.messages || [];
            state.currentConversationStats = data.stats || null;
            state.currentConversationMetadata = data.metadata || null;
            state.currentConversationLabel = data.label || null;
            renderConversation(state.selectedProjectId);
            updateConversationStats();

            // Show toast if this conversation has a Claude session that can be resumed
            if (result.sessionId) {
              showToast('Conversation loaded. Session will resume when you send a message.', 'info');
            }
          })
          .fail(function(xhr) {
            showErrorToast(xhr, 'Failed to load conversation');
          });
      })
      .fail(function(xhr) {
        showErrorToast(xhr, 'Failed to switch conversation');
      });
  }

  function updateConversationStats() {
    var $stats = $('#conversation-stats');
    var stats = state.currentConversationStats;
    var metadata = state.currentConversationMetadata;

    if (!stats || stats.messageCount === 0) {
      $stats.html('<span class="text-gray-600">New session</span>');
      return;
    }

    var parts = [];

    // Duration
    if (stats.durationMs && stats.durationMs > 0) {
      parts.push('<span title="Duration">' + formatDuration(stats.durationMs) + '</span>');
    }

    // Message count
    parts.push('<span title="Messages">' + stats.messageCount + ' msgs</span>');

    // Tool calls
    if (stats.toolCallCount > 0) {
      parts.push('<span title="Tool calls">' + stats.toolCallCount + ' tools</span>');
    }

    $stats.html(parts.join('<span class="text-gray-600 mx-1">|</span>'));
  }

  function setupHandlers() {
    // Toggle conversation history dropdown
    $('#btn-show-history').on('click', function(e) {
      e.stopPropagation();
      toggleConversationHistory();
    });

    // Close button in history dropdown
    $('#btn-close-history').on('click', function(e) {
      e.stopPropagation();
      closeConversationHistory();
    });

    // Close dropdown when clicking outside
    $(document).on('click', function(e) {
      if (state.conversationHistoryOpen &&
          !$(e.target).closest('#conversation-history-dropdown').length &&
          !$(e.target).closest('#btn-show-history').length) {
        closeConversationHistory();
      }
    });

    // Load conversation when clicking on history item
    $(document).on('click', '.conversation-history-item', function(e) {
      // Don't trigger if clicking the rename or delete button
      if ($(e.target).closest('.btn-rename-conversation, .btn-delete-conversation').length) return;

      var conversationId = $(this).data('conversation-id');

      if (conversationId) {
        loadConversation(conversationId);
        closeConversationHistory();
      }
    });
  }

  return {
    init: init,
    toggle: toggleConversationHistory,
    open: openConversationHistory,
    close: closeConversationHistory,
    loadList: loadConversationHistoryList,
    renderList: renderConversationHistoryList,
    loadConversation: loadConversation,
    updateStats: updateConversationStats,
    setupHandlers: setupHandlers
  };
}));
