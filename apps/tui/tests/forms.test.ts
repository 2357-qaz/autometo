import { describe, expect, it, vi } from 'vitest';
import { createStore, emptyState, type DeleteGuard, type SyncClient } from '@automedo/core';
import { formFor } from '../src/forms';

const guard: DeleteGuard = { error: 'confirm-delete', deletes: 42, live: 50, workspaces: [{ kind: 'plan', title: '甲' }, { kind: 'goal', title: '乙' }], ids: ['plan:a', 'goal:b'] };
function fakeSync(confirm: DeleteGuard | null) {
  return {
    config: () => ({ url: 'http://x', token: 't' }),
    getStatus: () => ({ phase: 'error', lastSyncAt: null, error: null, pending: 0, confirm, conflicts: [] }),
    confirmDeletes: vi.fn(async () => true),
    restoreFromServer: vi.fn(async () => {}),
  };
}

describe('/sync while the server paused a mass deletion', () => {
  it('offers restore (default) / confirm / later, and calls the matching client method', async () => {
    const sync = fakeSync(guard);
    const spec = formFor({ type: 'sync' }, createStore(emptyState()), sync as unknown as SyncClient)!;
    expect(spec.title).toBe('同步已暂停');
    expect(spec.desc).toContain('42 条');
    expect(spec.desc).toContain('计划「甲」');
    const field = spec.fields[0];
    expect(field.kind === 'select' && field.initial).toBe('restore');
    expect((await spec.submit({ act: 'later' })).text).toContain('暂停');
    expect(sync.confirmDeletes).not.toHaveBeenCalled();
    expect(sync.restoreFromServer).not.toHaveBeenCalled();
    await spec.submit({ act: 'restore' });
    expect(sync.restoreFromServer).toHaveBeenCalledOnce();
    await spec.submit({ act: 'confirm' });
    expect(sync.confirmDeletes).toHaveBeenCalledOnce();
  });

  it('is the normal connect form otherwise', () => {
    const spec = formFor({ type: 'sync' }, createStore(emptyState()), fakeSync(null) as unknown as SyncClient)!;
    expect(spec.title).toBe('同步');
  });
});
