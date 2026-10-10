# Architecture Coding Standards

Apply these rules to responsibility, dependency, state and authority changes under
[AGENTS.md](../../AGENTS.md) and [common.md](common.md). The existing
[architecture and trust boundaries](../architecture.md) describe the design;
these rules govern changes to it. Enforcement candidates are not newly installed checks.

## ARCH-01: Architecture Preservation

- **Rule:** Preserve the documented architecture unless the task authorizes its change.
- **Rationale:** Local changes must not silently redefine responsibility or authority.
- **Required Practice:** Check the relevant design section against actual code before
  changing a boundary. Retain the single-package design and existing owners. If
  documentation and implementation disagree, identify the discrepancy rather than
  treating either as permission to redesign. Apply COM-02/04 before adopting a new
  pattern; an authorized design change must update affected documentation and callers.

## ARCH-02: Responsibility Separation

- **Rule:** Extend the component that owns the responsibility.
- **Rationale:** Multiple owners make behavior and security decisions inconsistent.
- **Required Practice:** Domain owns generated types and pure invariants;
  application owns mission/revision execution, scheduling and lanes; ports describe
  service contracts; adapters own SDK, Git, process, IPC, checks and storage
  integrations; Guard owns authorization, signed evidence, evaluation and release
  decisions; CLI code composes services and handles command input. Inspect the
  existing owner before extending behavior. Apply COM-03/04 to avoid duplicate
  logic, needless intermediate layers or accumulating unrelated duties in one service.
- **Enforcement:** Review changed responsibilities against these owners; no
  architectural lint gate is currently configured.

## ARCH-03: Dependency Direction

- **Rule:** Preserve existing dependency direction and prohibit circular dependencies.
- **Rationale:** Stable contracts keep external execution details out of core invariants.
- **Required Practice:** Keep domain invariants independent of application, Guard
  and adapters. Ports use domain/local contract types, not SDK or database types.
  Adapters implement the ports; CLI entry points compose concrete services.
  Application uses ports for agent, persistence and Guard effects. Existing
  application imports of contract, artifact, logging and provider-classification
  helpers are part of the current implementation, not evidence of a strictly
  enforced ports-only layer. Do not broaden concrete service coupling or reach
  into private implementation state. Apply dependency inversion only to a demonstrated
  boundary; do not add speculative interfaces or unnecessary dependencies.
- **Enforcement:** Current `npm run typecheck` checks imported APIs. Candidate:
  import-graph cycle/boundary checks; type checking alone does not detect cycles.

## ARCH-04: Contracts

- **Rule:** Change contracts at their canonical source and validate their consumers.
- **Rationale:** Generated types and runtime validation must describe the same data.
- **Required Practice:** `contracts/factory.schema.json` owns schema-backed contracts;
  `src/domain/contracts.ts` is generated and must not be hand-edited. Regenerate
  using `npm run schema:generate` when the schema changes. Ports own their service
  interfaces; database migrations own persisted schema changes. Reuse the current
  Ajv contract validator and domain invariants at external boundaries; preserve
  strict validation without coercion or unknown-field removal. Check IPC, adapters,
  consumers, fixtures and persisted-data compatibility when changing a contract.
  Do not resolve interface mismatches through casts or duplicate definitions.
- **Enforcement:** Current `npm run schema:check`, `npm run typecheck`, contract
  tests and affected integration tests.

## ARCH-05: State Management

- **Rule:** State must have an explicit owner and recoverable transition semantics.
- **Rationale:** Process memory and repeated requests cannot establish durable completion.
- **Required Practice:** `factoryd` owns `runtime.db`; `factory-guard` owns `guard.db`,
  each through its dedicated SQLite worker. Keep state/event writes atomic with
  expected versions; do not await external effects inside database transactions.
  Immutable plans own WorkItem contracts; MissionState owns execution state.
  Treat queues/controllers as transient coordination, not persisted truth. Preserve
  operation identity, request digests, reservations and idempotent settlement;
  reject conflicting repeated requests. Record waiting reason, owner and resume
  condition. An uncertain effect must be reconciled, not automatically replayed;
  preserve stop confirmation, operator retry authorization, epoch and base fencing.
  Use NODE-05 for restrictions on process-wide mutable state.
