# Architecture and trust boundaries

## Canonical data and dependency direction

`contracts/factory.schema.json` is the JSON Schema 2020-12 source for contracts.
`src/domain/contracts.ts` is generated. Ajv2020 uses strict validation without
coercion, unknown-field removal or network schema loading. A bounded provider
schema/prompt includes only the referenced definitions, while returned values are
always checked against the full formal contract. YAML rejects duplicate keys,
unknown tags and all aliases, with byte, node and depth limits.

Domain contains generated data types and pure invariants. Application owns
mission/revision handling, dynamic planning, scheduling and resource lanes. Ports
expose agents, stores and Guard operations without SDK/DB types. Adapters contain
SDKs, Git, process control, protected checks, IPC and SQLite. The Guard owns
operation authorization, signing, evaluation and release decisions. There is one
npm package, no distributed workflow DSL, task broker, vector DB or web service.

## Owners, IPC and authority

`factoryd` alone owns runtime.db. `factory-guard` alone owns guard.db. Each database
has one dedicated worker thread; synchronous SQLite never runs in the main event
loop. Transactions are one worker message and never await external operations.
WAL, foreign keys, a 5000 ms busy timeout and FULL synchronization are configured.
Recognized local filesystems are required; network/FUSE filesystems are rejected.
Owner PID locks refuse a second writer and only clear a stale lock after proving
that its process no longer exists. A newer DB schema is refused rather than
silently downgraded.

Runtime IPC, runtime-to-Guard IPC and private operator IPC use separate random
bearer tokens and newline-delimited JSON over local Unix sockets, with bounded
frames. Socket authentication does not replace the OS boundary. Live startup
requires different nonroot UIDs and private Guard ownership; doctor attempts both
read and write access to Guard storage, policy and protected checks and requires
OS denial. A shared group can connect to Guard's 0660 runtime socket, but must not
be able to replace its parent directory. Operator socket is 0600 in Guard's
private directory. The operator issues grants and explicit retry authorization;
runtime cannot turn `approved: true` into authority.

Live deployment uses separate configuration files for Guard and runtime. The
private Guard file is the policy source. The runtime copy describes its client
connection and contains no signing key, operator token or Codex provider key.
Static installed Guard/evaluator code and the pinned Worker image must also be
operator-controlled. A same-UID fake deployment deliberately fails live doctor.

Grants bind caller, mission/project, revision digest, release, operation list,
paths, expiry and money. Registered operations are snapshot, isolated build,
protected check and seal; no arbitrary host shell is exposed. Narrow read-only
status/artifact operations and restrictive cancellation/rollback are separate.

## Durable state and recovery

The records table uses kind/id/version keys for mission revisions, immutable
plans, attempt state, accepted work, receipts, releases, experiments and ledgers.
WorkItem contracts live in the immutable PlanProposal; their execution states
live in MissionState. State writes and their outbox event commit together with
expected versions. Event identity includes a request digest: repeat deliveries
are deduplicated, changed requests with the same ID are rejected.

Before a Guard effect, its operation identity, request digest and budget
reservation are durable. A completed identical request returns its prior result.
A pending operation after a crash becomes uncertain, not automatically rerun.
Runtime dispatch records allow reconciliation with Guard. If no Guard intent
exists, no registered effect began. If a completed result exists, epoch, base and
actual bytes are checked. If outcome cannot be reconstructed, the mission waits;
confirmed stop plus separate operator authorization is required for a new isolated
Attempt. Attempts use fresh SDK contexts, unique operation IDs, epochs and bounded
leases. SDK thread resume is not a durability mechanism.

The conservative recovery choice can consume budget and require operator rescue
when a Worker result was lost between effect and durable result recording. This
is intentional: it does not infer success or replay an uncertain external effect.
Unknown usage keeps the reserved money charged. Settlement is idempotent; conflicting
second settlement is rejected. Runtime/Guard accounting are separate ledgers for
separate responsibilities, not amounts to sum as one bill.

Task state differs from phase. Waiting always records reason, owner and resume
condition. A failed dependency blocks its dependents while independent tasks can
continue. Workspaces are independent full snapshots; nonoverlapping edits merge
against their common base and overlapping incompatible edits fail. Shared tests
get their own temporary workspace, and Git access is read-only.

The four LLM slots are one coordinator, two work slots, and one review/report
slot. Experiment execution occupies a work slot and Guard allows only one active
experiment. Queues only limit resources; persisted state/operations are the source
of truth. Model APIs have zero SDK retry; repair planning is bounded by mission
attempt, time and money limits. Rate limits/authentication failures become explicit
states rather than multiplied hidden retries.

## Git, Docker and checks

Git snapshots read committed blobs with `cat-file`, preserving binary bytes.
The index and actual tracked bytes must match the committed base. No `git status`,
clean/smudge filter, external diff, hook, checkout, worktree mutation or remote
operation is needed. Untracked and ignored files are excluded. Unsafe paths,
tracked credential paths, symlinks, hardlinks, submodules and special files fail
closed. Worktrees are never called sandboxes.

The real isolation adapter uses one named Docker container per Attempt. It is
nonroot, read-only outside its work directory/tmpfs, drops capabilities, forbids
privilege escalation, and limits CPU, memory, PIDs and time. Network is `none`.
A separate per-attempt Unix socket proxy accepts only Responses POSTs, forces the
configured model, restricts tool types, disables storage, and conservatively caps
requests and estimated spend. Guard retains the real Codex provider credential;
Worker receives only a dummy proxy credential. Timeout/cancel removes the named
container and checks its actual state before accepting files. Host process tests
also verify descendant process-group termination.

