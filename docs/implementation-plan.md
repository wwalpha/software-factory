# Initial implementation — 2026-10-10

The repository initially contained only `.gitignore`; no referenced designs,
AGENTS.md, package, task/worktree/check implementation or Python code was present.
Work is on `codex/software-factory-v1`; no push, merge or production operation.

1. Pin verified Node 24, dependencies and SDK/CLI; inspect their actual APIs.
2. Author schemas, generated types, semantic checks, SQLite worker transactions,
   separate Guard storage, authenticated narrow operations and signed evidence.
3. Run a dynamic fake mission through real Git, SQLite and protected checks;
   test crashes, duplication, leases, budgets, cancellation and integration failure.
4. Connect Responses and Codex SDK to the ports; implement constrained Docker
   execution and fail-closed doctor/live gates. No automatic Docker installation.
5. Implement fixed experiments, isolated candidate recipes, independent evaluation,
   scoped future-only adoption, follow-up observation and rollback.
6. Complete CLI, two example products, cross-process tests, no-Python container
   test, CI and documentation; record executed versus blocked validation honestly.

Scope includes all new contracts, runtime/guard entry points, adapters, scripts,
config, tests, examples and docs. There are no existing callers to migrate.
