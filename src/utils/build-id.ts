import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * A fingerprint of the compiled code this process actually loaded.
 *
 * All instances run the same `dist/index.js`, so a code change reaches everyone —
 * but only after a restart, because Node holds the code in memory. Restarting one
 * port and forgetting the others leaves them silently running the previous build.
 *
 * Comparing file timestamps does not work: `npm run build` rewrites every file
 * even when nothing changed, so the pre-push validation alone makes every
 * instance look stale. Hashing the content instead means instances that loaded
 * the same code agree, and any that did not stand out.
 *
 * Computed once at first use from the files on disk. That is the code this
 * process loaded, provided nothing rebuilt in between — which is exactly the
 * drift we want to surface anyway.
 */
let cached: string | null = null;

function collectJsFiles(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      collectJsFiles(full, acc);
    } else if (entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }

  return acc;
}

export function getBuildId(): string {
  if (cached !== null) {
    return cached;
  }

  // __dirname is dist/utils at runtime, so the compiled root is one level up.
  const distRoot = path.resolve(__dirname, '..');
  const files = collectJsFiles(distRoot).sort();
  const hash = crypto.createHash('sha256');

  for (const file of files) {
    try {
      hash.update(path.relative(distRoot, file));
      hash.update(fs.readFileSync(file));
    } catch {
      // A file we cannot read still contributes its name, which is enough to
      // distinguish builds.
    }
  }

  cached = files.length === 0 ? 'unknown' : hash.digest('hex').slice(0, 12);
  return cached;
}
