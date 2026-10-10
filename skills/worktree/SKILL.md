---
name: worktree
description: Develop Software Factory itself in isolated local Git worktrees, validate commits, serialize integration into local master, and recover or clean up completed tasks. Use for repository implementation and modifications, whether working alone or in parallel; read-only investigations, Factory missions and remote Git operations are outside this skill.
---

# Software Factory development worktrees

The maintained source is `skills/worktree/SKILL.md`;
`.agents/skills/worktree` links to this directory for Codex and Copilot discovery.
Follow repository `AGENTS.md` and `docs/agent-rules/common.md` in each task.
This helper is independent of Factory Runtime, Builder, Guard and snapshots.

## Commands and lifecycle

Use Node 24.21.0 and npm 11.19.0 on the same host. Start from any worktree of
this non-bare repository (first run `npm ci` and `npm run build` in the primary checkout); local `master` must exist, and integration needs exactly
one worktree with `master` checked out. Use the helper from the primary checkout
so its implementation stays stable while task branches change it:

```sh
REPO=/absolute/path/software-factory
node "$REPO/dist/scripts/worktree.js" create task-001
node "$REPO/dist/scripts/worktree.js" list
node "$REPO/dist/scripts/worktree.js" status task-001
node "$REPO/dist/scripts/worktree.js" exec task-001 -- sh
node "$REPO/dist/scripts/worktree.js" test task-001
node "$REPO/dist/scripts/worktree.js" merge task-001
node "$REPO/dist/scripts/worktree.js" cleanup task-001
node "$REPO/dist/scripts/worktree.js" recover task-001
node "$REPO/dist/scripts/worktree.js" complete task-001
```

`status` and `recover` without an ID inspect/recover all registered tasks.
Output is JSON with ID, branch, absolute path, base commit and status; `status`
also reports actual Git registration, refs, filesystem presence and dirty files.
Failure exits nonzero with a reason; never interpret a state file as Git evidence.
`npm run worktree -- <operation> <id>` is an equivalent entry point.

| Operation  | Preconditions and success                                                                                                                                                 | Failure behavior                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `create`   | Safe unique ID; records current local master SHA, creates `task/<id>` and external worktree. Returns `DEVELOPING`. Reuses an owned worktree; a completed ID stays `DONE`. | Existing unowned refs/paths rejected; partial create recoverable.                                                |
| `exec`     | Runs command in owned worktree while holding task usage lock; use for editing, builds, tests and commits.                                                                 | Other operations on that task wait; no master lock during development.                                           |
| `test`     | Clean committed task; `npm ci`, `npm run check`, `git diff --check <base>...HEAD` pass on unchanged SHA. Returns `TESTED`.                                                | Keeps task; old tested SHA invalidated.                                                                          |
| `merge`    | Current SHA equals tested SHA; clean master. Fresh integration worktree merges task and runs the same checks before fast-forwarding master to the tested SHA.             | Conflicts: `WAITING_CONFLICT`; test failure: `TEST_FAILED`; no master update. Candidate retained for inspection. |
| `cleanup`  | Verified integration and tested task commits remain in master; task ref unchanged, task usage lock acquired, paths owned, no unsaved files.                               | `CLEANUP_PENDING`; integrated master is never rolled back.                                                       |
| `recover`  | Reconciles actual refs, worktrees, status and commits; reclaims only locks whose same-host owners and child process groups have exited.                                   | Unknown/live owners, partial paths, conflicts and permission failures stop safely.                               |
| `complete` | Test → integration test → local merge → cleanup, or cleanup an already integrated task. Returns `DONE` only after paths and refs are absent.                              | Stops at first failed prerequisite; repeat/recover without duplicate merge.                                      |

IDs contain 1–64 lowercase letters, digits and hyphens, beginning with a letter
or digit. One ID owns one branch and one worktree. Do not reuse another task's
path or branch. `create` never overwrites refs, edits master or contacts remotes.

## Development and validation

Only edit the assigned task worktree and commit its changes there. Use `exec`
for the entire development session (including editor/agent process), and exit it
before `test`/`complete`. All users and agents must cooperate with these locks;
unregistered editors or direct Git commands cannot be detected reliably. Do not
edit another task, edit master directly, or run concurrent manual integration.

The helper takes short repository locks during creation/cleanup and holds the
repository lock throughout candidate creation, checks and master update. Task
locks do not block other tasks. No lock is held on master during development.

