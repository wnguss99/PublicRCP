/**
 * @jest-environment jsdom
 */

const EscapeUtils = require('../../public/js/modules/escape-utils');

describe('EscapeUtils', () => {
  describe('escapeHtml', () => {
    it('should escape < character', () => {
      expect(EscapeUtils.escapeHtml('<script>')).toBe('&lt;script&gt;');
    });

    it('should escape > character', () => {
      expect(EscapeUtils.escapeHtml('a > b')).toBe('a &gt; b');
    });

    it('should escape & character', () => {
      expect(EscapeUtils.escapeHtml('foo & bar')).toBe('foo &amp; bar');
    });

    it('should escape " character', () => {
      expect(EscapeUtils.escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
    });

    it('should escape \' character', () => {
      expect(EscapeUtils.escapeHtml("it's")).toBe('it&#039;s');
    });

    it('should handle multiple special characters', () => {
      const result = EscapeUtils.escapeHtml('<div class="test">foo & bar</div>');
      expect(result).toBe('&lt;div class=&quot;test&quot;&gt;foo &amp; bar&lt;/div&gt;');
    });

    /**
     * Almost every caller interpolates into a double-quoted attribute. The old
     * browser path (textContent -> innerHTML) left quotes alone, so a value like
     * this closed data-path early and the rest became live markup.
     */
    it('should not allow breaking out of a double-quoted attribute', () => {
      const hostile = 'x" onmouseover="alert(1)';
      const attr = 'data-path="' + EscapeUtils.escapeHtml(hostile) + '"';

      expect(attr).toBe('data-path="x&quot; onmouseover=&quot;alert(1)"');
      expect(attr).not.toContain('onmouseover="alert');
    });

    it('should not allow breaking out of a single-quoted attribute', () => {
      const hostile = "x' onmouseover='alert(1)";
      const attr = "data-path='" + EscapeUtils.escapeHtml(hostile) + "'";

      expect(attr).not.toContain("onmouseover='alert");
    });

    it('should behave the same with and without a DOM available', () => {
      // The DOM shortcut and the string path used to disagree: only the Node
      // fallback escaped quotes, so the browser was the unsafe one.
      expect(EscapeUtils.escapeHtml('a"b\'c<d>e&f')).toBe('a&quot;b&#039;c&lt;d&gt;e&amp;f');
    });

    it('should return empty string for null and undefined', () => {
      expect(EscapeUtils.escapeHtml(null)).toBe('');
      expect(EscapeUtils.escapeHtml(undefined)).toBe('');
    });

    it('should return empty string for empty input', () => {
      expect(EscapeUtils.escapeHtml('')).toBe('');
    });

    it('should handle plain text without changes', () => {
      expect(EscapeUtils.escapeHtml('Hello World')).toBe('Hello World');
    });

    it('should handle numbers', () => {
      expect(EscapeUtils.escapeHtml('Price: $100')).toBe('Price: $100');
    });

    it('should prevent XSS injection', () => {
      const xss = '<img src=x onerror="alert(1)">';
      const result = EscapeUtils.escapeHtml(xss);
      // Tags are escaped, so they won't execute as HTML
      expect(result).not.toContain('<img');
      expect(result).toContain('&lt;img');
      expect(result).toContain('&gt;');
    });
  });

  describe('escapeRegExp', () => {
    it('should escape dot', () => {
      expect(EscapeUtils.escapeRegExp('file.txt')).toBe('file\\.txt');
    });

    it('should escape asterisk', () => {
      expect(EscapeUtils.escapeRegExp('*.js')).toBe('\\*\\.js');
    });

    it('should escape plus', () => {
      expect(EscapeUtils.escapeRegExp('a+b')).toBe('a\\+b');
    });

    it('should escape question mark', () => {
      expect(EscapeUtils.escapeRegExp('file?.txt')).toBe('file\\?\\.txt');
    });

    it('should escape caret', () => {
      expect(EscapeUtils.escapeRegExp('^start')).toBe('\\^start');
    });

    it('should escape dollar sign', () => {
      expect(EscapeUtils.escapeRegExp('end$')).toBe('end\\$');
    });

    it('should escape curly braces', () => {
      expect(EscapeUtils.escapeRegExp('a{1,2}')).toBe('a\\{1,2\\}');
    });

    it('should escape parentheses', () => {
      expect(EscapeUtils.escapeRegExp('(group)')).toBe('\\(group\\)');
    });

    it('should escape pipe', () => {
      expect(EscapeUtils.escapeRegExp('a|b')).toBe('a\\|b');
    });

    it('should escape square brackets', () => {
      expect(EscapeUtils.escapeRegExp('[abc]')).toBe('\\[abc\\]');
    });

    it('should escape backslash', () => {
      expect(EscapeUtils.escapeRegExp('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('should handle multiple special characters', () => {
      const result = EscapeUtils.escapeRegExp('[a-z]*.{js,ts}');
      expect(result).toBe('\\[a-z\\]\\*\\.\\{js,ts\\}');
    });

    it('should return empty string for empty input', () => {
      expect(EscapeUtils.escapeRegExp('')).toBe('');
    });

    it('should handle plain text without changes', () => {
      expect(EscapeUtils.escapeRegExp('HelloWorld')).toBe('HelloWorld');
    });

    it('should work with RegExp constructor', () => {
      const searchTerm = 'file.txt';
      const escaped = EscapeUtils.escapeRegExp(searchTerm);
      const regex = new RegExp(escaped);

      expect(regex.test('file.txt')).toBe(true);
      expect(regex.test('fileAtxt')).toBe(false);
    });

    it('should allow creating case-insensitive search', () => {
      const searchTerm = 'Hello (World)';
      const escaped = EscapeUtils.escapeRegExp(searchTerm);
      const regex = new RegExp(escaped, 'i');

      expect(regex.test('hello (world)')).toBe(true);
      expect(regex.test('HELLO (WORLD)')).toBe(true);
      expect(regex.test('Hello World')).toBe(false);
    });
  });
});