- **Enforcement:** Extend persistence, recovery and crash tests for changed transitions.

## ARCH-06: Agent Orchestration

- **Rule:** Orchestration must use bounded roles and explicit handoff contracts.
- **Rationale:** Independent responsibilities and durable handoffs prevent agent claims
  from becoming authority.
- **Required Practice:** `PlanningPort` drafts/plans and produces role reports or
  improvement proposals; it does not authorize effects. `RunnerPort` executes an
  Attempt and returns a RunnerFact/candidate tree. `CheckPort` runs protected checks;
  Guard authorizes operations and issues evidence. Keep these responsibilities
  separate and avoid new direct dependencies between roles. Use validated plans,
  dependency DAGs and existing lanes (one coordinator, two work slots, one review
  slot); do not create unbounded agents or parallel attempts. Runtime owns scheduling
  and bounded repair planning; adapters own timeout/cancellation of their operations;
  Guard owns effect authorization and reconciliation. Keep provider SDK retries
  disabled as currently configured; do not layer hidden retries onto runtime repair.
  Follow ARCH-05 for stop/resume consistency and validate every role's output contract.
- **Enforcement:** Existing lane, runtime, Guard and evolution tests cover relevant
  limits and handoffs; extend them when these behaviors change.

## ARCH-07: Security Boundaries

- **Rule:** COM-06's authority boundaries must remain fail-closed in actual execution.
- **Rationale:** An approval field, agent report or process exit is not authorization
  or trusted acceptance evidence.
- **Required Practice:** Keep private Guard policy, signing keys, operator authority
  and protected checks outside runtime/candidate control. Preserve grant scope,
  expiry and operation checks; do not bypass approval or elevate permissions without
  authorization. Live execution requires the existing doctor gates, separate OS
  identities and Docker isolation; never substitute a host worker when isolation
  fails. Worktrees and same-UID fake processes are not sandboxes. Preserve the
  evaluator/product boundary and keep external tool execution in authorized adapters.
  Only Guard-signed receipts matching exact inputs, check versions and environment
  can support sealing. Factory delivers a signed source tree; it does not deploy,
  merge or push products.
- **Enforcement:** Relevant Guard, protected-check and Docker boundary tests;
  live identity/isolation claims require actual live validation under TEST-02/07.

## ARCH-08: Extensibility

- **Rule:** Use demonstrated extension points rather than speculative architecture.
- **Rationale:** An extra plugin or compatibility layer becomes another contract to maintain.
- **Required Practice:** Extend current ports, adapters, schemas, profiles or role
  recipes only where the requirement belongs. Apply COM-03/04 before adding a plugin,
  adapter or abstraction; do not create parallel extension frameworks or compatibility
  layers without an actual consumer requirement. Recipe improvement must retain the
  existing bounded Builder-prompt promotion path; Guard/evaluator/policy changes
  have no automatic promotion route.
- **Enforcement:** Relevant contract/evolution tests when extension behavior changes.

## ARCH-09: Architecture Changes

- **Rule:** Assess architectural impact in proportion to the change.
- **Rationale:** Explicit decisions prevent accidental redesign without adding ceremony
  to a local edit.
- **Required Practice:** Before changing a boundary, determine whether existing
  functionality suffices, whether a new abstraction is necessary, whether dependency
  direction remains valid, whether state ownership duplicates, whether security
  boundaries hold, what side effects affect callers/data, and how to verify the
  benefit. Record material decisions in the existing architecture documentation
  when an architectural change is authorized. A small change within existing
  boundaries does not require a separate design process or new document.
- **Enforcement:** Verify the identified effects through TEST-05's scoped checks;
  review is required for the design decision itself.
