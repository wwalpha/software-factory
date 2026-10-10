# Codex App Server new-task probe

This standalone development probe creates exactly one persistent, independent
`Queue GUI Probe` in an already registered local repository. It does not use the
Factory Codex adapter, Queue Skill, worktree cleanup automation, resume, fork,
past conversation context, or a daemon. No new dependencies are required.

The installed CLI is the protocol authority. Inspect it without creating a task:

```sh
codex --version
codex app-server --help
codex app-server generate-ts --experimental --out /tmp/codex-app-protocol
```

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes the newline JSON RPC initialize/initialized and thread/turn lifecycle.
The installed Desktop CLI also exposes `project/list`, `projectId`, and
`initialize.codexHome`; the probe requires those fields and fails if absent.
`historyMode: legacy` allows `thread/read` to hydrate the entire test history.

## One-time execution

Keep the Codex desktop app running. Use the same OS user, HOME, CODEX_HOME, CLI
and registered repository as the desktop app. Do not substitute `/tmp/codex-home`.
Check the desktop server's open `state_5.sqlite` path using `lsof`, and compare it
with the probe's recorded `initialize.codexHome`. The app must already have the
repository registered; the probe refuses missing or ambiguous registration and
never edits project registration, existing threads, settings or credentials.

After development validation, local merge and cleanup, build the primary checkout
with the pinned Node 24.21.0 / npm 11.19.0, then run once:

```sh
npm run build
node dist/scripts/codex-app-probe.js --create --cwd /absolute/registered/repository
```

The CLI is selected from PATH, not the npm package's pinned Factory worker binary.
The probe starts and stops its own short-lived `codex app-server --listen stdio://`
with the inherited environment. It neither restarts nor attaches to the desktop
server. This tests whether shared persisted state is sufficient for GUI discovery.
An existing daemon/socket is not installed or started.

Results, API errors and the thread ID are fsynced to the user-wide, mode-0600
`~/.local/state/software-factory/codex-app-probe.jsonl`. The exclusive creation
claim is made before server effects. Repeating `--create`, including after a
crash, refuses to create another thread. Preserve this journal. A lost creation
response is uncertain and must be reconciled manually, never blindly retried.
The preflight checks every cwd page for an exact saved name match. Verification
checks every project page for the saved ID. Neither uses `searchTerm`: the
installed CLI matches previews and can omit a separately saved task name.
The journal contains this probe's own prompt/reply and metadata, not credentials
or other conversations. It is outside the repository and Codex profile.

Only the identification prompt is sent. The thread uses read-only sandboxing,
no network tool access, and no approvals; server tool requests are rejected.
Completed status, exact response, absence of tool items, independent history,
project assignment, non-ephemeral state, and session path are checked. The output
is always `UNVERIFIED` until someone completes GUI verification; API success alone
never establishes GUI visibility.

Reopen a separate short-lived App Server to verify persistence without another
thread or turn:

```sh
node dist/scripts/codex-app-probe.js --verify --cwd /absolute/registered/repository
```

## GUI verification and verdict

1. Without restarting the app, open/expand the registered repository in the sidebar.
2. Confirm `Queue GUI Probe` appears. Record whether it appeared automatically or
   only after navigating to the project, and whether a restart was required.
3. Click the task and confirm the initial prompt and
   `QUEUE_GUI_PROBE_APP_SERVER_OK` are visible.
4. In that task's GUI composer, send:
   `Do not use tools or change any files. Reply exactly: QUEUE_GUI_PROBE_GUI_OK`
5. Confirm `QUEUE_GUI_PROBE_GUI_OK` is returned normally, then run `--verify`
   again to confirm the extra turn persisted. Do not restart the app automatically.

| Verdict    | Required evidence                                                                       |
| ---------- | --------------------------------------------------------------------------------------- |
| PASS       | Creation, persistence, GUI visibility and GUI continuation all succeed without restart. |
| PARTIAL    | The thread works but appears only after a user-performed app restart.                   |
| FAIL       | Creation/persistence fails or GUI continuation is confirmed impossible.                 |
| UNVERIFIED | GUI verification is incomplete, including when automation cannot access Codex.          |

If absent, check in this order: `project/list` matched the exact repository root;
`thread/start`, `thread/list` and `thread/read` agree on projectId and cwd;
`initialize.codexHome` and the saved session path match the desktop profile;
a separate server's `--verify` still sees history. If all pass, remaining
uncertainty is desktop refresh/discovery or filtering, not proven storage failure.
Do not modify app state files or use a deep-link/API navigation workaround as
evidence of spontaneous sidebar visibility. Record actual GUI observations.

Offline tests use a separate fake stdio server and temporary files, never the real
Codex profile. They cover creation, independent reads, duplicate refusal,
uncertain effects, failed turns, unexpected replies/tools and profile mismatch.
Full Factory Docker/live missions are outside this probe.

## Device observation (2026-10-10)

- CLI: `0.162.0-alpha.17.2` from the installed desktop bundle.
- App: `26.1007.21159`, build `20052`; app/server were already running.
- Profile: `/Users/macmini/.codex`, also opened by the desktop server.
- Repository: `/Users/macmini/Documents/projects/software-factory`.
- Canonical Project: `01a1217c-1033-72e0-9231-fc1b99c83785` (SoftwareFactory).
- New Thread: `01a124ba-087f-7651-b0c9-4c8e1046a6e5` (Queue GUI Probe).
- Turn: `01a124ba-0d45-7140-bacd-926597316a1d`, `completed`, exact expected reply,
  one user message, one assistant message, no tool items.
- initialize/initialized, thread/start, thread/name/set and turn/start succeeded.
  Separate-server thread/list and thread/read succeeded after correcting the
  search filter; persisted cwd, project, name and session path matched.
- Exactly one real thread/start was sent. An earlier preflight attempt stopped
  before creation. Both original error records were retained outside the repo.
- GUI: UNVERIFIED. Computer Use refused access to the Codex application under its
  safety policy. Sidebar visibility and GUI continuation require the manual
  procedure above; no app restart was performed.
- Queue adoption: pending GUI verification. API evidence alone is insufficient.
