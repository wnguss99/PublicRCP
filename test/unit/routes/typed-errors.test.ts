/**
 * Structural guard: route handlers must throw typed errors, never a bare `Error`.
 *
 * `formatErrorResponse()` keeps the message only for an `AppError`. Everything else
 * is replaced with `{ error: 'An unexpected error occurred', code: 'INTERNAL_ERROR' }`
 * and a 500 — correct for a genuine crash, and actively harmful for a refusal the
 * user caused, because the server then knows exactly what is wrong and says nothing.
 *
 * That is not hypothetical. `throw new Error('Project with this path already exists')`
 * made "Add Project" look like a crash; the same add was retried eleven times against
 * an error that could not explain itself. Two roadmap handlers wrapped
 * `result.error` — the only explanation available — in a bare Error and threw the
 * explanation away.
 *
 * Routes are the boundary where an error becomes something a person reads, so the
 * rule is enforced here rather than across all of src: deeper layers legitimately
 * throw bare Errors for programmer mistakes (`'... not implemented'`), which really
 * are unexpected.
 *
 * If this fails, pick the error that matches what happened — ValidationError (400),
 * NotFoundError (404), ConflictError (409), or AppError with an explicit code — and
 * name the thing the user has to change.
 */
import fs from 'fs';
import path from 'path';

const ROUTES_DIR = path.join(__dirname, '..', '..', '..', 'src', 'routes');

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      collectTsFiles(full, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(full);
    }
  }

  return acc;
}

describe('route handlers throw typed errors', () => {
  const files = collectTsFiles(ROUTES_DIR);

  it('finds the route sources to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no route file throws a bare Error', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const relative = path.relative(ROUTES_DIR, file);
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

      lines.forEach((line, index) => {
        if (/throw new Error\s*\(/.test(line)) {
          offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        'Route handlers must throw a typed error so the reason reaches the user.\n' +
          'A bare Error becomes 500 "An unexpected error occurred" and the message is lost.\n' +
          'Use ValidationError / NotFoundError / ConflictError / AppError instead.\n' +
          'Offending lines:\n  ' +
          offenders.join('\n  ')
      );
    }

    expect(offenders).toEqual([]);
  });
});
