# AGENTS.md

This is the shared entry point for AI coding agents, including Codex and Copilot,
working in this repository. It applies across the repository and is independent
of any particular AI model.

## Project Overview

Software Factory plans and executes development missions with independent
acceptance checks, durable recovery, a separate Guard, and a bounded recipe
improvement loop. It delivers a signed, sealed source tree; it does not deploy,
merge, or push products.

The project is a single Node.js/TypeScript ESM package. `package.json` pins Node.js
24.21.0 and npm 11.19.0. It uses OpenAI Responses and Codex SDK adapters, JSON Schema
with Ajv validation, SQLite persistence, Git snapshots, and Docker workers for live
isolation. ESLint, Prettier, and the Node.js test runner provide development checks.

Repository layout:

| Path                     | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `src/domain/`            | Contract types and pure invariants; `contracts.ts` is generated.            |
| `src/application/`       | Mission runtime, scheduling, resource lanes, and readiness checks.          |
| `src/ports/`             | Agent, persistence, and Guard interfaces.                                   |
| `src/adapters/`          | SDK, Git, process, IPC, persistence, check, and artifact integrations.      |
| `src/guard/`             | Authorization, signed evidence, evaluation, and release decisions.          |
| `src/cli/`               | Entry points for `factory`, `factoryd`, and `factory-guard`.                |
| `contracts/`             | Canonical JSON Schema for Factory contracts.                                |
| `migrations/`            | SQLite schema migrations.                                                   |
| `config/`                | Role recipes, example model/deployment settings, and the worker Dockerfile. |
| `scripts/`               | Schema generation, demos, dependency inspection, and validation utilities.  |
| `tests/` and `examples/` | Automated tests, fixtures, and repair/refactoring examples.                 |
| `docs/`                  | Architecture, dependencies, validation records, and implementation history. |

Start with [README.md](README.md) for setup, commands, and operating boundaries.
Consult [architecture](docs/architecture.md) for responsibilities and trust
boundaries, [dependencies](docs/dependencies.md) for runtime/dependency details,
[validation](docs/validation.md) for recorded checks and limitations, and
[implementation history](docs/implementation-plan.md) for initial implementation
context. Recorded results do not establish that the current checkout has passed.

## Agent Working Principles

1. Read the relevant existing code and documentation before changing anything.
2. Understand the existing functionality, design, and implementation, including
   affected callers and tests.
3. Reuse existing functionality and patterns; avoid duplicate implementations.
4. Stay within the requested scope and preserve unrelated work already present.
5. Consider compatibility with existing behavior, interfaces, and persisted data.
6. Run validation relevant to the change after implementing it.
7. Do not report unexecuted, failed, or blocked validation as successful. Separate
   agent claims from verified evidence and offline checks from live validation.
8. Report changed files, behavior changes, validation results, and remaining risks
   or unverified items.

## Rules Organization

Keep this entry point concise. The
[common development rules](docs/agent-rules/common.md) apply repository-wide.
Detailed coding rules are organized under `docs/agent-rules/`:

| File                                                | Responsibility                            |
| --------------------------------------------------- | ----------------------------------------- |
| [common.md](docs/agent-rules/common.md)             | Common development principles.            |
| [nodejs.md](docs/agent-rules/nodejs.md)             | Node.js development conventions.          |
| [typescript.md](docs/agent-rules/typescript.md)     | TypeScript development conventions.       |
| [architecture.md](docs/agent-rules/architecture.md) | Architecture and module dependency rules. |
| [testing.md](docs/agent-rules/testing.md)           | Testing and validation rules.             |

Follow the applicable linked rules: Node.js rules govern runtime code, TypeScript
rules govern typed code, architecture rules govern module and trust boundaries,
and testing rules govern tests and validation. Keep detailed rules in these files.

## Agent Execution Workflow

For all implementation and modification work in this repository, whether working
alone or in parallel, read and use the [worktree skill](skills/worktree/SKILL.md)
before editing. It is also exposed at `.agents/skills/worktree`. Develop and commit
only inside the assigned worktree, using the helper's task usage lock; local
master integration is serialized by the helper. A request to use the current
working tree as the source baseline does not authorize editing the primary or
master checkout directly. This lifecycle is separate from Factory mission execution.

Understand → Inspect → Plan → Implement → Validate → Report

1. **Understand:** Identify the requested outcome, scope, and constraints.
2. **Inspect:** Read relevant code, configuration, documentation, and tests.
3. **Plan:** Choose the smallest complete change and suitable validation. Keep
   small tasks lightweight; a separate written plan is not required for them.
4. **Implement:** Make the scoped change using the existing design and patterns.
5. **Validate:** Run relevant checks from `package.json`, such as `typecheck`,
   `lint`, `format:check`, `test`, or `check`, as appropriate to the change. Record
   failures, environmental blocks, and checks not run.
6. **Report:** Explain the result, validation evidence, and remaining risks.

For investigation-only or design-only requests, do not enter Implement. Validate
the findings or design against available evidence and report without changing
files unless explicitly requested.

## Rule Priority

Apply repository guidance in this order, highest priority first:

1. The user's explicit instructions.
2. This AGENTS.md.
3. Applicable detailed rules for the target area, once those files exist.
4. Existing code conventions and practices.

Do not apply a lower-priority rule that conflicts with a higher-priority
instruction. Detailed rules refine this entry point without overriding it.
