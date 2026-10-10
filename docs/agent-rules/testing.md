# Testing Coding Standards

Apply these rules to tests and validation under [AGENTS.md](../../AGENTS.md) and
[common.md](common.md). COM-07/08 own the general duty to validate and report;
this file defines test design, levels, evidence and existing commands.
Enforcement candidates are not new CI requirements.

## TEST-01: Testing Principles

- **Rule:** Test the behavior and risks introduced by the change.
- **Rationale:** Test count does not establish correctness or useful coverage.
- **Required Practice:** Keep dependencies controllable through existing ports and
  test helpers; reuse relevant cases instead of duplicating them. Write readable
  assertions that demonstrate the changed contract. Non-trivial new behavior needs
  a meaningful test; trivial/documentation changes need only appropriate static or
  document checks. Do not add abstractions solely to make an implementation-shaped
  test convenient.

## TEST-02: Test Levels

- **Rule:** Identify the validation level and actual execution environment.
- **Rationale:** Offline orchestration and real isolation establish different facts.
- **Required Practice:** Use these levels without claiming a dedicated framework
  exists for each:
  - **Static Validation:** Schema freshness, TypeScript, ESLint, Prettier and build.
  - **Unit Test:** Focused invariants and contracts using `node:test` and
    `node:assert/strict`; `tests/contracts.test.ts` also includes harness-based cases,
    so filename alone does not determine level.
  - **Integration Test:** Real storage, processes, IPC, adapters and combined
    services in `tests/*.integration.test.ts`, with controlled/fake model behavior.
  - **End-to-End Test:** Complete development mission flows, including signed delivery,
    in runtime integration cases. `scripts/demo.ts` is an offline demonstration,
    not a separate automated E2E gate or proof of real model behavior.
  - **Live Validation:** `test:docker:checks` exercises real Docker protected-product
    boundaries without model calls; `test:live` exercises a granted live mission
    after doctor checks. Docker-only success does not establish real-provider success.
- **Enforcement:** Use the actual commands in TEST-09 and record prerequisites
  and environment for every claimed level.

## TEST-03: Test Design

- **Rule:** Assert contracts and observable outcomes with controlled dependencies.
- **Rationale:** Tests should survive internal refactoring and expose meaningful failures.
- **Required Practice:** Cover normal, failure and boundary cases relevant to the
  change. Use existing harnesses, fixtures and fake adapters; mock only the external
  behavior the test must control. Give data clear purpose and keep tests independent
  with temporary resources and cleanup. Control clocks, randomness and external
  services where necessary; avoid timing assumptions and shared mutable state.
  Preserve real process/storage integration where those boundaries are the subject
  of the test.
- **Enforcement:** Run relevant `node:test` cases; isolation and cleanup are verified
  through assertions and review rather than a mock-count requirement.

## TEST-04: Regression Prevention

- **Rule:** Preserve existing behavior unless a specification change is authorized.
- **Rationale:** Updating an expectation can conceal a regression rather than fix it.
- **Required Practice:** Add a focused regression case for a bug fix. Do not delete
  tests without explaining obsolete or duplicate coverage. Distinguish intended
  specification changes from broken behavior. Use golden/snapshot comparisons only
  for stable, meaningful artifacts; inspect every changed expectation against the
  contract. Never refresh expected values or alter the specification solely to pass
  a failing test. No dedicated snapshot framework is implied.
- **Enforcement:** Run affected regression tests and review expectation changes.

## TEST-05: Validation Scope

- **Rule:** Choose checks from the change's affected contracts and risks.
- **Rationale:** Scope must cover consequences without repeating unrelated suites.
- **Required Practice:** For a small change, run related static checks/tests; for a
  multi-module change, include affected integrations. For a public contract change,
  check schema freshness, consumers, fixtures and persisted compatibility. For a
  significant state/security change, run the necessary broader regression suite and
  relevant boundary checks. For documents, inspect links, structure, consistency,
  scope and formatting without requiring application tests. Apply COM-07 when deciding
  whether further validation has a concrete reason.
- **Enforcement:** Record the selected checks and uncovered material effects under TEST-07.

## TEST-06: Failure Handling

