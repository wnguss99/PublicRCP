// PM2 ecosystem config for claudito (multi-instance)
//
// IMPORTANT: if PM2 auto-start was registered by a scheduled task with
// RunLevel=Highest, the PM2 daemon runs ELEVATED and owns \\.\pipe\rpc.sock.
// A non-elevated `pm2` CLI then fails with `connect EPERM`. Drive PM2 from an
// *Administrator* PowerShell, or use scripts/start-instances.ps1.
//
// Usage:
//   cp ecosystem.config.example.js ecosystem.config.js
//   # Edit passwords in ecosystem.config.js
//   pm2 start ecosystem.config.js
//   pm2 save
//
// Each instance gets its own PORT, CLAUDITO_HOME, and credentials.
// To add a user: append an entry to the `instances` array.
// Logs land in ./logs/.

const path = require('path');
const os = require('os');

// A pre-existing single-instance install keeps its data in ~/.claudito
// (project index, settings, conversations). Point the original instance there
// so that user does not lose their project list.
const LEGACY_HOME = path.join(os.homedir(), '.claudito');

// Deliberately OUTSIDE the repo — a gitignored folder under the working tree is
// one `git clean -xdf` away from losing every instance's projects.
const INSTANCE_ROOT = path.join(os.homedir(), '.claudito-instances');

// `user`/`password` omitted => credentials fall through to .env (dotenv).
// PM2-supplied env always wins over .env, because dotenv does not override
// variables that are already present in process.env.
const instances = [
  { port: 4000, home: LEGACY_HOME },
  { port: 4001, user: 'user2', password: 'CHANGE_ME_2', home: path.join(INSTANCE_ROOT, 'user2') },
  { port: 4002, user: 'user3', password: 'CHANGE_ME_3', home: path.join(INSTANCE_ROOT, 'user3') },
  { port: 4003, user: 'user4', password: 'CHANGE_ME_4', home: path.join(INSTANCE_ROOT, 'user4') },
];

function buildEnv(inst) {
  const env = {
    NODE_ENV: 'production',
    PORT: String(inst.port),
    CLAUDITO_HOME: inst.home,
  };

  // Only set these when provided — an explicit `undefined` would be stringified
  // by PM2 into the literal "undefined".
  if (inst.user) {
    env.CLAUDITO_USERNAME = inst.user;
  }

  if (inst.password) {
    env.CLAUDITO_PASSWORD = inst.password;
  }

  return env;
}

module.exports = {
  apps: instances.map((inst) => ({
    name: `claudito-${inst.port}`,
    script: 'dist/index.js',
    cwd: __dirname,
    node_args: '-r dotenv/config',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    restart_delay: 3000,
    max_restarts: 20,
    out_file: `./logs/claudito-${inst.port}-out.log`,
    error_file: `./logs/claudito-${inst.port}-err.log`,
    merge_logs: true,
    time: true,
    env: buildEnv(inst),
  })),
};
