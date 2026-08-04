/**
 * Escape Utilities Module
 * Pure functions for escaping strings for various contexts
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EscapeUtils = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  /**
   * Escape HTML special characters to prevent XSS
   *
   * Quotes matter as much as angle brackets here. This used to take a DOM
   * shortcut in the browser — textContent in, innerHTML out — which escapes
   * `& < >` but leaves `"` and `'` alone. Nearly every caller interpolates the
   * result into a double-quoted attribute (`data-path="…"`, `data-name="…"`,
   * `data-current-label="…"`), so a value containing a quote closed the
   * attribute early and anything after it became markup:
   *
   *   escapeHtml('x" onmouseover="…')  ->  data-path="x" onmouseover="…"
   *
   * The Node fallback below already escaped all five characters, so the browser —
   * the only place that can actually execute script — was the unsafe one, and the
   * two paths disagreed. One implementation now, and it is the safe one.
   *
   * @param {string} text - Text to escape
   * @returns {string} HTML-escaped text, safe in both element and attribute context
   */
  function escapeHtml(text) {
    if (text === null || text === undefined) return '';

    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Escape special characters for use in a regular expression
   * @param {string} string - String to escape
   * @returns {string} Regex-escaped string
   */
  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  return {
    escapeHtml: escapeHtml,
    escapeRegExp: escapeRegExp
  };
}));
