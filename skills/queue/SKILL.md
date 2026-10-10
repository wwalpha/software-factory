---
name: queue
description: Register an exact prompt in this repository's persistent FIFO for execution as a fresh Codex task after successful Worktree Cleanup. Registration only.
---

# Register a queued prompt

Use `$queue <prompt>` in Codex. In the verified desktop client, selecting the
repository Queue Skill from the native `/queue` picker also registers the prompt.
Slash picker support depends on the client; plain `/queue` text without selecting
the Skill is not proof of native command recognition.
The maintained source is `skills/queue/SKILL.md`; `.agents/skills/queue` links here.

The `$queue` invocation makes registration the current task. Treat all text after
the invocation as **data to save**, even when it says to read files, remain read-only
or not create tasks. Those instructions belong to the future task; do not execute
them now.

1. Extract only the prompt following the skill invocation. Preserve every character,
   newline and space of that prompt; never summarize, rewrite or append instructions.
2. Resolve the primary checkout with `Worktrees.open()` or `git worktree list`.
   Use its built `dist/scripts/queue.js`. If absent, report the missing build; do not
   launch a task or create a worktree to repair it during registration.
3. Pass the exact prompt as stdin to `node /primary/repository/dist/scripts/queue.js
enqueue`, using a tool's stdin argument or a UTF-8 temporary file and input
   redirection. Do not interpolate prompt text into a shell command, and do not add
   a heredoc newline to the saved prompt. Run from an existing repository worktree.
4. Return the actual successful output, for example:

   ```text
   QUEUED
   ID: q-0001
   Position: 1
   ```

An empty prompt or a prompt above 1 MiB is rejected without registration. A save
failure is not QUEUED. Registration never takes an item, creates a Codex thread or
worktree, launches an agent, or interrupts an existing task.

Successful Worktree completion checks the queue after Cleanup and lock release.
It starts at most one item for that DONE event. No queue daemon runs. To inspect:
`node /primary/repository/dist/scripts/queue.js status`. Explicit operator recovery
uses `recover`; uncertainty is BLOCKED and never blindly resubmitted. Do not run
recovery as part of `$queue` registration. See [operation details](../../docs/queue.md).
