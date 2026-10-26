// The native app's icon (Tomo on a plum background, to tell it apart from the
// Capacitor app on the home screen) and its launch background colour.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BG, icon } from '../../web/scripts/tomo.mjs';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'AuTomeDo', 'Assets.xcassets');
const json = (path, o) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(o, null, 2) + '\n');
};
const info = { author: 'xcode', version: 1 };
json(join(assets, 'Contents.json'), { info });
json(join(assets, 'AppIcon.appiconset', 'Contents.json'), { images: [{ filename: 'icon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }], info });
writeFileSync(join(assets, 'AppIcon.appiconset', 'icon-1024.png'), icon(1024, 0.72, '#2a1d2b'));
const [r, g, b] = [1, 3, 5].map((i) => (parseInt(BG.slice(i, i + 2), 16) / 255).toFixed(3));
json(join(assets, 'LaunchBackground.colorset', 'Contents.json'), {
  colors: [{ idiom: 'universal', color: { 'color-space': 'srgb', components: { red: r, green: g, blue: b, alpha: '1.000' } } }],
  info,
});
console.log('native icon and launch colour written');
