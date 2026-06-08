const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-coco-workspace',
    script: 'src/comm-bridge.js',
    interpreter: 'node',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace'),
    env: {
      NODE_ENV: 'production'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 5000,
    error_file: path.join(os.homedir(), 'zylos/components/coco-workspace/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/coco-workspace/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