- **Rule:** Investigate failures before changing code, expectations or test conditions.
- **Rationale:** Blind retries and relaxed assertions can hide defects or environment blocks.
- **Required Practice:** Preserve the failing evidence, identify the cause where
  possible and distinguish code defects from environmental prerequisites. Do not
  rerun unchanged conditions without a specific diagnostic reason. Do not ignore
  failures or change expected values to match broken behavior. Investigate flaky
  tests; any temporary exclusion needs an explicit reason, owner and restoration
  condition and must remain visible in the report. An unexplained failure remains
  unexplained rather than being labeled environmental.
- **Enforcement:** Re-run the affected check after a justified correction; keep
  unresolved failures visible in the validation record.

## TEST-07: Evidence and Reporting

- **Rule:** Use explicit check status and evidence provenance under COM-07/08.
- **Rationale:** A successful fake run or historical result cannot prove current live readiness.
- **Required Practice:** Report each selected check as:
  - **PASS:** It executed and satisfied its success criteria in the stated environment.
  - **FAIL:** It executed and failed those criteria; state known cause and impact.
  - **NOT RUN:** It was not executed; state the scope reason or omission.
  - **BLOCKED:** A prerequisite prevented meaningful execution/completion; identify
    that prerequisite and the affected guarantee.
    Distinguish mock/offline, Docker-only and real-provider evidence. Include the
    command/scope and relevant environment; qualify unknown causes. Agent claims,
    printed PASS and exit zero alone are not protected acceptance. Guard checks require
    executed named tests and valid receipts; failures, skips or todos cannot satisfy
    that acceptance. Historical validation records do not establish a current PASS.
- **Enforcement:** Existing protected-check and Guard regression cases verify
  evidence handling; review ordinary development reports against actual outputs.

## TEST-08: AI-Generated Code Validation

- **Rule:** Apply the same standards to generated and human-written implementations/tests.
- **Rationale:** A generated assertion may repeat the same misunderstanding as the code.
- **Required Practice:** Review generated tests against the specification, including
  failure and boundary cases. Test presence and mock success are not correctness or
  live evidence. For protected acceptance, retain operator-owned expectations and
  the evaluator/product separation in ARCH-07; candidate code or agent output cannot
  set the verdict. Apply TEST-04 to generated snapshot/expectation changes as well.
- **Enforcement:** Use the same scoped checks as TEST-05; no model-specific gate
  or generated-code exception applies.

## TEST-09: Quality Gates

- **Rule:** Use existing package scripts and CI rather than inventing parallel gates.
- **Rationale:** Local validation and automation must agree on what was executed.
- **Required Practice:** Select from the current commands:

  | Purpose                    | Existing command and scope                                                                       |
  | -------------------------- | ------------------------------------------------------------------------------------------------ |
  | Generated contracts        | `npm run schema:check`                                                                           |
  | Type checking              | `npm run typecheck`                                                                              |
  | Lint                       | `npm run lint`                                                                                   |
  | Formatting                 | `npm run format:check` (whole checkout)                                                          |
  | Build                      | `npm run build`                                                                                  |
  | Offline tests/regression   | `npm test` (builds, then all `dist/tests/*.test.js`; includes integration files)                 |
  | Integration subset         | `npm run test:integration` (builds, then `dist/tests/*.integration.test.js`)                     |
  | Docker boundary regression | `npm run test:docker:checks` (requires Docker and the configured pinned worker image)            |
  | Granted live mission       | `npm run test:live` (requires live configuration, operator grant, explicit budget and readiness) |
  | CI aggregate               | `npm run check` (schema, types, lint, formatting, then offline tests including their build)      |

  There is no separate unit-only npm script. After building, use the Node test
  runner on selected compiled files for focused checks. For documents, use installed
  Prettier on the changed Markdown files and inspect local links; no Markdown-specific
  linter is configured. Do not bulk-format unrelated files. CI currently runs
  `npm run check` across its configured Linux/macOS matrix; live commands are separate
  and must not be represented as part of that offline gate. Running `npm test` already
  includes integration cases, so repeating the subset needs a reason.

- **Enforcement:** Existing `.github/workflows/check.yml` and package scripts.
  New lint-rule candidates in these standards require a separate configuration
  change; this document does not activate them.
