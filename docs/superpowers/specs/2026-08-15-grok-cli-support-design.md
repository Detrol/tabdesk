# Grok CLI support

## Goal

Add Grok as a full TabDesk runtime. A user can start Grok, resume its saved
sessions, select its model and reasoning effort, edit its instruction files,
read its earlier conversations, and see Grok session titles in live tabs.

## Runtime behavior

- Offer Grok only when the `grok` executable is on `PATH`.
- Start it with permission mode `auto`.
- Resume a named session with `--resume` and the latest session with
  `--continue`.
- Let Grok keep ownership of a resumed session's model and effort.
- Give Grok's full-screen TUI control of mouse input and clipboard actions.

## Models, effort, and instructions

- Build the model picker from `grok models`. Parse only safe model IDs and
  fall back to the existing Default row if the command fails.
- Read Grok's configured default model without changing its configuration.
- Offer Grok's documented reasoning levels and pass a selected value through
  `--reasoning-effort`.
- Edit project and user-wide `AGENTS.md` files through the existing instruction
  overlay and its path validation.

## History and transcripts

- Read Grok's documented local session store. TabDesk does not create or
  change Grok session data.
- Use each session summary for ID, owner directory, title, and timestamps.
- Accept both the displayed project path and its resolved path so symlinked
  projects work.
- Ignore malformed sessions, unsafe IDs, subagent sessions, and sessions owned
  by another directory.
- Limit history work to 40 candidate summaries and return at most 10 sessions.
- Render user and agent text from the update stream. Show tool calls by name
  and omit thoughts and raw tool output.
- Keep the existing 8 MiB transcript limit.

## Limits and failures

Grok has no documented local quota command or account-limit API. TabDesk will
hide quota meters for Grok instead of showing another runtime's numbers.

Missing files, malformed records, and failed model-list commands produce an
empty or Default-only result. They must not break the main window.

## Verification

Focused tests use an isolated Grok session store and cover:

- runtime command, resume, and continue arguments;
- model parsing and reasoning-effort flags;
- project and global instruction paths;
- history ownership, ordering, limits, and unsafe IDs;
- readable transcripts with thoughts and raw tool output removed;
- live title support for Grok tabs.

The full TabDesk test command must pass. The README must list Grok wherever it
describes supported session history and model behavior.
