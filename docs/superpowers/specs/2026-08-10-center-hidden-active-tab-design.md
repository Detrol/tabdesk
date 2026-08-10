# Center Hidden Active Tab

## Goal

When activating a session tab that is outside the session strip's visible horizontal viewport, bring it toward the center instead of revealing only its nearest edge. Keep the strip still when the active tab is already fully visible.

## Interaction

- A fully visible active session tab does not change the strip's scroll position.
- An active session tab that is clipped on either side is brought as close to the horizontal center as the strip's scroll bounds allow.
- Scrolling is immediate and unanimated.
- Overview and `+` controls retain their current order and behavior.

## Implementation

After `setActive()` applies the layout, compare the active tab's bounding rectangle with the strip's bounding rectangle. If the tab is not fully contained, call the browser's native `scrollIntoView()` with nearest block alignment and centered inline alignment. No dependency, persisted scroll state, animation, or additional layout spacer is introduced.

The check remains in `setActive()` so every activation path receives the same visibility guarantee, including project selection, direct tab clicks, tray selection, restoration, and newly created sessions.

## Verification

Use a separate TabDesk instance with an isolated projects directory, tmux socket directory, browser profile, and debug port. Verify that:

1. Switching from a shorter project back to a project whose active tab is outside the viewport brings that tab toward the center.
2. Activating a tab that is already fully visible leaves `scrollLeft` unchanged.
3. The correct terminal remains active and receives focus.
4. The project's existing test command still passes.

## Out of scope

- Remembering a separate scroll position per project.
- Centering every visible tab on activation.
- Adding smooth scrolling or other motion.
- Adding blank leading or trailing space solely to make edge tabs mathematically centered.
