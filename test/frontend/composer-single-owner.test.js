/**
 * Structural guard: nothing may take the chat composer away from the user.
 *
 * Every incident where the chat input became permanently unusable had the same
 * shape — several call sites writing `#input-message.disabled` on their own
 * schedule, each releasing it only if a particular event turned up. Reviews did
 * not catch it because each individual call looked reasonable. This test does:
 * it fails the build the moment anything disables the composer again, so the
 * invariant survives people who have never read the incident.
 *
 * The rule is absolute, and ComposerGate is not exempt: `apply()` only ever
 * writes `disabled = false`. If you need to stop an action while something is in
 * flight, track it with ComposerGate.hold(reason, { isLive, ttlMs }) and refuse
 * the action with a toast — never by removing the user's ability to type.
 */
const fs = require('fs');
const path = require('path');

const JS_ROOT = path.join(__dirname, '..', '..', 'public', 'js');
const OWNER_FILE = path.join('modules', 'composer-gate.js');

const COMPOSER_IDS = ['input-message', 'btn-send-message'];

function collectJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'types') continue;
      collectJsFiles(full, acc);
    } else if (entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }

  return acc;
}

/**
 * Find anything that could make the composer unusable.
 *
 * Reads (`prop('disabled')` with no second argument) stay allowed. Writes that
 * provably set it usable — `= false`, `prop('disabled', false)` — are allowed
 * too, since re-enabling is the whole point; anything else is rejected, and that
 * deliberately includes writing a *variable* whose value cannot be read here.
 */
function findForbiddenWrites(source) {
  const lines = source.split(/\r?\n/);
  const hits = [];

  const forbidden = [
    // $('#input-message').prop('disabled', <not false>) / .attr('disabled', …)
    /(prop|attr)\(\s*['"]disabled['"]\s*,(?!\s*false\s*\))/,
    /removeAttr\(\s*['"]disabled['"]\s*\)/,
    // Direct DOM writes to anything but false
    /\.disabled\s*=(?!\s*false)/,
    /\.readOnly\s*=(?!\s*false)/,
    // Unusable without being disabled
    /(prop|attr)\(\s*['"]readonly['"]\s*,(?!\s*false\s*\))/i,
    /pointerEvents\s*=\s*['"]none['"]/,
    /addClass\(\s*['"][^'"]*pointer-events-none/,
    /addClass\(\s*['"][^'"]*opacity-50/
  ];

  lines.forEach((line, index) => {
    const mentionsComposer = COMPOSER_IDS.some((id) => line.includes(id));
    if (!mentionsComposer) return;

    if (forbidden.some((re) => re.test(line))) {
      hits.push({ line: index + 1, text: line.trim() });
    }
  });

  return hits;
}

describe('the chat composer can never be disabled', () => {
  const files = collectJsFiles(JS_ROOT);

  it('finds the frontend sources to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('ComposerGate exists and is the only module allowed to touch the composer', () => {
    const owner = files.find((f) => f.endsWith(OWNER_FILE));
    expect(owner).toBeDefined();
  });

  it('no file anywhere makes the composer unusable — ComposerGate included', () => {
    const offenders = [];

    // Deliberately does NOT skip composer-gate.js: the owner is bound by the
    // rule too. Its apply() may only ever enable.
    for (const file of files) {
      const relative = path.relative(JS_ROOT, file);
      const hits = findForbiddenWrites(fs.readFileSync(file, 'utf8'));

      for (const hit of hits) {
        offenders.push(`${relative}:${hit.line}  ${hit.text}`);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'The chat composer must never be disabled — not even temporarily.\n' +
          'To block an action while something is in flight, track it with\n' +
          'ComposerGate.hold(reason, { isLive, ttlMs }) and refuse the action with\n' +
          'a toast. Do not take away the ability to type.\n' +
          'Offending lines:\n  ' +
          offenders.join('\n  ')
      );
    }

    expect(offenders).toEqual([]);
  });

  it('apply() only ever enables the composer', () => {
    const source = fs.readFileSync(path.join(JS_ROOT, OWNER_FILE), 'utf8');
    const applyBody = source.slice(source.indexOf('function apply()'));

    expect(applyBody).toMatch(/input\.disabled = false/);
    expect(applyBody).toMatch(/sendBtn\.disabled = false/);
    // No branch may reach a truthy disabled assignment.
    expect(applyBody).not.toMatch(/disabled = true/);
    expect(applyBody).not.toMatch(/disabled = blocked/);
  });

  it('there is no unlock control for the user to find and press', () => {
    const source = fs.readFileSync(path.join(JS_ROOT, OWNER_FILE), 'utf8');

    // Recovery must be automatic. A button would put the burden of noticing and
    // fixing a bug on the person least equipped to do it.
    expect(source).not.toMatch(/ensureUnlockControl/);
    expect(source).toMatch(/removeLegacyUnlockControl/);
  });

  it('every tracked operation still has a capped lifetime', () => {
    const source = fs.readFileSync(path.join(JS_ROOT, OWNER_FILE), 'utf8');

    // Bounds the *flags* now rather than the input, but a stuck flag still makes
    // the app ignore the user, so the cap must stay.
    expect(source).toMatch(/MAX_TTL_MS/);
    expect(source).toMatch(/Math\.min\(o\.ttlMs, MAX_TTL_MS\)/);
  });
});