Node checks keep the evaluator on the trusted Guard host. Its protected tests,
assertions, expected values and test-event aggregation never import the candidate.
They use `factory:product` to call a named function or read snapshot source data.
A private host broker serves only the trusted test helper; its socket is never
mounted into a product container. Only evaluator output can become a check result.

Every function invocation gets a fresh Product Worker: a separate Docker container
for live checks, or a same-UID child for managed development fixtures. The product
receives one bounded request containing module, export name, arguments and a
correlation ID. Candidate and minimal runtime mounts are read-only. `/factory` is
masked by a private read-only tmpfs so the shared Builder image's installed Guard,
evaluator and SDK files are unavailable. No protected tests, expected values,
Guard tokens/sockets, home or Docker socket are exposed. PID namespaces and
writable directories are separate from the evaluator. Network none, nonroot,
capability/privilege restrictions and CPU/memory/PID limits remain.

Worker FD 3 carries observations; stdout/stderr carry bounded, untrusted logs.
The fixed Docker entry command maps FD 3 onto the attached stdout transport and
ordinary stdout onto stderr. No log is parsed as an observation or verdict. The
broker validates one compact JSON response, schema, correlation, UTF-8, value
types and bounds after worker exit and confirmed container removal. IDs correlate
requests; they do not authenticate product behavior. `passed` inside a returned
business object is ordinary data. Workers may fabricate observations, which the
trusted assertions must still evaluate.

The evaluator requires executed named tests in every declared file, with no
failure, skip or todo. Its loader closes the module graph over the hashed check
snapshot and hashed trusted helper; legacy direct candidate imports are refused.
This is a migration guard, not the hostile-product isolation boundary. Test and
runtime bytes used for version checking are copied once into the execution
snapshot. The operator must keep the installed Guard/broker code immutable.
`checkVersion` includes the evaluator/protocol ID and runtime/helper bytes.

Import, export, call and unsupported-value errors latch a failed check even when
a protected test catches the error. Protocol violations, output limits, timeout,
cancel and stop uncertainty throw, preventing receipt issuance for that run.
Docker creates a named container before attaching, then force-removes it and
queries the daemon to confirm absence. A failed cleanup is `uncertain` and names
the container; an exited Docker CLI is insufficient. Stop uncertainty takes
precedence over a concurrent evaluator cancellation. There is no host fallback.
The explicit-file `tsc` check remains independent and uses TypeScript 6's
`--ignoreConfig` to avoid the caller's working-directory configuration.
Fake host processes are not a malicious-code sandbox.

The complete integrated tree is checked. EvidenceReceipt includes target/input
hashes, check version, environment, time, result and Guard issuer, signed with
Ed25519. Only Guard has the signing key. Sealing requires every registered check
and mandatory condition, exact current input/check version/environment, stored
receipt equality and valid signatures. The immutable copy is hashed again, including exact
bytes and executable bits; later export verifies it again. `factory verify`
checks the completion signature, check signatures and exported bytes against a
public key obtained independently through the operator channel.

## Evolution

Execution state records failures, retries, waits and charged/unknown usage. Failure
analysis reports facts, hypotheses and unknowns; the initial automatic hypothesis
uses cause `unknown` rather than pretending causality has been established.
Experiments freeze criteria and suite digest before an Improver candidate exists.
Only Builder prompt changes are auto-promotable. Recipe profile, capabilities,
scope and budget remain identical. Guard/evaluator/policy changes have no automatic
promotion route. Human-reviewed core deployment is a separate operation.

Guard independently runs baseline and candidate on registered development and
separate repositories with protected checks. Candidate code cannot edit the
read-only check suite. The examples are public; separation is not a claim of
unseen/private data. Quality is the fraction of cases that pass, retry count is
automatic repair attempts, and rescue count means cases still requiring operator
intervention after the trial cap. Actual human minutes are not inferred from
these counts and are not yet demonstrated as improved. Duration is measured;
cost is measured or unknown. Unknown/equal evidence yields hold; regression or a
fixed threshold miss yields rejection.

Trial and money limits share a candidate lineage; a new experiment ID cannot
reset them or relax the frozen criteria. Successful candidates become scoped
canaries for future missions only. Two verified subsequent missions stabilize a
canary. Follow-up quality/intervention thresholds can revoke it. Rollback freezes
new operations from the revoked release and records stop/reconciliation of
in-flight work, without pretending to undo product or external data.

## Residual risks and limits

The product Docker product boundary has an executed no-model regression suite; see
validation.md. Full live deployment and real account bindings remain unverified;
readiness is not claimed. macOS Docker
Desktop's VM and Linux Docker have different UID/mount behavior and both require
an operator-run doctor/live test. Docker daemon access, host root, the installed
Guard, its image and operator identities remain trusted. OS/container escape and
host compromise are not eliminated by application code.

Acceptance quality is only as strong as the operator-owned protected tests/profile.
Calls support finite JSON data, named functions and one fresh module session per
invocation; cross-call state and arbitrary property chains are unsupported. This
does not establish complete program correctness, unseen-input generalization,
freedom from hardcoded outputs, or resistance to OS/container escape. The product
can lie on its observation channel; it cannot write the evaluator verdict channel
within the defined Docker boundary and regression cases.

No performance benefit from real GPT is claimed. No production, remote push,
merge, multi-host operation or external-data rollback is implemented or authorized.
