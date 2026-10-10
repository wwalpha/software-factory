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

Checks run in fresh containers with candidate and protected check files mounted
read-only, network none and no credentials. The guard-side check adapter verifies
check bytes against the registered version first. A protected Node test supervisor
consumes structured test-runner events and requires real named tests; plain stdout
or exit 0 is insufficient. A registered TypeScript compilation check is also
available. These are explicit check types, not an agent-supplied command language.
Fake mode runs trusted local fixtures on the host and provides no hostile-code
isolation.

The complete integrated tree is checked. EvidenceReceipt includes target/input
hashes, check version, environment, time, result and Guard issuer, signed with
Ed25519. Only Guard has the signing key. Sealing requires every mandatory condition
and the delivery boundary. The immutable copy is hashed again, including exact
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

Live isolation and real account bindings remain unverified; see validation.md for
executed checks and missing prerequisites. The implementation fails closed;
readiness is not claimed. macOS Docker
Desktop's VM and Linux Docker have different UID/mount behavior and both require
an operator-run doctor/live test. Docker daemon access, host root, the installed
Guard, its image and operator identities remain trusted. OS/container escape and
host compromise are not eliminated by application code.

Acceptance quality is only as strong as the protected tests/profile. Node test
code and a product loaded in a test child share that child's JavaScript runtime;
this is not a proof against every malicious test-harness subversion. Guard and
signing keys remain outside it. High-risk hostile products should use an
operator-authored external protocol evaluator before granting broader work.

No performance benefit from real GPT is claimed. No production, remote push,
merge, multi-host operation or external-data rollback is implemented or authorized.
