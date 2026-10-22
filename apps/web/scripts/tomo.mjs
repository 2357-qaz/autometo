// Tomo's pixel art as PNGs (no dependencies: tiny PNG encoder). Used for the PWA icons
// (icons.mjs) and the iOS app's icon and launch image (apps/mobile/scripts/assets.mjs).
import { deflateSync } from 'node:zlib';

const ART = [
  '.DCCCCCCCCCCP.',
  '.DCCCCCCCCCCPP',
  '.DCCCCCCCCCCPP',
  '.DCCEECCCEECPP',
  '.DCCEECCCEECPP',
  '.DCKCCCCCCKCPP',
  '.DCCCCMMCCCCPP',
  '.DCCCCCCCCCCPP',
  '.DCCCCCCCCCCPP',
  '.DCCCCCCCCCCP.',
  '......R.......',
  '..FF..R..FF...',
];
const PX = { C: '#d97757', D: '#b5603f', P: '#efe3cf', E: '#1a1512', K: '#f2a48c', M: '#1a1512', R: '#4fb3a6', F: '#8a4b36' };
export const BG = '#141413';
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Draw the art centred, occupying `fill` of the icon width, on an optional background. */
export function icon(size, fill, background) {
  const w = ART[0].length;
  const h = ART.length;
  const cell = Math.floor((size * fill) / Math.max(w, h));
  const ox = Math.floor((size - cell * w) / 2);
  const oy = Math.floor((size - cell * h) / 2);
  const bg = background ? [...rgb(background), 255] : [0, 0, 0, 0];
  return png(size, (x, y) => {
    const ax = Math.floor((x - ox) / cell);
    const ay = Math.floor((y - oy) / cell);
    const ch = x >= ox && y >= oy ? ART[ay]?.[ax] : undefined;
    return ch && PX[ch] ? [...rgb(PX[ch]), 255] : bg;
  });
}
