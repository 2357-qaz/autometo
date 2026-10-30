# Windows validation (2026-10-30)

The Windows job in CI exercises the core, TUI, sync server and shared native engine on Windows with Node 24. It also runs the web glue's mocked tests, builds the TUI and runs the bundled CLI through separate processes against a temporary data directory. The existing Linux job remains in place.

At base commit `c576b7419843c420e4ac2e234daa1a038be4ee51`, on Windows x64 build 26200.9711 with Node 24.18.0, the core tests passed 87/87, the TUI tests 19/19, the server tests 48/48, and the shared native JavaScript engine tests 11/11. Core, TUI, server and native engine TypeScript checks passed. The web glue's 8/8 tests passed with fake Capacitor plugins and an in-memory storage substitute. The bundled TUI created a Chinese plan, added and completed a Chinese task, and read the persisted state from a separate process.

The first sandboxed server run could not connect to its own `127.0.0.1` listeners (`EACCES`); the same tests passed outside that restriction, using in-memory databases and loopback only. The Windows CI result must be checked separately on the commit containing the workflow.

The available local dependencies did not include the locked Capacitor packages; the web glue tests explicitly mock those plugins. The web build, Windows browser UI and iOS native application were not run. This does not establish mobile, installation, or real sync-service acceptance.
