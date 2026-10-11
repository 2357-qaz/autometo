// This injection is opt-in and restricted to the test's explicit temporary home.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const home = process.env.AUTOMEDO_HOME;
if (!home || process.env.AUDIT_INJECT_ENOSPC !== '1') throw new Error('audit isolation required');
const write = fs.writeFileSync;
fs.writeFileSync = function(path, ...args) {
  if (String(path).startsWith(join(home, 'state.json.'))) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
  return write.call(this, path, ...args);
};
syncBuiltinESMExports();
