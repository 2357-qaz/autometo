# Windows validation (2026-10-30)

The Windows job in CI exercises the core, TUI and sync server on Windows with Node 24. It also builds the TUI and runs the bundled CLI through separate processes against a temporary data directory. The existing Linux job remains in place.

At base commit `c576b7419843c420e4ac2e234daa1a038be4ee51`, on Windows x64 build 26200.9711 with Node 24.18.0, the core tests passed 87/87, the TUI tests 19/19, and the server tests 48/48. Core, TUI and server TypeScript checks passed. The TUI bundle built and created a plan, added and completed a task, and read the persisted state from a separate process. The same flow with Chinese text was also checked in an isolated data directory using the source CLI.

The first sandboxed server run could not connect to its own `127.0.0.1` listeners (`EACCES`); the same tests passed outside that restriction, using in-memory databases and loopback only. The Windows CI result must be checked separately on the commit containing the workflow.

Web/PWA and iOS native application tests were not run in this session: the available local dependencies did not include the locked Capacitor packages. This does not establish Windows browser, mobile, installation, or real sync-service acceptance.
