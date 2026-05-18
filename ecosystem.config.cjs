const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-workspace',
    script: 'src/comm-bridge.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/workspace'),
    env: {
      NODE_ENV: 'production'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 5000,
    error_file: path.join(os.homedir(), 'zylos/components/workspace/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/workspace/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
