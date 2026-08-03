/**
 * Tool Renderer Module
 * Handles rendering of tool messages and diff displays
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ToolRenderer = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // Dependencies (injected via init)
  var escapeHtml;
  var truncateString;
  var DiffEngine;
  var FileCache;
  var TaskDisplayModule;
  var hljs;
  var formatTimestamp;

  // Tool data store for modal access
  var toolDataStore = {};

  /**
   * Initialize the module with dependencies
   * @param {Object} deps - Dependencies object
   */
  function init(deps) {
    escapeHtml = deps.escapeHtml;
    truncateString = deps.truncateString;
    DiffEngine = deps.DiffEngine;
    FileCache = deps.FileCache;
    TaskDisplayModule = deps.TaskDisplayModule;
    hljs = deps.hljs || (typeof window !== 'undefined' ? window.hljs : null);
    formatTimestamp = deps.formatTimestamp || function(ts) {
      return ts ? '<span class="text-xs text-gray-500 ml-2">' + new Date(ts).toLocaleTimeString() + '</span>' : '';
    };
  }

  /**
   * Get tool icon SVG
   * @param {string} toolName - Tool name
   * @returns {string} SVG HTML
   */
  function getToolIcon(toolName) {
    var icons = {
      'Read': '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
      'Write': '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>',
      'Edit': '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>',
      'Bash': '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
      'Glob': '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>',
      'Grep': '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>',
      'Task': '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>'
    };

    return icons[toolName] || '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>';
  }

  /**
   * Highlight code with syntax highlighting
   * @param {string} code - Code to highlight
   * @param {string} language - Language for highlighting
   * @returns {string} Highlighted HTML
   */
  function highlightCode(code, language) {
    if (!language || !hljs) {
      return escapeHtml(code);
    }

    if (!hljs.getLanguage(language)) {
      return escapeHtml(code);
    }

    try {
      var result = hljs.highlight(code, { language: language, ignoreIllegals: true });
      return result.value;
    } catch (e) {
      return escapeHtml(code);
    }
  }

  /**
   * Render word chunks with inline highlighting
   * @param {Array} chunks - Word diff chunks
   * @param {string} highlightType - 'old' or 'new'
   * @returns {string} HTML string
   */
  function renderWordChunks(chunks, highlightType) {
    if (!chunks || chunks.length === 0) return '';

    return chunks.map(function(chunk) {
      var text = escapeHtml(chunk.text);

      if (chunk.type === 'removed' && highlightType === 'old') {
        return '<span class="diff-char-removed">' + text + '</span>';
      } else if (chunk.type === 'added' && highlightType === 'new') {
        return '<span class="diff-char-added">' + text + '</span>';
      }

      return text;
    }).join('');
  }

  /**
   * Render full diff side by side
   * @param {string} oldStr - Original string
   * @param {string} newStr - New string
   * @param {string} filePath - File path for syntax highlighting
   * @returns {string} HTML string
   */
  function renderDiff(oldStr, newStr, filePath) {
    var alignedDiff = DiffEngine.computeAlignedDiff(oldStr, newStr);
    return renderDiffSideBySide(alignedDiff, alignedDiff.length, filePath);
  }

  /**
   * Render diff preview with limited lines
   * @param {string} oldStr - Original string
   * @param {string} newStr - New string
   * @param {string} filePath - File path for syntax highlighting
   * @returns {string} HTML string
   */
  function renderDiffPreview(oldStr, newStr, filePath) {
    var alignedDiff = DiffEngine.computeAlignedDiff(oldStr, newStr);
    var linesToShow = DiffEngine.selectDiffPreviewLines(alignedDiff, DiffEngine.DIFF_PREVIEW_LINES);

    var totalChanges = alignedDiff.filter(function(row) {
      return row.type !== 'unchanged';
    }).length;

    var html = renderDiffPreviewWithGaps(linesToShow, filePath);
    var hiddenCount = alignedDiff.length - linesToShow.reduce(function(acc, group) {
      return acc + group.lines.length;
    }, 0);

    if (hiddenCount > 0) {
      html += '<div class="diff-more-indicator">... ' + hiddenCount + ' more lines (' + totalChanges + ' total changes, click to view full diff)</div>';
    }

    return html;
  }

  /**
   * Render diff preview with gap indicators
   */
  function renderDiffPreviewWithGaps(groups, filePath) {
    var language = DiffEngine.getLanguageFromPath(filePath);
    var html = '<div class="tool-diff side-by-side">';

    // Old side (original)
    html += '<div class="diff-side old">';
    html += '<div class="diff-side-header">Original</div>';
    html += '<div class="diff-side-content">';

    var lastIndex = -1;

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];

      if (lastIndex >= 0 && group.startIndex > lastIndex + 1) {
        var gapSize = group.startIndex - lastIndex - 1;
        html += '<div class="diff-line diff-gap"><span class="diff-content text-gray-500 text-xs">... ' + gapSize + ' unchanged lines ...</span></div>';
      }

      for (var i = 0; i < group.lines.length; i++) {
        var item = group.lines[i];
        var row = item.row;
        var leftClass = 'diff-line';

        if (row.type === 'unchanged') leftClass += ' diff-unchanged';
        else if (row.type === 'remove') leftClass += ' diff-remove';
        else if (row.type === 'change') leftClass += ' diff-change';
        else if (row.type === 'add') leftClass += ' diff-empty';

        var leftContent = row.left ? highlightCode(row.left, language) : '';
        html += '<div class="' + leftClass + '">';
        html += '<span class="diff-content">' + leftContent + '</span>';
        html += '</div>';

        lastIndex = item.index;
      }
    }

    html += '</div></div>';

    // New side (modified)
    html += '<div class="diff-side new">';
    html += '<div class="diff-side-header">New</div>';
    html += '<div class="diff-side-content">';

    lastIndex = -1;

    for (var g2 = 0; g2 < groups.length; g2++) {
      var group2 = groups[g2];

      if (lastIndex >= 0 && group2.startIndex > lastIndex + 1) {
        var gapSize2 = group2.startIndex - lastIndex - 1;
        html += '<div class="diff-line diff-gap"><span class="diff-content text-gray-500 text-xs">... ' + gapSize2 + ' unchanged lines ...</span></div>';
      }

      for (var j = 0; j < group2.lines.length; j++) {
        var item2 = group2.lines[j];
        var row2 = item2.row;
        var rightClass = 'diff-line';

        if (row2.type === 'unchanged') rightClass += ' diff-unchanged';
        else if (row2.type === 'add') rightClass += ' diff-add';
        else if (row2.type === 'change') rightClass += ' diff-change';
        else if (row2.type === 'remove') rightClass += ' diff-empty';

        var rightContent = row2.right ? highlightCode(row2.right, language) : '';
        html += '<div class="' + rightClass + '">';
        html += '<span class="diff-content">' + rightContent + '</span>';
        html += '</div>';

        lastIndex = item2.index;
      }
    }

    html += '</div></div>';
    html += '</div>';

    return html;
  }

  /**
   * Render diff side by side
   */
  function renderDiffSideBySide(alignedDiff, maxLines, filePath) {
    var linesToShow = Math.min(alignedDiff.length, maxLines);
    var language = DiffEngine.getLanguageFromPath(filePath);

    var html = '<div class="tool-diff side-by-side">';

    // Old side (original)
    html += '<div class="diff-side old">';
    html += '<div class="diff-side-header">Original</div>';
    html += '<div class="diff-side-content">';

    for (var i = 0; i < linesToShow; i++) {
      var row = alignedDiff[i];
      var leftClass = 'diff-line';

      if (row.type === 'unchanged') leftClass += ' diff-unchanged';
      else if (row.type === 'remove') leftClass += ' diff-remove';
      else if (row.type === 'change') leftClass += ' diff-change';
      else if (row.type === 'add') leftClass += ' diff-empty';

      var leftContent;

      if (row.type === 'change' && row.leftChunks) {
        leftContent = renderWordChunks(row.leftChunks, 'old');
      } else {
        leftContent = row.left ? highlightCode(row.left, language) : '';
      }

      html += '<div class="' + leftClass + '">';
      html += '<span class="diff-content">' + leftContent + '</span>';
      html += '</div>';
    }

    html += '</div></div>';

    // New side (modified)
    html += '<div class="diff-side new">';
    html += '<div class="diff-side-header">New</div>';
    html += '<div class="diff-side-content">';

    for (var j = 0; j < linesToShow; j++) {
      var row2 = alignedDiff[j];
      var rightClass = 'diff-line';

      if (row2.type === 'unchanged') rightClass += ' diff-unchanged';
      else if (row2.type === 'add') rightClass += ' diff-add';
      else if (row2.type === 'change') rightClass += ' diff-change';
      else if (row2.type === 'remove') rightClass += ' diff-empty';

      var rightContent;

      if (row2.type === 'change' && row2.rightChunks) {
        rightContent = renderWordChunks(row2.rightChunks, 'new');
      } else {
        rightContent = row2.right ? highlightCode(row2.right, language) : '';
      }

      html += '<div class="' + rightClass + '">';
      html += '<span class="diff-content">' + rightContent + '</span>';
      html += '</div>';
    }

    html += '</div></div>';
    html += '</div>';

    return html;
  }

  /**
   * Render tool arguments (full version for modal)
   */
  function renderToolArgs(toolName, input) {
    if (!input || Object.keys(input).length === 0) {
      return '';
    }

    var html = '<div class="tool-args">';

    switch (toolName) {
      case 'Read':
        if (input.file_path) {
          html += '<div class="tool-arg"><span class="arg-label">Path:</span> <code class="arg-value file-path">' + escapeHtml(input.file_path) + '</code></div>';
        }
        break;

      case 'Write':
        if (input.file_path) {
          html += '<div class="tool-arg"><span class="arg-label">Path:</span> <code class="arg-value file-path">' + escapeHtml(input.file_path) + '</code></div>';
        }

        if (input.content) {
          var cachedContent = input.file_path ? FileCache.getContent(input.file_path) : null;

          if (cachedContent !== null) {
            html += '<div class="tool-arg"><span class="text-blue-400 text-xs italic">Diff against previously read file</span></div>';
            html += renderDiff(cachedContent, input.content, input.file_path);
          } else {
            html += renderDiff('', input.content, input.file_path);
          }
        }
        break;

      case 'Edit':
        if (input.file_path) {
          html += '<div class="tool-arg"><span class="arg-label">Path:</span> <code class="arg-value file-path">' + escapeHtml(input.file_path) + '</code></div>';
        }

        if (input.old_string && input.new_string) {
          html += renderDiff(input.old_string, input.new_string, input.file_path);
        }
        break;

      case 'Bash':
        if (input.command) {
          html += '<div class="tool-arg"><pre class="arg-value bash-command">' + escapeHtml(input.command) + '</pre></div>';
        }
        break;

      case 'Glob':
        if (input.pattern) {
          html += '<div class="tool-arg"><span class="arg-label">Pattern:</span> <code class="arg-value">' + escapeHtml(input.pattern) + '</code></div>';
        }
        break;

      case 'Grep':
        if (input.pattern) {
          html += '<div class="tool-arg"><span class="arg-label">Pattern:</span> <code class="arg-value">' + escapeHtml(input.pattern) + '</code></div>';
        }

        if (input.path) {
          html += '<div class="tool-arg"><span class="arg-label">Path:</span> <code class="arg-value file-path">' + escapeHtml(input.path) + '</code></div>';
        }
        break;

      case 'TodoWrite':
        var todoItems = input.todos;

        if (typeof input === 'string') {
          try {
            var parsedInput = JSON.parse(input);
            todoItems = parsedInput.todos;
          } catch (e) {
            // If parsing fails, show nothing
          }
        }

        html += TaskDisplayModule.renderList(todoItems || []);
        break;

      default:
        for (var key in input) {
          if (input.hasOwnProperty(key)) {
            var value = typeof input[key] === 'string' ? input[key] : JSON.stringify(input[key]);
            html += '<div class="tool-arg"><span class="arg-label">' + escapeHtml(key) + ':</span> <span class="arg-value">' + escapeHtml(truncateString(value, 100)) + '</span></div>';
          }
        }
    }

    html += '</div>';
    return html;
  }

  /**
   * Render tool arguments preview (limited for inline display)
   */
  function renderToolArgsPreview(toolName, input) {
    if (!input || Object.keys(input).length === 0) {
      return '';
    }

    var html = '<div class="tool-args">';

    switch (toolName) {
      case 'Read':
        if (input.file_path) {
          html += '<div class="tool-arg"><span class="arg-label">Path:</span> <code class="arg-value file-path">' + escapeHtml(input.file_path) + '</code></div>';
        }
        break;

      case 'Write':
        if (input.file_path) {
          html += '<div class="tool-arg"><span class="arg-label">Path:</span> <code class="arg-value file-path">' + escapeHtml(input.file_path) + '</code></div>';
        }

        if (input.content) {
          var cachedContent = input.file_path ? FileCache.getContent(input.file_path) : null;

          if (cachedContent !== null) {
            html += '<div class="tool-arg"><span class="text-blue-400 text-xs italic">Diff against previously read file</span></div>';
            html += renderDiffPreview(cachedContent, input.content, input.file_path);
          } else {
            html += renderDiffPreview('', input.content, input.file_path);
          }
        }
        break;

      case 'Edit':
        if (input.file_path) {
          html += '<div class="tool-arg"><span class="arg-label">Path:</span> <code class="arg-value file-path">' + escapeHtml(input.file_path) + '</code></div>';
        }

        if (input.old_string && input.new_string) {
          html += renderDiffPreview(input.old_string, input.new_string, input.file_path);
        }
        break;

      case 'Bash':
        if (input.command) {
          var cmd = input.command;

          if (cmd.length > 200) {
            cmd = cmd.substring(0, 200) + '...';
          }

          html += '<div class="tool-arg"><pre class="arg-value bash-command">' + escapeHtml(cmd) + '</pre></div>';
        }
        break;

      case 'Glob':
        if (input.pattern) {
          html += '<div class="tool-arg"><span class="arg-label">Pattern:</span> <code class="arg-value">' + escapeHtml(input.pattern) + '</code></div>';
        }
        break;

      case 'Grep':
        if (input.pattern) {
          html += '<div class="tool-arg"><span class="arg-label">Pattern:</span> <code class="arg-value">' + escapeHtml(input.pattern) + '</code></div>';
        }

        if (input.path) {
          html += '<div class="tool-arg"><span class="arg-label">Path:</span> <code class="arg-value file-path">' + escapeHtml(input.path) + '</code></div>';
        }
        break;

      case 'TodoWrite':
        var todos = input.todos;

        if (typeof input === 'string') {
          try {
            var parsed = JSON.parse(input);
            todos = parsed.todos;
          } catch (e) {
            // If parsing fails, show nothing
          }
        }

        html += TaskDisplayModule.renderListPreview(todos || []);
        break;

      default:
        for (var key in input) {
          if (input.hasOwnProperty(key)) {
            var value = typeof input[key] === 'string' ? input[key] : JSON.stringify(input[key]);
            html += '<div class="tool-arg"><span class="arg-label">' + escapeHtml(key) + ':</span> <span class="arg-value">' + escapeHtml(truncateString(value, 100)) + '</span></div>';
          }
        }
    }

    html += '</div>';
    return html;
  }

  /**
   * Render a tool message
   */
  function renderToolMessage(msg) {
    var toolInfo = msg.toolInfo || {};
    var toolName = toolInfo.name || 'Tool';
    var toolInput = toolInfo.input || {};
    var toolId = toolInfo.id || ('tool-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9));
    var status = toolInfo.status || 'running';
    var iconHtml = getToolIcon(toolName);

    // Handle Ralph Loop phase
    var senderPrefix = '';
    if (msg.ralphLoopPhase) {
      senderPrefix = (msg.ralphLoopPhase === 'worker' ? 'Worker' : 'Reviewer') + ' - ';
    }

    // Special handling for AskUserQuestion
    if (toolName === 'AskUserQuestion' && toolInput.questions) {
      return renderAskUserQuestion(msg, toolInfo, toolId);
    }

    toolDataStore[toolId] = {
      name: toolName,
      input: toolInput,
      status: status
    };

    var timestampHtml = formatTimestamp(msg.timestamp);

    var html = '<div class="conversation-message tool-use" data-tool-id="' + escapeHtml(toolId) + '" data-msg-type="tool">' +
      '<div class="tool-header">' +
        iconHtml +
        '<span class="tool-name">' + escapeHtml(senderPrefix + toolName) + '</span>' +
        '<span class="tool-status ' + status + '"></span>' +
        timestampHtml +
        '<span class="ml-auto text-xs text-gray-500">Click for details</span>' +
      '</div>';

    html += renderToolArgsPreview(toolName, toolInput);
    html += '</div>';

    return html;
  }

  /**
   * Render AskUserQuestion tool with interactive buttons
   */
  function renderAskUserQuestion(msg, toolInfo, toolId) {
    var toolInput = toolInfo.input || {};
    var questions = toolInput.questions || [];
    var timestampHtml = formatTimestamp(msg.timestamp);
    var status = toolInfo.status || 'waiting';

    // Store tool data for later reference
    toolDataStore[toolId] = {
      name: 'AskUserQuestion',
      input: toolInput,
      status: status
    };

    var html = '<div class="conversation-message tool-use ask-user-question" data-tool-id="' + escapeHtml(toolId) + '" data-msg-type="ask-user-question">' +
      '<div class="tool-header">' +
        '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>' +
        '</svg>' +
        '<span class="tool-name">Claude is asking a question</span>' +
        '<span class="tool-status ' + status + '"></span>' +
        timestampHtml +
      '</div>';

    // Render each question
    questions.forEach(function(question, qIndex) {
      html += '<div class="p-4 bg-gray-800 rounded-lg my-2">';

      // Question header
      if (question.header) {
        html += '<div class="text-xs text-purple-400 font-medium mb-1">' + escapeHtml(question.header) + '</div>';
      }

      // Question text
      html += '<div class="text-sm text-gray-100 mb-3">' + escapeHtml(question.question) + '</div>';

      // Options as buttons
      html += '<div class="flex flex-wrap gap-2" data-question-index="' + qIndex + '">';

      if (question.options && question.options.length > 0) {
        question.options.forEach(function(option, oIndex) {
          var optionId = toolId + '-q' + qIndex + '-o' + oIndex;
          html += '<button type="button" class="ask-user-option bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm transition-colors flex flex-col items-start" ' +
                  'data-tool-id="' + escapeHtml(toolId) + '" ' +
                  'data-question-index="' + qIndex + '" ' +
                  'data-option-index="' + oIndex + '" ' +
                  'data-option-label="' + escapeHtml(option.label) + '">';

          html += '<span class="font-medium">' + escapeHtml(option.label) + '</span>';
          if (option.description) {
            html += '<span class="text-xs text-gray-400 mt-1">' + escapeHtml(option.description) + '</span>';
          }

          html += '</button>';
        });

        // Always add "Other" option
        html += '<button type="button" class="ask-user-option ask-user-other bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm transition-colors" ' +
                'data-tool-id="' + escapeHtml(toolId) + '" ' +
                'data-question-index="' + qIndex + '" ' +
                'data-option-index="-1" ' +
                'data-option-label="Other">' +
                '<span class="font-medium">Other</span>' +
                '<span class="text-xs text-gray-400 mt-1">Provide custom answer</span>' +
                '</button>';
      }

      html += '</div>'; // options container

      // Multi-select indicator
      if (question.multiSelect) {
        html += '<div class="text-xs text-gray-500 mt-2">You can select multiple options</div>';
      }

      html += '</div>'; // question container
    });

    // Submit button (hidden until all questions answered)
    html += '<div class="mt-3 flex justify-end">' +
      '<button type="button" class="ask-user-submit hidden bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors" ' +
        'data-tool-id="' + escapeHtml(toolId) + '">' +
        'Submit Answers' +
      '</button>' +
    '</div>';

    html += '</div>'; // message container

    // Deliberately does NOT block the composer.
    //
    // Rendering is replay: this function also runs for cards that were answered
    // long ago (project switch, page reload, history load). Arming the lock here
    // ignored toolInfo.status, so replaying a finished question disabled the
    // input with only already-disabled buttons to answer it. Live arming belongs
    // to appendMessage(), and restorePromptState() handles a genuinely unanswered
    // question on reload.
    return html;
  }

  /**
   * Generate a short result preview based on tool name and output
   */
  function generateResultPreview(toolName, resultContent) {
    if (!resultContent) return '';

    if (typeof resultContent !== 'string') {
      resultContent = JSON.stringify(resultContent);
    }

    var lines = resultContent.split('\n');
    var lineCount = lines.length;

    switch (toolName) {
      case 'Read':
        return lineCount + ' line' + (lineCount !== 1 ? 's' : '') + ' read';
      case 'Glob':
        var fileCount = lines.filter(function(l) { return l.trim(); }).length;
        return fileCount + ' file' + (fileCount !== 1 ? 's' : '') + ' matched';
      case 'Grep':
        var matchCount = lines.filter(function(l) { return l.trim(); }).length;
        return matchCount + ' match' + (matchCount !== 1 ? 'es' : '');
      case 'Bash':
        if (resultContent.length <= 120) return resultContent.trim();
        return lines[0].substring(0, 80) + '... (' + lineCount + ' lines)';
      default:
        if (resultContent.length <= 80) return resultContent.trim();
        return resultContent.substring(0, 60).trim() + '... (' + lineCount + ' lines)';
    }
  }

  /**
   * Update tool status when result arrives
   */
  function updateToolStatus(toolId, status, resultContent) {
    var $ = typeof window !== 'undefined' ? window.$ : null;

    if (!$) return;

    var $tool = $('[data-tool-id="' + toolId + '"]');

    if ($tool.length === 0) return;

    $tool.find('.tool-status').removeClass('running completed failed').addClass(status);

    if (toolDataStore[toolId]) {
      toolDataStore[toolId].status = status;

      if (resultContent) {
        toolDataStore[toolId].resultContent = resultContent;
      }
    }

    // Append result preview for completed tools
    if (resultContent && status === 'completed') {
      var $preview = $tool.find('.tool-result-preview');

      if ($preview.length === 0) {
        var toolName = toolDataStore[toolId] ? toolDataStore[toolId].name : '';
        var preview = generateResultPreview(toolName, resultContent);

        if (preview) {
          $tool.append(
            '<div class="tool-result-preview mt-1 text-xs text-gray-500 truncate">' +
              escapeHtml(preview) +
            '</div>'
          );
        }
      }
    }

    if (resultContent && status === 'failed') {
      var $resultEl = $tool.find('.tool-result-content');

      if ($resultEl.length === 0) {
        var truncatedContent = resultContent.length > 200
          ? resultContent.substring(0, 200) + '...'
          : resultContent;

        $tool.append(
          '<div class="tool-result-content mt-2 p-2 bg-red-900/30 border border-red-700/50 rounded text-xs text-red-300">' +
            '<pre class="whitespace-pre-wrap break-words">' + escapeHtml(truncatedContent) + '</pre>' +
          '</div>'
        );
      }
    }
  }

  /**
   * Get tool data by ID (for modal)
   */
  function getToolData(toolId) {
    return toolDataStore[toolId] || null;
  }

  /**
   * Clear tool data store
   */
  function clearToolData() {
    toolDataStore = {};
  }

  // Public API
  return {
    init: init,
    getToolIcon: getToolIcon,
    highlightCode: highlightCode,
    renderWordChunks: renderWordChunks,
    renderDiff: renderDiff,
    renderDiffPreview: renderDiffPreview,
    renderDiffSideBySide: renderDiffSideBySide,
    renderToolArgs: renderToolArgs,
    renderToolArgsPreview: renderToolArgsPreview,
    renderToolMessage: renderToolMessage,
    generateResultPreview: generateResultPreview,
    updateToolStatus: updateToolStatus,
    getToolData: getToolData,
    clearToolData: clearToolData
  };
}));
