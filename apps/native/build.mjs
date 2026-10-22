// Bundle the engine (core + the terminal version's forms and lines) into one script for
// JavaScriptCore: ios/AuTomeDo/Resources/engine.js (and dist/engine.js for the tests).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/engine.js',
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  target: 'es2022', // JavaScriptCore of iOS 17
  legalComments: 'none',
  logLevel: 'warning',
});
mkdirSync('ios/AuTomeDo/Resources', { recursive: true });
copyFileSync('dist/engine.js', 'ios/AuTomeDo/Resources/engine.js');
console.log('built dist/engine.js');
