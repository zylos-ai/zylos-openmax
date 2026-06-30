const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-openmax',
    script: 'src/comm-bridge.js',
    interpreter: 'node',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/openmax'),
    env: {
      NODE_ENV: 'production'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 5000,
    error_file: path.join(os.homedir(), 'zylos/components/openmax/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/openmax/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
