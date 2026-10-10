# Software Factory 0.1

A Node.js/TypeScript development Factory with dynamic mission planning, independent
acceptance checks, durable recovery, a separate Guard, and a bounded recipe
improvement loop. It produces a signed, sealed source tree. It does not deploy,
merge or push products.

**Implemented is distinct from live-validated.** Offline missions and fault tests
run without credentials. Real Responses/Codex and Docker adapters are implemented;
live work is refused until independent OS identities, Docker isolation, verified
model bindings, credentials, grants and budgets pass the gates. See
[validation](docs/validation.md) for the actual results and blocks.

## Setup

Use the official **Node 24.21.0** prebuilt distribution for macOS arm64 or Linux
x64/arm64, with its bundled **npm 11.19.0**. Verify the archive against the official
[checksums](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt). Git must be installed.
Windows and multi-host execution are outside this release.

```sh
node --version
npm --version
npm ci
npm run schema:generate
npm run build
npm test
npm run check
```

On this checkout the verified macOS arm64 binary is also available in ignored
`.local/node-v24.21.0-darwin-arm64/bin`; prepend that directory to PATH to use the
same runtime without changing the system installation.

`check` runs schema, type, lint, formatting and offline tests without Docker or
model credentials. `npm ci` uses normal lifecycle behavior. All direct dependencies are
exact versions and transitive packages are locked. Versions, licenses, install
scripts and the RC status of `node:sqlite` are in
[dependencies](docs/dependencies.md).

Executables are declared as `factory`, `factoryd` and `factory-guard` in the
package. The examples below invoke their built entry points directly, requiring
no global installation.

## Offline example with real storage and processes

```sh
node dist/scripts/demo.js
```

The demo creates two temporary Git repositories: a TypeScript bounds bug and a
name-normalization refactoring. It starts separate Guard/runtime processes,
submits natural-language requirements, uses the operator channel to grant their
fixed authority, runs both missions, evaluates a changed Builder recipe, and
rolls back a canary if adopted. The final JSON gives the retained configuration,
result file and artifact digests. Processes stop when the demo finishes.

Fake planning and editing are **explicit deterministic test doubles**. SQLite,
Git, IPC, protected checks, signatures, revision validation, integration, budgets,
evaluation decisions and rollback are real. Fake uses trusted local example
checks on the host; it is not an isolation boundary or evidence of GPT improvement.

The returned configuration can be reused in three terminals:

```sh
node dist/src/cli/guard.js --config /absolute/path/config.json start
node dist/src/cli/factoryd.js --config /absolute/path/config.json
node dist/src/cli/factory.js --config /absolute/path/config.json doctor
```

`doctor` reports eligibility for **live** execution. A fake configuration reports
BLOCKED for that purpose even though offline missions can run.

## Submit, authorize, run, resume and retrieve

A ProjectProfile supplies repository, allowed paths, protected acceptance checks,
delegation, budget and product category. Humans provide requirements and
acceptance, not a task list or model assignments. The demo writes ready-to-use
`repair-profile.json`, `repair-requirements.txt` and mission files next to its
configuration.

```sh
node dist/src/cli/factory.js --config /absolute/runtime-config.json submit \
  --requirements /absolute/requirements.txt --project /absolute/profile.json > mission.json

# Operator identity and private operator configuration:
node dist/src/cli/guard.js --config /absolute/guard-config.json grant --mission mission.json

node dist/src/cli/factory.js --config /absolute/runtime-config.json run MISSION_ID --mode fake
node dist/src/cli/factory.js --config /absolute/runtime-config.json status MISSION_ID --json
node dist/src/cli/factory.js --config /absolute/runtime-config.json resume MISSION_ID --mode fake
node dist/src/cli/factory.js --config /absolute/runtime-config.json cancel MISSION_ID
node dist/src/cli/factory.js --config /absolute/runtime-config.json result MISSION_ID \
  --output /absolute/new-empty-delivery-directory > result.json
```

`--mode live` is always explicit and must match the runtime. There is no live-to-fake
fallback. A missing grant, exhausted budget, expired authentication or uncertain
operation becomes waiting with a reason, owner and resume condition. Independent
work can continue around a blocked item.

For planned non-Builder work, explicit `resume` retries only classified retryable
failures after the existing authorization and budget checks. Ordinary `run` and
startup recovery do not automatically retry those failures. Saved RoleReports are
reused. Unknown outcomes and missing legacy histories require inspection, a human
mission revision and its matching operator grant; `authorize-retry` below remains
a Builder operation command. See [P1-B behavior and validation](docs/validation-p1-b.md).

