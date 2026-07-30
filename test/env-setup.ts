/**
 * Runs before the test framework and before any module import.
 *
 * Anything calling getDataDirectory() writes into CLAUDITO_HOME, which defaults
 * to ~/.claudito — a *live* instance's data directory. A test run was observed
 * overwriting the real sessions.json there. Point every run at a throwaway
 * directory, unique per Jest worker so parallel workers cannot collide.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const workerId = process.env.JEST_WORKER_ID || '0';
const testHome = path.join(os.tmpdir(), 'claudito-test-home', `${process.pid}-${workerId}`);

fs.mkdirSync(testHome, { recursive: true });

process.env.CLAUDITO_HOME = testHome;