Validation runs the existing `check` script: schema, TypeScript, ESLint,
Prettier and offline regression tests. Run additional task-specific checks through
`exec` if needed. A commit change invalidates the tested SHA. Docker/live checks
are separate and must be reported separately when relevant.

Before helper validation, `node_modules` and `dist` must be absent. The helper
records only those directories created by its own validation, compares their
complete file hashes/link targets, then removes the matching generated entries
individually. Preexisting or changed artifacts are preserved and block cleanup;
never delete them blindly. Other untracked/ignored files always block deletion.
If interrupted before artifacts are recorded, inspect and relocate them explicitly
before retrying; recovery never guesses their ownership.

## Integration, conflicts and cleanup

Integration branches are `integrate/<id>-<uuid>` and use a separate worktree.
Candidate validation runs before master changes. If master advances during
validation, discard the owned clean candidate, rebuild from current master and
retest (up to three attempts). The final fast-forward names the validated commit,
and the resulting master SHA is verified before cleanup.

Conflicts retain both task and candidate. Inspect files listed in the error.
Resolve and commit the retained candidate explicitly, then merge that candidate
branch into the task branch to preserve the resolution before `recover` removes it.
Then run `complete` for fresh task and integration validation. Never auto-select
ours/theirs. Failed clean candidates can be discarded by `recover`; their source
changes remain on the task branch.

Cleanup removes only clean owned worktrees, then deletes refs with `git branch -d`.
A clean temporary candidate is detached at its recorded SHA so `branch -d` can
check reachability even when that candidate was superseded. Partial detach/delete
is persisted for recovery. Task branch deletion uses the master worktree. No hard
reset, forced worktree removal, forced branch deletion, clean, prune or unchecked
recursive deletion is used. A later successful task may advance master before
pending cleanup; recovery requires both recorded commits to remain ancestors.

## Locks, storage and recovery

External paths are `<primary-parent>/.worktrees/<primary-name>/<id>`, with
`tasks/*.json`, repository identity and atomic directory locks beside them.
The common Git directory identifies the repository across all worktrees;
collisions with another repository or symlink control paths stop safely.
The control directory is outside the working trees and `.git`.

Atomic `mkdir` takes locks across Node processes and agent sessions. Owner records
include host, PID, unique token and child process groups. A short atomic gate
serializes lock acquisition/release and stale-owner recovery. Locks wait up to
10 minutes; ordinary commands never remove stale owners. `recover` reclaims only
confirmed dead same-host owners and checks actual Git state before continuing.
PID reuse can conservatively block recovery. A gate interrupted at its tiny
critical section, or a missing/malformed owner, requires manual inspection;
verify all users are stopped and preserve the lock for diagnosis before retrying.
Never remove another process's lock or Git's internal lock automatically.

State records are written by atomic replacement before destructive steps. After
an interruption immediately following fast-forward, recovery checks whether the
validated candidate is already an ancestor of master, then resumes cleanup.
Never merge that task twice. An interrupted test is not `TESTED` and must rerun.
Partial create can attach the recorded unchanged branch or reuse its exact owned
worktree; unknown paths are retained. `DONE` is rechecked against refs and disk.

Permission errors become `WAITING_PERMISSION` with the actual cause. Independent
external locks do not fix Git permissions. Do not use sudo, chmod, chown, delete
Git locks or terminate other agents as recovery actions. Resume after the owner
has corrected permissions. Remote push/pull and PRs are excluded.

## Four tasks in parallel

Create from the primary checkout:

```sh
for id in task-001 task-002 task-003 task-004; do
  node "$REPO/dist/scripts/worktree.js" create "$id"
done
```

In four separate terminals, start the corresponding command and develop/commit
inside its assigned shell:

```sh
node "$REPO/dist/scripts/worktree.js" exec task-001 -- sh
node "$REPO/dist/scripts/worktree.js" exec task-002 -- sh
node "$REPO/dist/scripts/worktree.js" exec task-003 -- sh
node "$REPO/dist/scripts/worktree.js" exec task-004 -- sh
```

Exit the shells. Completion may be requested in parallel; task tests run
independently and integration is serialized in lock acquisition order:

```sh
for id in task-001 task-002 task-003 task-004; do
  node "$REPO/dist/scripts/worktree.js" complete "$id" &
done
wait
node "$REPO/dist/scripts/worktree.js" list
```

Successful tasks are `DONE`, with branch and worktree absent. Inspect any failure
and use `recover <id>` or `cleanup <id>` as appropriate; do not assume `wait`
alone proves every background job passed.
