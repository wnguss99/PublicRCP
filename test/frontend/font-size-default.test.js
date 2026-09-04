/**
 * The base font size has two defaults, and they have to agree.
 *
 * `--claudito-font-size` is applied to `html`, so it scales every rem in the
 * interface, and `loadFontSize()` overwrites it from localStorage on load. The
 * CSS said 17px while the JS said 14px, which produced two distinct reports:
 *
 *   - every page load visibly jumped the whole UI from one size to the other
 *   - anything that failed before loadFontSize() ran left it stuck at 17px,
 *     which is indistinguishable from "the font got bigger on its own"
 *
 * localStorage is also per origin, and the origin includes the port. A user
 * opening a newly added instance gets no stored value and lands on the default,
 * so the default is what they actually see — it is not a throwaway number.
 */
const fs = require('fs');
const path = require('path');

describe('base font size default', () => {
  const root = path.join(__dirname, '..', '..', 'public');
  const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');

  function cssDefault() {
    const match = css.match(/--claudito-font-size:\s*(\d+)px/);
    expect(match).not.toBeNull();
    return Number(match[1]);
  }

  function jsDefault() {
    const match = appJs.match(
      /loadFromLocalStorage\(\s*LOCAL_STORAGE_KEYS\.FONT_SIZE\s*,\s*(\d+)\s*\)/
    );
    expect(match).not.toBeNull();
    return Number(match[1]);
  }

  it('declares a numeric default in the stylesheet', () => {
    expect(cssDefault()).toBeGreaterThan(0);
  });

  it('declares a numeric default in loadFontSize()', () => {
    expect(jsDefault()).toBeGreaterThan(0);
  });

  it('uses the same number in both places', () => {
    // The whole point. Disagreement is invisible in review and obvious on screen.
    expect(cssDefault()).toBe(jsDefault());
  });

  it('keeps the default inside the range the UI can reach', () => {
    // loadFontSize() clamps to 10-24 and the toolbar steps by 2. A default
    // outside that range could not be returned to once the user moved off it.
    const value = jsDefault();
    expect(value).toBeGreaterThanOrEqual(10);
    expect(value).toBeLessThanOrEqual(24);
  });

  it('still scales the whole UI from the html element', () => {
    // If this stops being applied to `html`, the two defaults no longer need to
    // match and this test becomes misleading rather than protective.
    expect(css).toMatch(/html,\s*body\s*\{[^}]*font-size:\s*var\(--claudito-font-size\)/);
  });
});
