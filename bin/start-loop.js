#!/usr/bin/env node

/**
 * Runs build-and-start in a loop for development.
 * When the server exits (e.g., via Development > Shutdown), it rebuilds and restarts.
 * Press Ctrl+C twice quickly to fully exit.
 *
 * Credentials come from the environment (CLAUDITO_USERNAME / CLAUDITO_PASSWORD)
 * or, when unset, are generated per run by AuthService. This script only passes
 * the environment through.
 */

const { spawn } = require('child_process');
const path = require('path');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

let lastCtrlCTime = 0;
let lastServerExitTime = 0;
let isExiting = false;

function run() {
  console.log('\n=== Starting build and run cycle ===\n');

  // Build command string to avoid DEP0190 deprecation warning
  const command = `${npm} run build-and-start`;
  const child = spawn(command, [], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
    }
  });

  child.on('exit', (code) => {
    if (isExiting) {
      process.exit(code || 0);
    }

    const now = Date.now();

    // Only exit on quick successive server exits (not from Ctrl+C)
    if (now - lastServerExitTime < 2000) {
      console.log('\n=== Quick restart detected (server crashed?), exiting loop ===\n');
      process.exit(code || 0);
    }

    lastServerExitTime = now;
    console.log(`\n=== Server exited with code ${code}, restarting in 1 second... ===\n`);
    setTimeout(run, 1000);
  });

  child.on('error', (err) => {
    console.error('Failed to start process:', err.message);
    setTimeout(run, 2000);
  });
}

process.on('SIGINT', () => {
  const now = Date.now();

  if (now - lastCtrlCTime < 2000) {
    console.log('\n=== Exiting loop ===\n');
    isExiting = true;
    process.exit(0);
  }

  lastCtrlCTime = now;
  console.log('\n=== Press Ctrl+C again within 2 seconds to exit loop ===\n');
});

console.log('Starting build-and-start loop (Ctrl+C twice to exit)...');
run();
