// Tomo — AuTomeDo's mascot: a little pixel notebook ("tome") with a bookmark ribbon.
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

const COLOR: Record<string, string> = {
  C: 'var(--accent)',
  D: '#b5603f',
  P: '#efe3cf',
  E: '#1a1512',
  K: '#f2a48c',
  M: '#1a1512',
  R: 'var(--teal)',
  F: '#8a4b36',
};

export function Mascot({ px = 6, title = 'Tomo' }: { px?: number; title?: string }) {
  const w = ART[0].length;
  const h = ART.length;
  // One path per colour so neighbouring pixels merge without anti-aliasing seams.
  const paths = new Map<string, string>();
  ART.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      paths.set(ch, (paths.get(ch) ?? '') + `M${x} ${y}h1v1h-1z`);
    }),
  );
  return (
    <svg className="mascot" width={w * px} height={h * px} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" role="img" aria-label={title}>
      <title>{title}</title>
      <g className="mascot-body">
        {[...paths].map(([ch, d]) => (
          <path key={ch} d={d} fill={COLOR[ch]} className={ch === 'E' ? 'eye' : undefined} />
        ))}
      </g>
    </svg>
  );
}
