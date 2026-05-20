// PM2 ecosystem config for claudito
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2-startup install        (Run as Administrator — registers auto-start)
//
// Logs land in ./logs/.
module.exports = {
  apps: [
    {
      name: 'claudito',
      script: 'dist/index.js',
      cwd: __dirname,
      node_args: '-r dotenv/config',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      restart_delay: 3000,
      max_restarts: 20,
      out_file: './logs/claudito-out.log',
      error_file: './logs/claudito-err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
