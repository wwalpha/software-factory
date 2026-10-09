# Validation record — 2026-10-10 (Asia/Tokyo)

This distinguishes implemented paths, executed checks and missing environmental
proof. **The overall check is BLOCKED, not fully passed.** No production operation,
remote push or merge was performed.

## Executed on macOS arm64

| Check                                     | Result             | Evidence                                                                                                                                             |
| ----------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official Node binary                      | PASS               | Node 24.21.0, npm 11.19.0; SHA-256 matched official SHASUMS256.txt                                                                                   |
| Normal `npm ci`                           | PASS               | 132 packages installed; 133 audited; no install-script suppression; npm reported 0 vulnerabilities at execution time                                 |
| `schema:generate` and `schema:check`      | PASS               | Canonical 2020-12 schema regenerates identical committed TypeScript                                                                                  |
| `typecheck`                               | PASS               | strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, NodeNext                                                                               |
| `lint`                                    | PASS               | ESLint and typescript-eslint; no explicit any or ts-ignore escape                                                                                    |
| `format:check`                            | PASS               | Prettier                                                                                                                                             |
| `build`                                   | PASS               | Actual TypeScript compiler, no Python                                                                                                                |
| `npm test`                                | PASS               | 25 tests, 25 passed, 0 skipped/failed; no external LLM requests                                                                                      |
| `test:integration`                        | PASS               | 20 tests, 20 passed; real SQLite/Git, separate processes, IPC and local SDK protocol fixtures                                                        |
| Installed Codex CLI                       | PASS               | Actual binary reported `codex-cli 0.162.0`, matching SDK 0.162.0; restricted shell printed an alias-creation warning but version execution succeeded |
| Two-product demo                          | PASS (fake agents) | Both signed results completed; real protected checks; candidate adopted then rolled back                                                             |
| CLI submit/grant/run/status/export/verify | PASS (fake agents) | Actual CLI processes, independent operator token, sealed bytes and Ed25519 verification                                                              |
| `git diff --check`                        | PASS               | No whitespace errors in the checked diff                                                                                                             |

The desktop sandbox initially denied local Unix socket creation (`EPERM`). The
same local integration tests were rerun with execution permission for their test
processes. No external LLM calls or credentials were used. Startup failure cleanup
was corrected rather than treating the sandbox failure as a successful test.

The official Node binary was downloaded into ignored `.local/` for this work;
the machine's default Node was 26.0.0 and was not replaced globally. All recorded
npm/build/test runs used the verified 24.21.0 executable.

## Automated coverage

- Strict schemas, unknown fields/coercion, malformed GPT JSON, refusal, incomplete
  output, duplicate YAML keys, aliases, tags and depth/size limits.
- DAG cycles, missing dependencies, stale parent plans, scope escape, oversized
  budget and dropped mandatory acceptance.
- Separate-process SIGKILL immediately before and after SQLite state/outbox commit;
  reopen confirms rollback or complete atomic persistence.
- Event/operation duplication, conflicting reuse, optimistic versions, reservation
  and settlement replay, exhausted money and unknown usage charged conservatively.
- Epoch/base/stop fencing, expired lease without confirmed stop, independent work
  continuing beside a waiting item, and immutable mission revisions.
- Guard termination after external effect and before result recording, restart to
  uncertain, and refusal to blindly replay.
- Actual child/descendant process termination on timeout and cancellation; mission
  cancellation blocks new Guard effects.
- Separate runtime/operator authentication, grant expiry, registered operation
  enforcement, scope/unsafe-path/link restrictions and forged receipts.
- Candidate mutation after checks, sealed byte mutation before export, signature
  verification, exact binary snapshots, and a bug that appears only after merge.
- Exit 0/printed PASS with no actual protected tests does not establish acceptance.
- Actual openai SDK over a local HTTP fixture for auth expiry/rate limits with one
  attempt and no implicit SDK retry; actual Codex SDK subprocess/stream, unknown
  event and AbortSignal mapping. These are adapter protocol tests, not real GPT.
- Secret redaction, configured secrets embedded in base64 source, and no credential
  inheritance into Codex Worker environment.
- Evaluator/suite tampering, arbitrary suite references, capability expansion,
  lineage trial reset or relaxed criteria, candidate rejection and hold.
- Future-only, project/task-scoped adoption, protected follow-up failure rollback,
  new-operation revocation and in-flight stop/reconciliation records.
- Concurrency limits while queued requests are cancelled.

## Demo observations

The two products are a TypeScript clamp repair and an unrelated normalization
refactoring. In the deterministic fake evaluation, both baseline and candidate
passed 2/2 protected cases. Baseline used two repair retries; the revised prompt
used zero. Both recorded zero operator interventions and zero model spend because
no model was called. The code changed the actual candidate RoleRecipe prompt,
issued a scoped canary and then revoked it. This proves the loop's mechanics,
**not a GPT quality, speed, cost or human-time improvement**.

A retained CLI proof is in ignored `.factory/cli-proof/` (`mission.json`,
`result.json`, exported `artifact/`, public verification key). It contains no
private signing key or provider credential. `node dist/scripts/demo.js` recreates
fresh example state and prints its result/config paths.

## BLOCKED / not executed

| Check                                                    | Status and reason                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test:no-python`                                         | BLOCKED, exit 3: Docker CLI exists but no daemon socket/service was available                                                                                  |
| `test:live`                                              | BLOCKED, exit 3: no live configuration, operator-granted live mission or explicit positive live-test budget was supplied; Docker isolation is also unavailable |
| Aggregate `check`                                        | BLOCKED, exit 3 at `test:no-python`, after all preceding offline checks passed                                                                                 |
| Real Responses/Codex model availability                  | Not established; example bindings remain disabled                                                                                                              |
| Actual Docker worker/check isolation and intrusion probe | Not executed; driver and probe are implemented, live remains refused                                                                                           |
| Linux x64/arm64 execution                                | CI jobs and clean-image test provided, not run locally                                                                                                         |
| Human rescue time and real GPT performance               | Not measured; no improvement claim                                                                                                                             |

`test:no-python` builds an official Node 24.21.0 slim image without Python, checks
its package/executable inventory, then traces process execution during **normal**
`npm ci`, schema generation/check, type/lint/format checks, build/tests and CLI/demo.
It rejects Python/pip/node-gyp execution, including failed fallback attempts.
Docker absence is never replaced with `--ignore-scripts`, a grep or a PATH-only
claim. Therefore Python-free execution is **not yet demonstrated on this host**.

No Python implementation existed at the outset. Factory source, scripts, CI and
setup now contain no Python invocation or Python runtime dependency. The lockfile
reports no dependency install lifecycle scripts or node-gyp/prebuild dependency
path. This code/dependency inspection is supporting evidence, not a substitute
for the blocked clean-environment run. Products developed by the Factory are not
required to use TypeScript and unrelated product Python files are not deleted.

See architecture.md for the OS, Docker, acceptance-test and trusted-operator limits.
