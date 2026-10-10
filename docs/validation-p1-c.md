# P1-C report handoff validation — 2026-10-10

## Scope and cause

Baseline: clean current checkout `9ddf21ff7a5ba0d60e191760a219cc1211978b38`.
Implementation is confined to `task/p1c-report-handoff`, created from that same
commit by the repository helper and developed under its task usage lock. No merge,
push, deployment, paid API, live enablement, Improver or P1-D work is authorized.

P1-B already saved planned RoleReports and WorkItem completion atomically.
The missing connection was consumer input: Builder received `item.instruction`,
while later planned roles received mission/item/tree without dependency reports.
Final Failure Analyst used the unjournaled role path, and its return value was
ignored. Initial Explorer/Test Designer already entered initial planner facts.

The two minimal integration tests ran against the current baseline before runtime
edits: **FAIL 0/2**. Builder actually received only the 46-byte instruction, and no
final diagnosis existed in SQLite. After implementation, the same tests pass.
These are newly executed observations, not copied 1010v1 probe results.

## Implemented contract

- Select all transitive completed non-Builder ancestors of `dependsOn`, including
  paths through Builders; deduplicate diamonds. Never include unrelated work,
  another mission, an old mission revision or a different plan revision.
- Send full RoleReport content to the existing guarded Builder prompt and planned
  role `dependencyReports`. Retain `facts`, `hypotheses`, `unknowns`, suggested tests,
  reads and approval as model data. Do not treat any of them as signed evidence.
- Attach Runtime-owned mission ID/revision, plan revision, WorkItem ID/role,
  purpose, execution/call IDs, input/snapshot/result digests. Require a successful
  final call whose report matches the completed result. A changed tree is labeled
  `historical` with its original snapshot digest; `same-tree` means equal bytes,
  not independently verified truth.
- Save the failed verification's receipts/review/target before analysis. Reuse the
  existing RoleExecution journal/reservations/settlements with purpose
  `failure-analysis`, preventing collision with a real plan item of the same name.
  Completion, latest diagnosis reference, repair count and replan state are atomic.
  Preserve maxAttempts and explicit-resume/uncertain-result behavior. A pending
  analysis refuses a changed target tree.
- Resolve the latest saved diagnosis into `planner.plan.facts.failureAnalysis`
  after restart. It is explicitly historical to the failed plan/tree, even if
  its tree still matches. Human mission revision clears the reference. Neither
  dependency selection nor diagnosis lookup fetches all historical report rows.
- Limit each report/context to 65,536 UTF-8 JSON bytes, role input/planner
  mission+facts to 1,048,576, and Builder prompt JSON to 131,072. Authorized-read
  followups are checked too. Fixed adapter schema/recipe wrappers and Builder tree
  transport keep their existing limits. Overflow stops before affected dispatch
  with size/item information and a nothing-omitted reason. No truncation, LLM
  summary, RAG, new DB or permission expansion is used.

Old P1-B keys and independent-role input shapes remain unchanged. New fields are
optional internal JSON state; no SQL migration or public schema/generated type
change is required. Saved old successful calls remain reusable. Missing legacy
histories keep their existing operator hold; previously unsaved diagnoses are
unavailable rather than regenerated and presented as historical saved results.

## Executed checks

Environment: macOS arm64, official locally pinned Node **24.21.0**, npm **11.19.0**,
with PATH prepended by the primary checkout's `.local/node-v24.21.0-darwin-arm64/bin`.
`package.json`, `.node-version`, `.npmrc`, dependency versions and lockfile unchanged.

| Command / check                                                                                                             | Result                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `node dist/scripts/worktree.js create p1c-report-handoff` / `exec ... -- sh`                                                | PASS; same clean source commit; task lock held for development/commit                                                                   |
| `npm ci`                                                                                                                    | PASS; 132 packages installed, engines enforced                                                                                          |
| Before: `npm run build && node --test dist/tests/report-handoff.integration.test.js` (first two tests before Runtime edits) | FAIL 0/2; reproduced both missing connections                                                                                           |
| After: `npm run build && node --test dist/tests/report-handoff.integration.test.js`                                         | PASS 20/20; no skips/todos                                                                                                              |
| Initial `npm run check`                                                                                                     | FAIL 127/128 in unchanged descendant-process PID assertion; static checks and P1-C cases passed                                         |
| Exact generated process adapter/test comparison, then focused process test on baseline and changed checkout                 | Identical code; PASS 1/1 on each                                                                                                        |
| Final `npm run check`                                                                                                       | PASS 128/128; schema, typecheck, lint, formatting, build and offline tests; no skips/todos                                              |
| Four `report-metrics.js` runs below                                                                                         | PASS; real SQLite/Guard/Runner boundaries, controlled Planner/Runner behavior                                                           |
| Docker-only and real-provider/live tests                                                                                    | NOT RUN: P1-C uses offline orchestration evidence; live enablement/API calls are forbidden for this task, Docker transport is unchanged |

The initial aggregate process failure is retained here. The assertion checked
immediate PID absence after group termination. Its exact cause is unconfirmed;
identical generated code passed in isolation and the final aggregate passed.
P1-C changes no process cleanup code, timing thresholds or assertions, and excludes
no tests. The separate preexisting primary compiled suite is not used as evidence
that the current baseline source passed all tests.

