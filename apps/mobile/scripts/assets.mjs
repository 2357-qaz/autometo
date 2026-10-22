// The iOS app icon and launch image, from the same pixel art as the PWA icons.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BG, icon } from '../../web/scripts/tomo.mjs';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'App', 'App', 'Assets.xcassets');
writeFileSync(join(assets, 'AppIcon.appiconset', 'AppIcon-512@2x.png'), icon(1024, 0.72, BG));
// Launch screen: Tomo small in the middle of the app's background colour (scaled to fill).
const splash = icon(2732, 0.1, BG);
for (const n of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) writeFileSync(join(assets, 'Splash.imageset', n), splash);
console.log('iOS icon and launch image written');
