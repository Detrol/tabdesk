# Reorder Project Session Tabs

## Goal

Let a user drag session tabs left or right within one project's session strip. The chosen order must survive renderer reloads and TabDesk restarts. The Overview and `+` controls stay fixed.

## Interaction

- Only session tabs are draggable.
- Dropping on the left or right half of another session places the dragged tab before or after it.
- The target edge shows an insertion marker while dragging.
- Dropping outside a valid session target or into the tab's current position changes nothing.
- Reordering does not activate the dragged tab or change its pinned, running, waiting, or dead state.
- A tab cannot move to another project.

## Architecture and data flow

A small pure module, `renderer/tab-order.js`, owns the ordering rules. It exposes operations to:

1. Move one tab ID before or after another tab ID.
2. Apply an ordered list of session IDs to persisted tab records while leaving unrelated records in their existing slots.
3. Update or insert a persisted record without moving an existing record.

The renderer keeps an explicit list of tab IDs alongside the existing `tabs` map. `sessionsOf()` reads through that list, so `renderStrip()` and project fallback selection use the same order. A successful drop updates the list, rerenders the strip, mirrors the new order to the tray, and sends the active project's ordered session IDs through a new preload IPC method.

The main process validates the submitted IDs, reorders only matching records in `openTabs`, and writes the updated array through the existing settings store. `rememberTab()` uses the shared update-or-insert operation so later renames and terminal reattachments retain the record's position. Restore keeps persisted records in array order and appends newly discovered orphan tmux sessions in stable session-name order.

Existing settings need no migration: their current array order becomes the initial tab order.

## Failure behavior

Invalid or duplicate session IDs are rejected by the main process. A failed persistence write does not interrupt or close any session; the current renderer order remains usable for that run and the previous persisted order returns after restart.

## Verification seam

The public seam is the pure `TabOrder` module. Automated tests cover movement before and after a target, no-op and invalid moves, project-scoped record reordering, duplicate rejection, and position-preserving record updates. The renderer wiring is checked by loading the changed renderer and confirming that dragging changes the strip order without changing the active or pinned tab.

## Out of scope

- Moving a session between projects.
- Reordering the Overview or `+` controls.
- Reordering projects in the left rail.
- Adding a third-party sortable library or drag animations.
- Keyboard-specific tab reordering controls.
