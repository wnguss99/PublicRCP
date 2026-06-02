/**
 * Prompt Templates Module
 * Handles prompt template selection, variable parsing, and form rendering
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PromptTemplatesModule = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // Dependencies injected via init()
  var state = null;
  var escapeHtml = null;
  var showToast = null;
  var openModal = null;
  var closeAllModals = null;
  var sendMessage = null;

  // Module state
  var currentTemplate = null;
  var selectorOpen = false;

  function init(deps) {
    state = deps.state;
    escapeHtml = deps.escapeHtml;
    showToast = deps.showToast;
    openModal = deps.openModal;
    closeAllModals = deps.closeAllModals;
    sendMessage = deps.sendMessage;
    setupHandlers();
  }

  /**
   * Parse template variables from content
   * Supports: ${text:name}, ${textarea:name}, ${select:name:opt1,opt2}, ${checkbox:name}
   * With optional defaults: ${text:name=default}, ${checkbox:name=true}, ${select:name:opt1,opt2=opt2}
   */
  function parseTemplateVariables(content) {
    var variables = [];
    // Updated regex to capture default value after =
    var regex = /\$\{(text|textarea|select|checkbox):([a-zA-Z0-9_-]+)(?::([^}=]+))?(?:=([^}]*))?\}/g;
    var match;

    while ((match = regex.exec(content)) !== null) {
      var defaultValue = match[4] || null;

      // Handle escaped newlines in defaults for text/textarea
      if (defaultValue && (match[1] === 'text' || match[1] === 'textarea')) {
        defaultValue = defaultValue.replace(/\\n/g, '\n');
      }

      var variable = {
        type: match[1],
        name: match[2],
        label: formatLabel(match[2]),
        options: match[3] ? match[3].split(',').map(function(s) { return s.trim(); }) : null,
        defaultValue: defaultValue
      };

      // Avoid duplicates
      var exists = variables.some(function(v) { return v.name === variable.name; });

      if (!exists) {
        variables.push(variable);
      }
    }

    return variables;
  }

  /**
   * Convert variable name to human-readable label
   */
  function formatLabel(name) {
    return name
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }

  /**
   * Render template content with provided values
   */
  function renderTemplate(content, values) {
    return content.replace(
      /\$\{(text|textarea|select|checkbox):([a-zA-Z0-9_-]+)(?::[^}=]+)?(?:=[^}]*)?\}/g,
      function(match, type, name) {
        var value = values[name];

        if (type === 'checkbox') {
          return value ? 'Yes' : '';
        }

        return value !== undefined ? value : '';
      }
    );
  }

  /**
   * Open the template selector modal
   */
  function openSelector() {
    var templates = (state && state.settings && state.settings.promptTemplates) || [];

    if (templates.length === 0) {
      showToast('No templates available. Add templates in Settings.', 'info');
      return;
    }

    // Render template list
    var html = '<div class="py-1">';

    templates.forEach(function(template) {
      // Skip invalid template objects
      if (!template || !template.id || !template.name) {
        return;
      }

      html += '<div class="template-selector-item px-3 py-2 hover:bg-gray-700 cursor-pointer" data-id="' + escapeHtml(template.id) + '">' +
        '<div class="text-sm text-white">' + escapeHtml(template.name) + '</div>' +
        (template.description ? '<div class="text-xs text-gray-400 mt-0.5">' + escapeHtml(template.description) + '</div>' : '') +
        '</div>';
    });

    html += '</div>';

    $('#template-selector-list').html(html);
    openModal('modal-template-selector');
    selectorOpen = true;
  }

  /**
   * Close the template selector modal
   */
  function closeSelector() {
    closeAllModals();
    selectorOpen = false;
  }

  /**
   * Handle template selection
   */
  function selectTemplate(templateId) {
    closeSelector();

    var templates = state.settings?.promptTemplates || [];
    var template = templates.find(function(t) { return t.id === templateId; });

    if (!template) {
      showToast('Template not found', 'error');
      return;
    }

    var variables = parseTemplateVariables(template.content);

    if (variables.length === 0) {
      // No variables - insert directly
      insertTemplateText(template.content);
    } else {
      // Has variables - show fill modal
      openFillModal(template, variables);
    }
  }

  /**
   * Insert text into the message input
   */
  function insertTemplateText(text) {
    var $input = $('#input-message');
    var currentText = $input.val();
    var cursorPos = $input[0].selectionStart || currentText.length;

    // Insert at cursor position
    var before = currentText.substring(0, cursorPos);
    var after = currentText.substring(cursorPos);
    var newText = before + (before && !before.endsWith('\n') ? '\n' : '') + text + after;

    $input.val(newText);
    $input.trigger('input'); // Trigger resize

    // Focus and position cursor at end of inserted text
    $input.focus();
    var newPos = cursorPos + text.length + (before && !before.endsWith('\n') ? 1 : 0);
    $input[0].setSelectionRange(newPos, newPos);
  }

  /**
   * Open modal to fill template variables
   */
  function openFillModal(template, variables, autoSend) {
    currentTemplate = template;
    state.templateAutoSend = autoSend || false;

    $('#template-fill-title').text('Fill Template: ' + template.name);

    var $container = $('#template-fill-fields');
    var html = '';

    variables.forEach(function(variable) {
      html += renderVariableField(variable);
    });

    $container.html(html);
    openModal('modal-template-fill');

    // Focus first input
    $container.find('input, textarea, select').first().focus();
  }

  /**
   * Render a form field for a template variable
   */
  function renderVariableField(variable) {
    var html = '<div class="mb-3">';
    html += '<label class="block text-xs font-medium text-gray-300 mb-1">' + escapeHtml(variable.label) + '</label>';

    switch (variable.type) {
      case 'text':
        html += '<input type="text" name="' + escapeHtml(variable.name) + '" ' +
          (variable.defaultValue ? 'value="' + escapeHtml(variable.defaultValue) + '" ' : '') +
          'class="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-purple-500">';
        break;

      case 'textarea':
        html += '<textarea name="' + escapeHtml(variable.name) + '" rows="3" ' +
          'class="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-purple-500 textarea-resizable">' +
          (variable.defaultValue ? escapeHtml(variable.defaultValue) : '') + '</textarea>';
        break;

      case 'select':
        html += '<select name="' + escapeHtml(variable.name) + '" ' +
          'class="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-purple-500">';

        if (variable.options) {
          variable.options.forEach(function(opt) {
            var isSelected = variable.defaultValue === opt;
            html += '<option value="' + escapeHtml(opt) + '"' + (isSelected ? ' selected' : '') + '>' + escapeHtml(opt) + '</option>';
          });
        }

        html += '</select>';
        break;

      case 'checkbox':
        var isChecked = variable.defaultValue === 'true';
        html += '<label class="flex items-center gap-2 cursor-pointer">' +
          '<input type="checkbox" name="' + escapeHtml(variable.name) + '" ' +
          (isChecked ? 'checked ' : '') +
          'class="rounded bg-gray-700 border-gray-600 text-purple-500 focus:ring-purple-500">' +
          '<span class="text-sm text-gray-300">Enable</span>' +
          '</label>';
        break;
    }

    html += '</div>';
    return html;
  }

  /**
   * Handle template fill form submission
   */
  function handleFillSubmit() {
    if (!currentTemplate) return;

    var $form = $('#form-template-fill');
    var values = {};

    // Collect form values
    $form.find('input, textarea, select').each(function() {
      var $field = $(this);
      var name = $field.attr('name');

      if (!name) return;

      if ($field.attr('type') === 'checkbox') {
        values[name] = $field.is(':checked');
      } else {
        values[name] = $field.val();
      }
    });

    // Render template with values
    var renderedText = renderTemplate(currentTemplate.content, values);

    closeAllModals();
    insertTemplateText(renderedText);

    // Check if we should auto-send
    if (state.templateAutoSend) {
      state.templateAutoSend = false; // Reset flag
      // Use setTimeout to ensure the text is properly inserted first
      setTimeout(function() {
        if (sendMessage) {
          sendMessage();
        }
      }, 100);
    }

    currentTemplate = null;
  }

  /**
   * Render templates list in settings tab
   */
  function renderSettingsTab() {
    var templates = (state && state.settings && state.settings.promptTemplates) || [];
    var $container = $('#templates-list');

    if (templates.length === 0) {
      $container.html('<div class="text-gray-500 text-sm text-center py-4">No templates. Click "Add Template" to create one.</div>');
      return;
    }

    var html = '';

    templates.forEach(function(template, index) {
      // Skip invalid template objects
      if (!template || !template.id || !template.name) {
        return;
      }

      html += '<div class="template-list-item flex items-center justify-between p-2 bg-gray-700 rounded" data-id="' + escapeHtml(template.id) + '">' +
        '<div class="flex-1 min-w-0">' +
        '<div class="flex items-center gap-2">' +
        '<span class="text-sm text-white truncate">' + escapeHtml(template.name) + '</span>' +
        (template.isQuickAction ? '<span class="text-xs bg-purple-600/20 text-purple-400 px-2 py-0.5 rounded">Quick Action</span>' : '') +
        '</div>' +
        (template.description ? '<div class="text-xs text-gray-400 truncate">' + escapeHtml(template.description) + '</div>' : '') +
        '</div>' +
        '<div class="flex items-center gap-1 ml-2">' +
        '<button type="button" class="btn-edit-template p-1.5 text-gray-400 hover:text-white" title="Edit">' +
        '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>' +
        '</button>' +
        '<button type="button" class="btn-delete-template p-1.5 text-gray-400 hover:text-red-400" title="Delete">' +
        '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>' +
        '</button>' +
        '</div>' +
        '</div>';
    });

    $container.html(html);
  }

  /**
   * Open template editor modal
   */
  function openEditor(template) {
    var isNew = !template;

    $('#template-editor-title').text(isNew ? 'New Template' : 'Edit Template');
    $('#input-template-id').val(isNew ? generateId() : template.id);
    $('#input-template-name').val(isNew ? '' : template.name);
    $('#input-template-description').val(isNew ? '' : (template.description || ''));
    $('#input-template-content').val(isNew ? '' : template.content);
    $('#input-template-is-quick-action').prop('checked', isNew ? false : (template.isQuickAction || false));

    openModal('modal-template-editor');
    $('#input-template-name').focus();
  }

  /**
   * Generate a unique template ID
   */
  function generateId() {
    return 'tpl-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Save template from editor
   */
  function saveTemplate() {
    var id = $('#input-template-id').val().trim();
    var name = $('#input-template-name').val().trim();
    var description = $('#input-template-description').val().trim();
    var content = $('#input-template-content').val();

    if (!name) {
      showToast('Template name is required', 'error');
      return;
    }

    if (!content) {
      showToast('Template content is required', 'error');
      return;
    }

    var templates = state.settings?.promptTemplates || [];
    var existingIndex = templates.findIndex(function(t) { return t.id === id; });

    var template = {
      id: id,
      name: name,
      description: description,
      content: content,
      isQuickAction: $('#input-template-is-quick-action').is(':checked')
    };

    if (existingIndex >= 0) {
      templates[existingIndex] = template;
    } else {
      templates.push(template);
    }

    // Update state and save
    state.settings.promptTemplates = templates;
    saveTemplates(templates);

    closeAllModals();
    renderSettingsTab();
    showToast('Template saved', 'success');
  }

  /**
   * Delete a template
   */
  function deleteTemplate(templateId) {
    var templates = state.settings?.promptTemplates || [];
    var newTemplates = templates.filter(function(t) { return t.id !== templateId; });

    state.settings.promptTemplates = newTemplates;
    saveTemplates(newTemplates);

    renderSettingsTab();
    showToast('Template deleted', 'success');
  }

  /**
   * Save templates to server
   */
  function saveTemplates(templates) {
    $.ajax({
      url: '/api/settings',
      method: 'PUT',
      contentType: 'application/json',
      data: JSON.stringify({ promptTemplates: templates })
    }).fail(function() {
      showToast('Failed to save templates', 'error');
    });
  }

  /**
   * Setup event handlers
   */
  function setupHandlers() {
    // Template selector button
    $(document).on('click', '#btn-open-templates', function(e) {
      e.stopPropagation();

      if (selectorOpen) {
        closeSelector();
      } else {
        openSelector();
      }
    });

    // Template selection from dropdown
    $(document).on('click', '.template-selector-item', function() {
      var templateId = $(this).data('id');
      selectTemplate(templateId);
    });

    // Manage templates link
    $(document).on('click', '#btn-manage-templates', function() {
      closeSelector();
      openModal('modal-settings');
      // Switch to templates tab
      $('.settings-tab').removeClass('active border-purple-500 text-white').addClass('border-transparent text-gray-400');
      $('.settings-tab[data-tab="templates"]').addClass('active border-purple-500 text-white').removeClass('border-transparent text-gray-400');
      $('.settings-tab-content').addClass('hidden');
      $('#settings-tab-templates').removeClass('hidden');
      renderSettingsTab();
    });

    // Add template button in settings
    $(document).on('click', '#btn-add-template', function() {
      openEditor(null);
    });

    // Edit template button
    $(document).on('click', '.btn-edit-template', function(e) {
      e.stopPropagation();
      var templateId = $(this).closest('.template-list-item').data('id');
      var templates = state.settings?.promptTemplates || [];
      var template = templates.find(function(t) { return t.id === templateId; });

      if (template) {
        openEditor(template);
      }
    });

    // Delete template button
    $(document).on('click', '.btn-delete-template', function(e) {
      e.stopPropagation();
      var templateId = $(this).closest('.template-list-item').data('id');

      if (confirm('Delete this template?')) {
        deleteTemplate(templateId);
      }
    });

    // Template fill form submit
    $(document).on('submit', '#form-template-fill', function(e) {
      e.preventDefault();
      handleFillSubmit();
    });

    // Template editor form submit
    $(document).on('submit', '#form-template-editor', function(e) {
      e.preventDefault();
      saveTemplate();
    });

    // Close selector on escape
    $(document).on('keydown', function(e) {
      if (e.key === 'Escape' && selectorOpen) {
        closeSelector();
      }
    });
  }

  return {
    init: init,
    openSelector: openSelector,
    closeSelector: closeSelector,
    renderSettingsTab: renderSettingsTab,
    parseTemplateVariables: parseTemplateVariables,
    renderTemplate: renderTemplate,
    openFillModal: openFillModal,
    insertTemplateText: insertTemplateText
  };
}));