Successful planned role reports now reach dependent Builders and roles through
transitive plan dependencies, with Runtime-owned provenance and explicit historical
snapshot labels. Saved final failure diagnoses reach replanning after restart.
These reports remain untrusted data; input-size overflow stops visibly rather than
silently omitting required reports. See [P1-C contracts and measurements](docs/validation-p1-c.md).

After a crash, the daemon reconciles running missions against Guard records.
Heartbeat expiry alone cannot replace a worker. An uncertain isolated build
requires confirmed stop and a separate operator action before a fresh Attempt:

```sh
node dist/src/cli/guard.js --config /absolute/guard-config.json authorize-retry OPERATION_ID
node dist/src/cli/factory.js --config /absolute/runtime-config.json resume MISSION_ID --mode live
```

For material ambiguity, `factory revise MISSION_ID --requirements clarification.txt`
creates a new immutable MissionRevision with preserved scope/acceptance. Stop old
attempts first, then issue a grant for the new revision. Accepted plans also have
immutable revisions; planning may split, merge, add, retire or reorder work.

## Live setup and authentication

Start from [deployment.example.yaml](config/deployment.example.yaml). It is
intentionally disabled, with model IDs and image references requiring actual
operator values. No model availability is inferred from a display name.

Provision two different nonroot OS users. Keep `guardRoot`, its signing key,
database, protected test directories and **Guard's own configuration** private to
the Guard user. Runtime uses a separate configuration copy. The Guard IPC directory
is owned by Guard; a narrowly shared OS group can traverse it and connect to the
0660 socket. Runtime must not be able to replace the socket. Operator IPC remains
inside the private Guard directory and uses a separate token. Token files contain
at least 32 random characters; put no token contents in configuration, prompts or
source control. Protect the installed Guard code and image from runtime writes.

Build the Worker image from the committed sources and record the actual image ID:

```sh
docker build -f config/Dockerfile.worker -t software-factory-worker:local .
docker image inspect software-factory-worker:local --format '{{.Id}}'
```

Set `workerImage` to that actual `sha256:...` ID. Docker is never auto-installed.
The Guard user needs deliberate Docker access; the runtime and Workers must have
none. Rootless Docker or a dedicated development host is preferable to a shared
privileged daemon. Docker daemon administration is a trusted operator capability.

Provide `OPENAI_API_KEY` only to the runtime (Responses API billing), and a separate
`CODEX_PROVIDER_API_KEY` to Guard (Codex provider calls). This initial adapter uses
API-key-based Codex authentication through its constrained proxy, not a copied
ChatGPT login. ChatGPT/Codex subscription limits are not treated as API credit.
Fill exact model IDs and verified prices before enabling bindings.

An explicit operator connectivity probe uses the actual Responses SDK and actual
Codex-in-Docker adapter, then writes `enabled` and `verifiedAt` only on success:

```sh
FACTORY_CONFIG=/absolute/guard-config.json FACTORY_PROBE_MAX_USD=0.40 \
  node dist/scripts/verify-bindings.js
```

This probe needs both dedicated credentials in that operator session; the runtime
must not inherit the Codex credential. Copy only the verified nonsecret model
bindings to the runtime configuration. Preserve the separate private policy file.
The conservative call reservation is $0.10 for structured roles and $0.20 for the
initial Builder recipe; requests that exceed these bounds are refused before API
calls. Set output limits/pricing consistently. Unknown usage consumes the reserved
amount and is reported as unknown, never as zero.

Start Guard, run `factory doctor` from the runtime identity, then start `factoryd`.
Live startup requires OS access denial to Guard secrets/policy/checks, distinct
UIDs, nonroot execution, a pinned image and an actual Docker isolation probe.
Workers use network `none`; only a per-attempt Unix socket to a bounded,
Guard-owned Responses proxy is mounted. No Docker socket, home, shared `.git`,
Guard data, provider keys or host environment is given to a Worker.

```sh
FACTORY_CONFIG=/absolute/runtime-config.json \
FACTORY_LIVE_MISSION=OPERATOR_GRANTED_MISSION_ID FACTORY_LIVE_BUDGET_USD=10 \
  npm run test:live
```

This test returns BLOCKED when prerequisites are missing. It never silently runs
Fake. The local validation report states whether it actually ran.

## Evidence and delivery

Builder's AgentClaim, the runner's observed facts, and Guard's EvidenceReceipt are
separate. Protected check code runs against the entire integrated candidate. An
exit status or Agent PASS alone cannot complete a mission. Guard signs check
version, input/candidate digests, environment, timestamp, issuer and result.

