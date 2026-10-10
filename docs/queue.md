# Local prompt Queue

Use `$queue ログ処理の重複コードを整理する` in this repository. Discovery uses
`.agents/skills/queue → ../../skills/queue`, the same publication as Worktree.
Registration preserves the exact prompt and returns `QUEUED`, its ID and position.
It never launches, interrupts, dequeues, or creates a worktree/thread. Native
`/queue` support and GUI skill selection require device verification; do not
interpret a plain text `/queue` request as proof of native slash recognition.

Build in the primary checkout with the README's pinned Node/npm before use:

```sh
npm run build
# Pass exact UTF-8 bytes; redirecting an existing prompt file adds no newline.
node dist/scripts/queue.js enqueue < /absolute/prompt.txt
node dist/scripts/queue.js status
node dist/scripts/queue.js recover
```

## Completion and isolation

`Worktrees.run` checks successful DONE results from `complete`, `merge`, `cleanup`
and `recover` after both task and repository locks have been released. Cleanup
and tested integration are rechecked. Failed checks/integration/cleanup do not
handoff. An empty queue records the event without starting anything. Each persisted
`task ID + tested SHA + merged SHA` event reserves at most one FIFO entry, even
when retried. A failed entry blocks later pending entries, including handoffs from
other agents. Concurrent successful events may each reserve a different entry.

