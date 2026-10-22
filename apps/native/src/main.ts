// Entry of the bundle loaded into JavaScriptCore (build.mjs → AuTomeDo/Resources/engine.js).
// The Swift side defines the global `host` (see host.ts), evaluates this file, then:
//   Automedo.start()                       → JSON { loadError }
//   Automedo.call(id, name, argsJSON)      → answer later through host.reply(id, json)
//   Automedo.timer(id) / Automedo.fetched(…) when a host timer fires / a request ends
import { fireTimer, finishFetch, installHost, type Host } from './host';
import { createEngine, type Engine } from './engine';

declare const host: Host;

let engine: Engine | null = null;

const Automedo = {
  start(): string {
    installHost(host);
    engine = createEngine(host);
    return JSON.stringify({ loadError: engine.api.loadError() });
  },
  call(id: number, name: string, argsJSON: string) {
    const api = engine?.api as Record<string, (a: unknown) => unknown> | undefined;
    const fn = api?.[name];
    Promise.resolve()
      .then(() => {
        if (!fn) throw new Error(`unknown call ${name}`);
        return fn(JSON.parse(argsJSON || '{}'));
      })
      .then(
        (r) => host.reply(id, JSON.stringify(r ?? null)),
        (e: unknown) => {
          console.error(e);
          host.reply(id, JSON.stringify({ text: `出错了：${(e as Error)?.message ?? String(e)}`, error: true }));
        },
      );
  },
  timer: fireTimer,
  fetched: finishFetch,
};

(globalThis as unknown as { Automedo: typeof Automedo }).Automedo = Automedo;
