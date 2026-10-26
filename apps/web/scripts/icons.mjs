// Generate PWA icons from Tomo's pixel art.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BG, icon } from './tomo.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon-192.png'), icon(192, 0.78, BG));
writeFileSync(join(out, 'icon-512.png'), icon(512, 0.78, BG));
writeFileSync(join(out, 'maskable-512.png'), icon(512, 0.56, BG)); // inside the 80% safe zone
writeFileSync(join(out, 'apple-touch-icon.png'), icon(180, 0.72, BG)); // iOS: no transparency
writeFileSync(join(out, 'favicon-32.png'), icon(32, 1, null));
console.log('icons written to', out);
