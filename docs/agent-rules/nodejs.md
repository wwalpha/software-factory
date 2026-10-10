# Node.js Coding Standards

Apply these rules to Node.js code under the priority and change scope in
[AGENTS.md](../../AGENTS.md) and [common.md](common.md). Module responsibilities
and trust boundaries are defined in [architecture.md](architecture.md).
Enforcement marked as a candidate is not enabled by this document.

## NODE-01: Modern Node.js

- **Rule:** Use the repository's ES module runtime and supported modern APIs.
- **Rationale:** One runtime and module format prevent incompatible execution paths.
- **Required Practice:** Use `import` / `export` and NodeNext-compatible relative
  imports with `.js` extensions in TypeScript source. Apply COM-10 for ES2015+
  syntax, arrow functions, variable declarations and the CommonJS prohibition;
  apply COM-09 for conditional syntax. Do not introduce deprecated APIs or legacy
  compatibility patterns.
- **Exceptions:** Only documented runtime, external API or language requirements
  permitted by COM-10; convenience is not a reason.
- **Enforcement:** Current `npm run typecheck` checks module resolution. Review API
  support against the pinned Node.js version; syntax lint candidates belong to COM-10.

## NODE-02: Asynchronous Programming

- **Rule:** Every asynchronous operation must have an owner and a bounded lifetime.
- **Rationale:** Lost failures, hidden retries and unbounded fan-out make missions
  unreliable and cancellation ineffective.
- **Required Practice:** Use `async` / `await`; await, return or explicitly handle
  every Promise's rejection. Detached work needs an identified lifetime and error
  handler; `void` alone does not handle rejection. Avoid nested callback chains and
  wrapping existing Promises; wrap callback APIs only when no Promise API exists.
  Bound external I/O with a timeout, propagate `AbortSignal` where supported, and
  stop the underlying operation on cancellation. Retries need a finite limit and
  terminal condition. Use existing resource lanes for mission concurrency; do not
  fan out an unbounded collection with `Promise.all`.
- **Enforcement:** Candidate: type-aware `@typescript-eslint/no-floating-promises`.
  Exercise timeout, cancellation and retry limits in relevant tests.

## NODE-03: Error Handling

- **Rule:** Handle errors according to their meaning and preserve their cause.
- **Rationale:** Callers need to distinguish expected operational failures from bugs.
- **Required Practice:** Reuse `FactoryError` codes and provider classification
  where applicable. Catch to recover, translate at a boundary or add useful context;
  omit a catch that only rethrows. Preserve the original error when rethrowing;
  when wrapping with an Error API that supports it, use `cause`. Do not assume every
  existing error constructor accepts Error options. Never swallow a failure or
  replace it with empty data that represents success. Treat cancellation, timeout,
  refusal and uncertain effects according to their existing contracts.
- **Enforcement:** Test observable error classification and propagation. Candidate:
  ESLint `no-useless-catch`; cause preservation also needs review.

## NODE-04: Resource Management

- **Rule:** The code that acquires a resource must arrange its release on every exit.
- **Rationale:** Leaks and incomplete shutdown can leave work running after a mission stops.
- **Required Practice:** Close file handles in `finally` or an equivalent owned
  lifecycle. Finish or destroy streams, clear timers and remove event listeners.
  Reuse `runProcess` for managed child processes and the Docker adapter for isolated
  workers; preserve descendant termination and confirmed container removal.
  Keep synchronous SQLite in its dedicated worker. Avoid blocking the main event
  loop or loading unbounded files into memory; use bounded reads or streaming when
  size requires it.
- **Exceptions:** Bounded synchronous startup or trusted fixture operations may
  remain when their cost and lifecycle are understood.
- **Enforcement:** Extend existing process, persistence or Docker boundary tests
  when changing cleanup behavior; a process exit alone does not prove cleanup.

## NODE-05: Module Design

- **Rule:** Module loading must not create hidden mutable services or lifecycle work.
- **Rationale:** Predictable imports make ownership, shutdown and tests understandable.
- **Required Practice:** Export the intended API and keep implementation details
  private. Do not add mutable process-wide state without an identified owner and
  lifecycle. Start sockets, workers and timers through explicit startup code,
  rather than import side effects. Keep unavoidable bounded initialization, such
  as loading the canonical schema, explicit. Apply ARCH-02/03/08 for responsibility,
  dependency cycles and decisions about wrappers or adapters.
- **Enforcement:** Review import-time behavior. Candidate: a module import smoke
  test for a changed module that must remain free of running services.

## NODE-06: Configuration

- **Rule:** Validate configuration once at its owning boundary using its actual source.
- **Rationale:** Implicit defaults and duplicated configuration can change authority
  or execution behavior between environments.
- **Required Practice:** Reuse `loadSettings`, contract validation and the existing
  configuration files. Validate environment values read at CLI/adapter boundaries,
  including numeric range and required presence. Keep fake/live differences
  explicit. Follow COM-06 for secrets. Respect Node.js `24.21.0` and npm `11.19.0`
  in `package.json` and the runtime files; do not weaken these constraints or assume
  undocumented settings or environment variables exist. Keep private Guard policy
  authoritative as specified in ARCH-07.
- **Enforcement:** Current `npm run typecheck` checks configuration consumers;
  relevant configuration tests must cover rejected input. Version and environment
  checks require checking the actual execution environment.

## NODE-07: Security

- **Rule:** Node.js execution boundaries must reject unsafe input and grant only
  the access required for the operation.
- **Rationale:** Type annotations do not protect filesystem, process or network access.
- **Required Practice:** Validate external data through existing boundary validators.
  Pass executable arguments separately through `runProcess`; never interpolate
  untrusted input into a shell command. Do not use `eval` or dynamic Function
  construction for external input. Reuse `safePath`, scope checks and artifact
  validation for candidate paths; joining a path is not validation. Do not expose
  the inspector to untrusted networks without authenticated, restricted access.
  Minimize filesystem, process and network permissions. Apply COM-03/06 to
  dependencies and secret-safe logging; retain existing redaction helpers.
- **Enforcement:** Existing contract, artifact and process tests cover relevant
  boundaries. Candidates: ESLint `no-eval` and `no-new-func`; injection and path
  containment still require boundary tests.

## NODE-08: Performance

- **Rule:** Optimize demonstrated runtime costs without reducing readability.
- **Rationale:** Speculative optimization adds complexity without a verified benefit.
- **Required Practice:** Measure the affected path before optimizing. Avoid repeated
  I/O; estimate memory use for large inputs and use NODE-04 for bounded processing.
  Use NODE-02 for bounded concurrency. Avoid unnecessary synchronous work on request
  paths. Add a cache only for an observed need, with an owner, size/lifetime bound
  and invalidation policy. Do not trade clear code for micro-optimizations or treat
  fewer lines as a performance or quality target.
- **Enforcement:** Record comparable measurements for a performance claim and
  verify unchanged behavior; no repository benchmark gate is implied.
