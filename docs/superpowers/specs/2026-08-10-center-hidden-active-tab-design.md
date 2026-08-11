# Center Hidden Active Tab

## Goal

When activating a session tab that is outside the session strip's visible horizontal viewport, bring it toward the center instead of revealing only its nearest edge. Keep the strip still when the active tab is already fully visible.

## Interaction

- A fully visible active session tab does not change the strip's scroll position.
- An active session tab that is clipped on either side is brought as close to the horizontal center as the strip's scroll bounds allow.
- Scrolling is immediate and unanimated.
- Overview and `+` controls retain their current order and behavior.

## Implementation

After an activation applies the layout, a small local helper compares the active tab's bounding rectangle with the strip's bounding rectangle. If the tab is not fully contained, it calls the browser's native `scrollIntoView()` with nearest block alignment and centered inline alignment. No dependency, persisted scroll state, animation, or additional layout spacer is introduced.

`setActive()` and the direct panel activation handlers call the helper after layout. The helper only acts when the activated tab belongs to the currently rendered strip, so a cross-project pinned-panel click or drop keeps its selected project and strip unchanged.

## Verification

Use a separate TabDesk instance with an isolated projects directory, tmux socket directory, browser profile, and debug port. Verify that:

1. Switching from a shorter project back to a project whose active tab is outside the viewport brings that tab toward the center.
2. Activating a tab that is already fully visible leaves `scrollLeft` unchanged.
3. The correct terminal remains active and receives focus.
4. Clicking a clipped pinned panel centers its tab, while clicking a pinned panel from another project does not switch the project or strip.
5. The project's existing test command still passes.

## Out of scope

- Remembering a separate scroll position per project.
- Centering every visible tab on activation.
- Adding smooth scrolling or other motion.
- Adding blank leading or trailing space solely to make edge tabs mathematically centered.
