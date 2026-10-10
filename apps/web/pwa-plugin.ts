// Emits sw.js with the list of build assets to precache.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export function pwa(): Plugin {
  return {
    name: 'automedo-pwa',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js');
      const icons = ['icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'manifest.webmanifest'];
      const precache = [...new Set([...files.filter((f) => f !== 'index.html'), ...icons])];
      const version = Date.now().toString(36);
      const src = readFileSync(resolve(__dirname, 'sw-template.js'), 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}
