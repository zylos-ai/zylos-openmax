// Preloaded with `node --import` into a hook that a test runs: before each rename onto the file named
// by RECORD_RENAME_TARGET, appends the mode of the file being renamed (octal) as one line to
// RECORD_RENAME_LOG. It only observes; the rename itself is the real one.
import fs from 'node:fs';

const target = process.env.RECORD_RENAME_TARGET;
const log = process.env.RECORD_RENAME_LOG;
const renameSync = fs.renameSync;

fs.renameSync = function recordingRenameSync(from, to, ...rest) {
  if (target && log && String(to) === target) {
    fs.appendFileSync(log, `${(fs.statSync(from).mode & 0o777).toString(8)}\n`);
  }
  return renameSync.call(this, from, to, ...rest);
};
