// Bundle the CLI (+ @automedo/core) into dist/cli.js; ink/react stay as dependencies.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

await build({
  entryPoints: ['src/cli.tsx'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  external: ['ink', 'react', 'react/jsx-runtime'],
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
});
chmodSync('dist/cli.js', 0o755);
console.log('built dist/cli.js');