## Regression coverage

Real Runtime + real SQLite are used throughout; model behavior is controlled at
PlanningPort, and inputs are captured at PlanningPort/actual RunnerPort through
real Guard. FakeRunner gains no content-marker-dependent success branch.

| Requested cases | Executed evidence                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A/B             | Explorer and Test Designer facts with varied IDs/content; downstream role and Builder receive full content/provenance; direct/transitive/diamond paths through a Builder deduplicate         |
| C               | Analyst-only diagnosis reaches next planner facts; diagnosis input includes actual failed receipts, review and target digest                                                                 |
| D               | SQLite close/reopen and a fresh Runtime reuse planned responses and diagnoses; completion rollback and lost completion reply preserve atomic state; no extra producer calls                  |
| E/F             | Unrelated work and foreign mission rows excluded; human revision excludes old reports; changed-tree reports explicitly historical; pending changed-tree diagnosis refused                    |
| G               | Multi-byte UTF-8 aggregate overflow, oversized report, whole role-input refusal and exact JSON byte limit; no silent omission or affected Runner/provider call                               |
| H               | Out-of-scope/`.env`/key reads denied; configured and key-pattern secrets refused before successful storage/forwarding; injected control text leaves mission/scope/recipe authority unchanged |
| I               | `approved=true` with wrong product and an assert-mutation P0 fixture yields actual protected FAIL receipts; no PASS, completion signature or seal operation                                  |
| J               | Both initial Explorer and Test Designer outputs still reach initial planning                                                                                                                 |

Within these executed cases: required dependency omission 0, unrelated inclusion 0,
unnecessary regeneration of saved results 0, authority/verdict overwrite 0; final
aggregate new failures 0. Overflow cases stop visibly rather than claiming complete
handoff. This establishes input delivery and orchestration, not real-model quality.

## Before/After measurements

Reproduce after build from the task worktree:

```sh
node dist/tests/report-metrics.js 9ddf21f dependencies
node dist/tests/report-metrics.js current dependencies
node dist/tests/report-metrics.js 9ddf21f diagnosis
node dist/tests/report-metrics.js current diagnosis
```

The probe loads that commit's Runtime via TypeScript transpilation and keeps the
same test harness/Planner/Runner. Each run creates fresh real SQLite and Guard
storage. Dependency checkpoint is completed; diagnosis checkpoint pauses the
second planner call after failed final verification. All counts below are newly
measured. Stored bytes are logical UTF-8 JSON, not SQLite file/WAL allocation.
Planner bytes capture all external mission/revision/facts arguments, excluding
AbortSignal and SDK fixed wrappers; Builder bytes are the actual Runner prompt.

| Measurement                          | Dependencies Before → After | Diagnosis checkpoint Before → After |
| ------------------------------------ | --------------------------- | ----------------------------------- |
| Runtime records JSON bytes           | 16,622 → 18,820             | 12,113 → 15,664                     |
| Runtime outbox payload bytes         | 1,801 → 1,801               | 1,756 → 2,074                       |
| RoleExecution JSON array bytes       | 3,438 → 3,438               | 3,438 → 4,705                       |
| Builder prompt bytes                 | 46 → 2,087                  | 46 → 2,087                          |
| Initial planner input bytes          | 1,247 → 1,270               | 1,247 → 1,270                       |
| Replanning input bytes               | N/A                         | 1,889 → 3,152                       |
| Initial/replanning facts bytes       | 436 → 459                   | [436, 1,078] → [459, 2,341]         |
| Reports newly inherited by Builder   | 0 → 2                       | 0 → 2                               |
| Reports newly inherited by replanner | N/A                         | 0 → 1                               |
| Report-role calls at checkpoint      | 6 → 6                       | 7 → 7                               |

Initial-planner reports existed both before and after; the initial 23-byte increase
is the explicit null diagnosis field. SQLite contains the Builder dispatch prompt,
so forwarding adds stored bytes even when already-saved producer rows are unchanged.
One final diagnosis adds a journal record and its existing transactional events.
There are no new model calls for handoff, summaries or saved-result regeneration.
Bytes alone establish neither token counts, billing nor model-quality improvement.

## Changed files and remaining limits

- `src/application/runtime.ts`: dependency resolution, bounded handoff, durable
  diagnosis/replan continuation, validation and compatible cached inputs.
- `src/application/report-context.ts`: provenance envelope and explicit byte limits.
- `src/ports/role-execution.ts`: optional internal final-analysis purpose.
- `tests/report-handoff.integration.test.ts`, `tests/report-helpers.ts`,
  `tests/report-metrics.ts`: behavioral regression and repeatable boundary metrics.
- `README.md`, `docs/architecture.md`, this record: behavior and evidence.

Reports can be wrong or contain hostile prose; marking data untrusted does not
prove a model will ignore it. Structural Guard/check/seal boundaries remain the
independent protection. Secret detection has its existing pattern/configured-value
limits. Required contexts exceeding the explicit caps need operator intervention;
they are neither silently shortened nor auto-regenerated. The one observed process
assertion failure remains unexplained despite successful final checks. Live model
quality, billing and Docker/OS isolation are not established by this offline task.
