import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { emptyState, ops } from '@automedo/core';

describe('several automedo processes writing the same data file', () => {
  it('lose nothing even when their writes race (lock + merge)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'automedo-writers-'));
    try {
      const s = emptyState();
      ops.createPlan(s, 'shared');
      writeFileSync(join(home, 'state.json'), JSON.stringify(s));
      const N = 25;
      const run = (name: string) => {
        const child = spawn(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'fixtures/writer.ts'), name, String(N)], {
          env: { ...process.env, AUTOMEDO_HOME: home },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr!.on('data', (b) => (err += b));
        return once(child, 'exit').then(([code]) => ({ code, err }));
      };
      const results = await Promise.all([run('A'), run('B'), run('C')]);
      for (const r of results) expect(r, r.err).toMatchObject({ code: 0 });
      const doc = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
      const titles: string[] = doc.plans[0].tasks.map((t: { title: string }) => t.title);
      expect(titles).toHaveLength(3 * N);
      for (const who of ['A', 'B', 'C']) for (let i = 0; i < N; i++) expect(titles).toContain(`${who} ${i}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
