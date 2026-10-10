# Dependencies (verified 2026-10-10)

Node **24.21.0 LTS**, npm **11.19.0**. Downloaded the official macOS arm64 binary and checked SHA-256 against the official SHASUMS256.txt. Latest 24.x returned by the official release index during implementation was 24.21.0; it includes the earlier 24.18.1 security release. This is an implementation-time observation, not a promise about future security updates.

node:sqlite in this Node release is **Stability 1.2 — Release candidate**, not stable. It is confined to PersistencePort's worker adapter. Each owner has one synchronous DB worker, WAL, foreign keys, busy timeout and FULL synchronization.

| Direct dependency         | Exact version | License    | Install lifecycle | Implementation                              |
| ------------------------- | ------------- | ---------- | ----------------- | ------------------------------------------- |
| @openai/codex             | 0.162.0       | Apache-2.0 | none              | official prebuilt Rust CLI, no source build |
| @openai/codex-sdk         | 0.162.0       | Apache-2.0 | none              | JavaScript/types                            |
| ajv                       | 8.20.0        | MIT        | none              | JavaScript/types                            |
| ajv-formats               | 3.0.1         | MIT        | none              | JavaScript/types                            |
| commander                 | 15.0.0        | MIT        | none              | JavaScript/types                            |
| openai                    | 7.31.0        | Apache-2.0 | none              | JavaScript/types                            |
| pino                      | 10.4.0        | MIT        | none              | JavaScript/types                            |
| yaml                      | 2.9.1         | ISC        | none              | JavaScript/types                            |
| @eslint/js                | 10.0.1        | MIT        | none              | JavaScript/types                            |
| @types/node               | 24.19.1       | MIT        | none              | JavaScript/types                            |
| eslint                    | 10.12.0       | MIT        | none              | JavaScript/types                            |
| json-schema-to-typescript | 16.0.0        | MIT        | none              | JavaScript/types                            |
| prettier                  | 3.9.9         | MIT        | none              | JavaScript/types                            |
| typescript                | 6.0.3         | Apache-2.0 | none              | JavaScript/types                            |
| typescript-eslint         | 8.71.1        | MIT        | none              | JavaScript/types                            |

All direct versions were read from npm and installed normally; npm generated package-lock.json. Codex SDK 0.162.0 depends on CLI 0.162.0; the same CLI is explicitly pinned. The platform optional packages contain official prebuilt binaries for macOS arm64 and Linux x64/arm64. No source-build fallback is configured. No install-script suppression is used.

Lockfile packages reporting install scripts: **0**. None.

Selection: openai supplies Responses, codex-sdk drives the official CLI, Ajv 2020 + ajv-formats validate the canonical contracts, commander exposes CLI, yaml parses bounded profiles, pino writes operational logs to stderr. TypeScript and Node types support strict NodeNext builds; json-schema-to-typescript generates interfaces; ESLint/typescript-eslint and Prettier check code quality. Test, crypto, SQLite, process management, workers and IPC use Node standard modules.

Constraints: node:sqlite remains RC; no network filesystems. Native Codex executable availability is checked at runtime. Execution status belongs to docs/validation.md.

Official sources: [Node release index](https://nodejs.org/dist/index.json), [Node 24.21.0 SQLite](https://nodejs.org/download/release/v24.21.0/docs/api/sqlite.html), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Installed SDK declarations are authoritative for this pinned implementation. Responses JSON mode plus independent full Ajv validation avoids weakening contracts to fit a provider schema subset.