The detached per-item Worker starts from the existing primary checkout, creates
an assigned worktree through the existing helper, and holds its usage lock during
the agent turn. The agent edits/commits there; the Worker releases that lock and
runs the ordinary complete lifecycle. Existing human/editor `exec` use is unchanged.
The Worker retains the App Server connection/event processing until the turn
finishes (24-hour bound and the shared client's 8 MiB output bound), then stops its own server before validation and Cleanup.
There is no queue daemon. The parent's exit does not end the Worker.

The existing PoC's stdio client is shared. The Worker uses `initialize/initialized`,
`project/list`, **thread/start**, `thread/name/set`, and **turn/start**. It never uses
resume/fork or copies prior conversation. The saved prompt text is not rewritten. When it begins with `$queue`, an explicit
`skill` input loads the maintained Queue instructions alongside that text, as
recommended by the [App Server documentation](https://learn.chatgpt.com/docs/app-server).
The remaining invocation text is queued data, including read-only/no-task wording. Fresh task assignment instructions contain only this worktree's
lifecycle, not predecessor context. Registered primary project identity, independent
history, saved prompt and completed turn are independently checked using thread/read;
thread/list confirms persisted project discovery. These checks leave GUI `UNVERIFIED`.

The selected `codex` on PATH inherits the normal profile, credentials, sandbox,
approval and model settings; the Factory SDK's separate profile is not used. No
sandbox/approval/model override is sent. The client never approves operator requests:
an unexpected interactive request stops the task as BLOCKED for operator action.
Continue through the GUI only after inspection; Queue recovery never launches a
second turn to resolve approval. Thread history retains its assigned worktree cwd,
which is removed by successful Cleanup; select an existing directory in the GUI
before a later file-editing turn. GUI continuation from a removed cwd requires E2E
verification and is not inferred from API persistence.

## Durable state and recovery

State is Git-external `<primary-parent>/.worktrees/<primary-name>/queue.json`.
The existing repository identity and atomic directory locks are reused, with
`queue.lock` and `<item>.worker.lock` independent of Worktree locks. Queue state
uses an exclusive temporary file, fsync, atomic rename and directory fsync. Prompt,
monotonic ID, reservation/event, thread/turn IDs and errors are retained; DONE entries
are not deleted. UTF-8 prompts above 1 MiB and total state above 64 MiB are rejected
without truncation. A filesystem failure after rename can make acknowledgement
uncertain: inspect `status` before manually repeating registration.

States: PENDING → RESERVED → LAUNCHING → RUNNING → DONE, or BLOCKED.
Reservation and DONE-event consumption are one locked atomic update. LAUNCHING
is persisted before thread/start; thread ID is persisted before turn/start intent;
turn ID and RUNNING are persisted before waiting for completion. Both usage and
worker locks record the owned App Server process group, preventing stale recovery
while an orphan server can still edit.

`recover` explicitly reclaims only confirmed-dead same-host owners using Worktree's
existing lock mechanism. RESERVED can dispatch again: worker exclusion plus the
state guard prevents a second launch. Known thread/turn IDs are inspected using
thread/read; a completed exact original turn can resume validation/Cleanup, including
an interrupted cleanup. Unknown thread creation, lost turn identity, failed/interrupted
or still-running execution stays BLOCKED; thread/start and turn/start are never
blindly retried. Live/unknown owners, changed outputs, permission errors or unknown
Git resources remain protected by the existing Worktree recovery rules.

Inspect `queue.json`, task ownership records and `<item>.worker.log` before manual
resolution. Do not delete locks, reset states or resubmit uncertain effects to force
progress. Safe prelaunch failures remain retained BLOCKED for operator inspection;
there is no retry command or generic task engine. If a prompt has been acknowledged
before a crash, it stays persisted; unacknowledged registration must be reconciled
against state before retrying.

## Validation

`npm run test:queue` uses real Git/storage/processes and a Mock App Server. It never
creates real Codex threads. The ordinary `npm run check` includes these tests plus
existing Worktree and PoC regressions. Explicit real-device execution:

```sh
node dist/scripts/queue-e2e.js --run
```

Requires a registered project, signed-in normal Codex profile, a built primary
checkout, and no active/pending/blocked queue entries. It creates a starter worktree
and two real Codex tasks: B invokes `$queue` to register C; C executes read-only
commands in its assigned worktree. All three complete validation/integration/Cleanup.
An empty commit records the starter event; source files need no E2E-only changes.
External `<starter>.e2e.json` retains IDs and results. API/chain success is separate
from GUI success; no repeated probe creation, app restart or profile mutation occurs.

For GUI confirmation, locate the two saved `Queue q-...` tasks in the sidebar (the desktop may
show external Worktree tasks outside its saved project) without restarting the app. Confirm exact B/C prompts and C's actual tool
execution/output. Open C, select the existing primary directory if needed, and send
`Do not use tools or change files. Reply exactly: QUEUE_E2E_GUI_OK`. Confirm the
reply and normal interaction. Separately try `/queue` in the composer and record
whether it is a native command; verify `$queue` skill discovery/registration.
Computer Use may be prohibited from accessing Codex; record that as UNVERIFIED,
not PASS. Do not use programmatic navigation as evidence of automatic sidebar refresh.

## Recorded checks (2026-10-10)

- Downloaded/extracted the requested GitHub master ZIP; scripts matched the initial
  local checkout. No local work was overwritten.
- Node 24.21.0 / npm 11.19.0; `npm run check`: 155 tests passed, zero failures/skips,
  including 16 Queue cases and the existing Worktree/App Server probe regressions.
- Skill Creator structural validation: PASS. Real `$queue` invocation, execution,
  automatic chain and GUI verification are recorded after the explicit device run;
  these offline results do not establish those outcomes.
- Computer Use refused access to Codex (`com.openai.codex`) under its safety policy.
  Native `/queue` recognition and GUI visibility/interaction remain UNVERIFIED.

### Device invocation correction

The first E2E starter and B completed Cleanup, but B interpreted the `$queue`
payload's read-only/no-task wording as a current instruction and did not register C.
That run is FAIL for chaining; its original item was not replayed. The normal
`skills/list` API independently discovered the enabled repository Queue skill.
An explicit Skill input plus instructions defining the invocation payload as data
now accompanies the unchanged text. The E2E checker stops immediately if B finishes
without registering C, rather than waiting out its deadline.

The second device turn executed the payload instead of registering it. Its known
thread/turn remained BLOCKED because App Server omits Skill metadata from persisted
user messages. Verification now checks exact saved text and independent history;
Skill dispatch remains checked at the request boundary. Static lifecycle developer
instructions clarify that `$queue` payload is future-task data. The known completed
turn can resume Cleanup through recovery without any new start/turn request.
The user confirmed q-0001 is visible outside the project section; project placement
is separate from visibility. GUI interaction and native slash recognition still
require the user's device result.
