// Render formatted lines as ANSI for one-shot CLI output.
import type { Line } from './format';

const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function toAnsi(lines: Line[], color = process.stdout.isTTY && !process.env.NO_COLOR): string {
  return lines
    .map((l) =>
      l
        .map((s) => {
          if (!color) return s.t;
          let pre = '';
          if (s.c) pre += `\x1b[38;2;${hex(s.c).join(';')}m`;
          if (s.bg) pre += `\x1b[48;2;${hex(s.bg).join(';')}m`;
          if (s.b) pre += '\x1b[1m';
          if (s.s) pre += '\x1b[9m';
          return pre ? `${pre}${s.t}\x1b[0m` : s.t;
        })
        .join(''),
    )
    .join('\n');
}