The entire tree includes exact file bytes and executable bits in its digest.
Scope escapes, links, special files, `.git` modifications and base/epoch mismatches
are rejected. Any tree change requires full revalidation. Delivery verifies the
same sealed bytes again. No checkout is overwritten automatically.

Export the Guard public key through the operator channel, then independently
check an exported artifact:

```sh
node dist/src/cli/guard.js --config /absolute/guard-config.json public-key --output guard-public.pem
node dist/src/cli/factory.js verify result.json \
  --public-key guard-public.pem --artifact /absolute/delivery-directory
```

Stdout contains result JSON; Pino operational logs go to stderr. No chain of
thought, aggregate Codex command logs or environment dumps are persisted.

## Protected test migration (1010v1)

Product code runs separately from the evaluator. Keep ordinary `node:test` and
trusted assertions, replacing candidate imports with the registered helper:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { callProduct, readProductSource } from 'factory:product';

test('public function contract', async () => {
  assert.equal(await callProduct('module.ts', 'namedFunction', [7]), 14);
  assert.ok((await readProductSource('module.ts')).includes('namedFunction'));
});
```

The example is an API illustration; operators supply the actual acceptance.
`readProductSource` reads the same immutable candidate snapshot as data on the
trusted side. The product never supplies its own structural inspection result.
Only declared, hashed check files and the installed trusted helper can be loaded.
Legacy direct imports, undeclared helpers and OS-capable test imports are refused;
use the helper for calls/source reads. Pure Node test/assert/path/url/util/buffer/
timer builtins remain available. Never evaluate candidate source in a test.

A call invokes a candidate-relative module's **own named function export** once;
the export name must be an ASCII JavaScript identifier.
Absolute/traversal/URL paths, links and property chains are refused. Each call is a
fresh session; module state lasts only through that invocation, then the Worker
is discarded. There is no state reuse across calls or checks. Async results must
settle within 10 seconds. Cross-call state and arbitrary object/exception transport
are outside this API.

Values are lossless UTF-8 JSON data: null, booleans, finite numbers (excluding
negative zero), strings, dense arrays and plain records, to depth 32. Undefined,
NaN, infinities, bigint, symbols, sparse/decorated arrays, accessors, class instances
and cycles are explicitly rejected. Each request/response is at most 64 KiB;
combined product logs/response have the same byte limit. A check allows at most
128 observations (including source reads), serializes product calls and has the
existing 45-second test / 60-second evaluator limit. Exactly one compact JSON
message with matching protocol/ID is required; duplicate/missing/other-ID frames
and invalid UTF-8 fail closed. IDs are correlation, not authenticity. A returned
`{ passed: true }` is ordinary business data; only trusted assertions decide PASS.

Existing profile versions and old PASS receipts cannot authorize new checks or
seals. The public CheckPort, CheckSpec and Receipt/signature schemas are unchanged;
`checkVersion` now binds the method and trusted runtime/helper bytes for both
check kinds. Historical artifacts can still be verified with their public key.

Operator migration is explicit:

1. Protect the installed Guard/runtime and check directory from runtime writes.
   Rebuild with the pinned Node/npm, then migrate and review every protected test,
   preserving its acceptance and structural checks. Keep `tsc` as its own check.
2. Generate a **new** profile file from the reviewed checks; do not rewrite an
   expected version automatically after a failed verification:

   ```sh
   node --input-type=module - /absolute/reviewed-profile.json /absolute/profile-checked.json <<'JS'
   import { readFile, writeFile } from 'node:fs/promises';
   import { checkVersion } from './dist/src/adapters/checks.js';
   const [input, output] = process.argv.slice(2);
   const profile = JSON.parse(await readFile(input, 'utf8'));
   for (const check of profile.checks)
     check.version = await checkVersion(profile.checkRoot, check);
   await writeFile(output, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
   JS
   ```

3. Review the resulting versions, register that profile through the existing
   operator-owned Guard/runtime configuration procedure and restart the services.
   Issue a fresh mission/grant and rerun all checks. Old operation IDs are
   historical/idempotent retrieval, not evidence for a new seal.

No compatibility import fallback exists. Fake uses only managed host fixtures and
must never execute arbitrary hostile products. For the no-model Docker regression:

```sh
docker build -f config/Dockerfile.worker -t software-factory-worker:local .
PRODUCT_CHECK_IMAGE="$(docker image inspect software-factory-worker:local --format '{{.Id}}')" \
  npm run test:docker:checks
node dist/scripts/check-boundary-probe.js # managed host fixtures; three samples per case
# Set PRODUCT_CHECK_IMAGE to the pinned ID for the Docker benchmark instead.
```

A missing Docker/image or unconfirmed removal refuses success and never runs the
product on the host. An `uncertain` cleanup identifies `factory-product-*` or
`factory-check-*`; an operator must inspect/force-remove it and confirm absence
before permitting further work. Do not treat `docker` CLI exit as stop proof.
Fresh workers add startup/communication cost; see [measured results](docs/validation.md).
This change prevents the defined judge-interference cases; it does not prove
complete correctness, prevent hardcoded responses or establish container escape
resistance. Live eligibility still requires the separate deployment gates.

## Builder Worker stdin regression (no model billing)

Build the production Worker, then a **test-only** image replacing its Codex model
adapter. Do not configure Guard/live execution with this fixture image.

```sh
docker build -f config/Dockerfile.worker -t software-factory-p1d-worker:local .
docker build --build-arg WORKER_IMAGE=software-factory-p1d-worker:local \
  -f tests/fixtures/Dockerfile.worker-input -t software-factory-p1d-fixture:local .
WORKER_INPUT_IMAGE="$(docker image inspect software-factory-p1d-fixture:local --format '{{.Id}}')" \
  npm run test:docker:stdin
```

No API key or external model call is needed. The production DockerRunner,
process input/EOF handling and codex-worker input parser/validator run unchanged;
only the model adapter in the fixture image is replaced. The regression takes
about two minutes because it exercises the real 110-second Worker input deadline
and 120-second Runner timeout, including container removal confirmation.
Missing Docker/image fails explicitly, with no host/Fake fallback.

Builder JSON envelopes have a **1 MiB byte limit** (including JSON escapes and
attempt/recipe/binding overhead). Byte chunks are joined before strict UTF-8
decoding; existing contracts validate each field before model startup. The
existing Worker deadline now includes input waiting. No persisted schema changed.
See [P1-D results and boundaries](docs/validation-p1-d.md). This does not establish
real Codex/GPT success, live eligibility or completion of P0.

## Improvement, observation and rollback

```sh
node dist/src/cli/factory.js --config /absolute/runtime-config.json experiment create MISSION_ID
node dist/src/cli/factory.js --config /absolute/runtime-config.json experiment run EXPERIMENT_ID --mode fake
node dist/src/cli/factory.js --config /absolute/runtime-config.json release status
node dist/src/cli/factory.js --config /absolute/runtime-config.json release rollback RELEASE_ID
```

The experiment is fixed before candidate creation: hypothesis, evidence, cause
layer, suite digest, scope, quality/intervention/retry/cost/time limits, trial cap
and rollback criteria. Cause is `unknown` unless evidence establishes more. The
Improver changes real Builder recipe prompt text, with a new release manifest and
prompt digest. That prompt is used by later applicable missions.

The initial automatic change type is **Builder prompt only**. Capabilities,
routing scope, Guard policy and evaluators cannot expand. Core code is outside the
automatic promotion path and requires human review/deployment of a separately
validated release. Evaluation runs baseline and candidate independently against
real protected assertions on development and separate cases. Both provided cases
are public examples; neither is called hidden. Trial and budget limits belong to
a lineage, so changing experiment IDs cannot reset them or relax criteria.

Adoption, rejection and hold are all normal results. Adoption is a canary for
pre-delegated project/task categories and new missions only; running missions keep
their original release. Two verified new missions can stabilize it. Protected
follow-up failure can revoke it; rollback blocks new operations from that release,
stops/reconciles in-flight work, and selects the parent. It does not restore product
or external data. Demo improvements are deterministic behavioral tests, not proof
of better GPT quality, lower human rescue time or real cost savings.

## Exit codes and checks

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | Successful command / verified completed mission                 |
| 2    | Check, build or evaluation failure                              |
| 3    | BLOCKED: configuration, infrastructure or authorization missing |
| 4    | Mission waiting for its stated resume condition                 |
| 5    | Cancelled mission                                               |

`schema:generate`, `schema:check`, `typecheck`, `lint`, `format:check`, `build`,
`test`, `test:integration`, `test:docker:checks`, `test:docker:stdin`, `test:live` and `check` are available.
`npm test` has no external LLM requests or credentials. Integration tests use real
Git, SQLite, processes, local sockets and local SDK protocol fixtures.

See [architecture](docs/architecture.md), [dependencies](docs/dependencies.md),
[validation](docs/validation.md) and the recorded
[implementation order](docs/implementation-plan.md).
