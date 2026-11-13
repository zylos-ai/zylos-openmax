import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Read the installed Core package, without launching a CLI or caching a version. */
export function readCoreVersion({ env = process.env, io = fs } = {}) {
  const versionAt = root => {
    try {
      const pkg = JSON.parse(io.readFileSync(path.join(root, 'package.json'), 'utf8'));
      return pkg.name === 'zylos' && /^\d+\./.test(pkg.version) ? pkg.version : null;
    } catch { return null; }
  };
  // Match Core's existing explicit override and installation-record precedence.
  if (env.ZYLOS_PACKAGE_ROOT) return versionAt(env.ZYLOS_PACKAGE_ROOT);
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  try {
    const record = JSON.parse(io.readFileSync(path.join(zylosDir, '.claude/skills/comm-bridge/.zylos/core-package.json'), 'utf8'));
    if (record.v === 1 && typeof record.packageRoot === 'string' && path.isAbsolute(record.packageRoot)) {
      const version = versionAt(record.packageRoot);
      if (version) return version;
    }
  } catch { /* Older Core installations may only be discoverable on PATH. */ }
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const executable = path.resolve(directory || '.', 'zylos');
    try {
      if (!io.statSync(executable).isFile()) continue;
      io.accessSync(executable, fs.constants.X_OK);
    } catch { continue; }
    try { return versionAt(path.resolve(path.dirname(io.realpathSync(executable)), '..')); }
    catch { return null; }
  }
  return null;
}
