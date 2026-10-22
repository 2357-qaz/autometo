// What the JavaScript engine needs from its host, and the web APIs core expects, built
// on top of it. JavaScriptCore (the iOS host) only has the ECMAScript built-ins: no
// timers, fetch, AbortController, structuredClone, queueMicrotask or console. The Swift
// side (AuTomeDo/Engine.swift) implements `Host`; tests implement it in Node.
//
// Calls into the host are synchronous; anything asynchronous (a timer firing, a request
// finishing) comes back through the functions on the `Automedo` global (see main.ts).

export interface Host {
  log(level: string, message: string): void;
  /** The state document (null: none yet). Synchronous; `writeDoc` replaces it atomically. */
  readDoc(): string | null;
  writeDoc(text: string): void;
  /** Keep a copy that must not be lost (an unreadable document); throws if it cannot. */
  saveAside(label: string, text: string): void;
  /** Small settings (the sync server address and token). null removes. */
  getItem(key: string): string | null;
  setItem(key: string, value: string | null): void;
  /** Call Automedo.timer(id) after `ms`, unless cleared. */
  setTimer(id: number, ms: number): void;
  clearTimer(id: number): void;
  /** Start a request; call Automedo.fetched(id, status, headersJSON, body, error) when done. */
  fetch(id: number, url: string, method: string, headersJSON: string, body: string | null): void;
  cancelFetch(id: number): void;
  /** The answer to Automedo.call(id, …). */
  reply(id: number, json: string): void;
  /** The state (or the sync status) changed: ask for the view again. */
  changed(): void;
}

type Fn = (...a: unknown[]) => unknown;

const timers = new Map<number, { fn: Fn; args: unknown[]; every?: number }>();
const requests = new Map<number, { resolve: (r: Response) => void; reject: (e: unknown) => void }>();
let nextId = 1;
let host: Host;

/** A host timer fired. */
export function fireTimer(id: number) {
  const t = timers.get(id);
  if (!t) return;
  if (t.every != null) host.setTimer(id, t.every);
  else timers.delete(id);
  t.fn(...t.args);
}

/** A host request finished (status 0 + error: it failed). */
export function finishFetch(id: number, status: number, headersJSON: string, body: string | null, error: string | null) {
  const r = requests.get(id);
  if (!r) return;
  requests.delete(id);
  if (error) return r.reject(new TypeError(error));
  // Only what core reads of a Response: ok, status, headers.get, text(), json().
  r.resolve(new HostResponse(status, JSON.parse(headersJSON || '{}') as Record<string, string>, body ?? '') as unknown as Response);
}

class HostResponse {
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  constructor(readonly status: number, headers: Record<string, string>, private body: string) {
    this.ok = status >= 200 && status < 300;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.headers = { get: (name) => lower[name.toLowerCase()] ?? null };
  }
  async text() {
    return this.body;
  }
  async json() {
    return JSON.parse(this.body) as unknown;
  }
}

class HostAbortSignal {
  aborted = false;
  reason: unknown;
  onabort: (() => void) | null = null;
  private listeners: (() => void)[] = [];
  addEventListener(_: 'abort', f: () => void) {
    this.listeners.push(f);
  }
  removeEventListener(_: 'abort', f: () => void) {
    this.listeners = this.listeners.filter((x) => x !== f);
  }
  _abort(reason: unknown) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    this.onabort?.();
    for (const f of this.listeners) f();
  }
}

class HostAbortController {
  readonly signal = new HostAbortSignal();
  abort(reason: unknown = abortError()) {
    this.signal._abort(reason);
  }
}

function abortError() {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

function hostFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: HostAbortSignal } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const signal = init.signal;
    if (signal?.aborted) return reject(signal.reason ?? abortError());
    requests.set(id, { resolve: resolve as (r: Response) => void, reject });
    signal?.addEventListener('abort', () => {
      if (!requests.delete(id)) return;
      host.cancelFetch(id);
      reject(signal.reason ?? abortError());
    });
    host.fetch(id, String(url), init.method ?? 'GET', JSON.stringify(init.headers ?? {}), init.body ?? null);
  });
}

/** structuredClone for plain data (the state): keeps undefined members, like the real one. */
function cloneData<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cloneData) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = cloneData(x);
    return out as T;
  }
  return v;
}

/** Install the web APIs core uses wherever the global object lacks them. */
export function installHost(h: Host, g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>) {
  host = h;
  const timer = (every: boolean) => (fn: Fn, ms = 0, ...args: unknown[]) => {
    const id = nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { fn, args, every: every ? Math.max(1, delay) : undefined });
    host.setTimer(id, delay);
    return id;
  };
  const clear = (id: unknown) => {
    if (typeof id !== 'number' || !timers.delete(id)) return;
    host.clearTimer(id);
  };
  g.setTimeout ??= timer(false);
  g.setInterval ??= timer(true);
  g.clearTimeout ??= clear;
  g.clearInterval ??= clear;
  g.queueMicrotask ??= (f: () => void) => void Promise.resolve().then(f);
  g.structuredClone ??= cloneData;
  g.AbortController ??= HostAbortController;
  g.fetch ??= hostFetch;
  const say = (level: string) => (...a: unknown[]) => host.log(level, a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack ?? ''}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  // Always ours: a built-in console (if any) would only reach a debugger, not the app's log.
  g.console = { log: say('log'), info: say('info'), debug: say('debug'), warn: say('warn'), error: say('error') };
}
