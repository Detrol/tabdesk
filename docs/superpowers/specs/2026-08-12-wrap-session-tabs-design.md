# Wrap Session Tabs

## Goal

When the selected project's session tabs no longer fit on one line, wrap them onto as many rows as needed. The terminal panel area moves down and shrinks by the strip's actual height so every tab remains visible without horizontal scrolling.

## Interaction

- Tabs keep their current order, width, controls, and single-row appearance while they fit.
- Overflowing tabs continue on the next row from left to right, with no row limit.
- The session strip grows downward; the panel area starts immediately below it.
- Switching projects lets the strip shrink or grow to match that project's tabs.
- Overview, Files, and `+` remain part of the same wrapping strip.
- Dragging a session over a tab on another row keeps using the hovered tab as the reorder target.

## Implementation

Make `#content` a two-row CSS grid: an automatically sized strip row and a remaining-space panel row. Explicitly place `#strip` and `#panels` in those rows so hiding an empty strip collapses only the first row. Let the strip use `flex-wrap: wrap`, automatic height, and vertical padding equivalent to its current single-row alignment. Remove horizontal scrolling.

The panel grid remains responsible for terminal layout, but participates in the content grid instead of being absolutely offset by a fixed `38px`. This makes the browser propagate the strip's real height without JavaScript measurement or a `ResizeObserver`.

Remove `revealClippedStripTab()` and its calls. A tab in the rendered strip can no longer be horizontally clipped, so retaining activation-time scrolling would be obsolete behavior.

## Verification

Use a separate TabDesk instance with an isolated projects directory, tmux socket directory, browser profile, and debug port. Verify that:

1. A project with enough sessions produces multiple tab rows and no horizontal overflow.
2. The panel area's top edge equals the strip's bottom edge after wrapping.
3. Switching to a project whose tabs fit on one row restores the original strip height and panel position.
4. Overview, Files, `+`, tab activation, and dragging between rows still work.
5. The project's existing test command still passes.

## Out of scope

- A maximum row count or vertical scrolling within the strip.
- Changing tab widths, truncation, order, or controls.
- Persisting a row layout separately from tab order.
- Adding JavaScript height calculation, animation, or a dependency.
