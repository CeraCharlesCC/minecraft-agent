# Minecraft reference

Use command-specific `--help` for arguments.

## Events

Read `observe events --profile agent --since 0`, then reuse each processed page's `nextCursor`. Keep a cursor per fixed filter. Changing filters needs a new starting cursor. A frame cursor or `latestCursor` does not acknowledge unread events. On gaps, refresh the frame; expired chat remains unavailable.

`observe watch --profile agent --since <nextCursor>` streams the subscription. Replay after overflow/disconnection and preserve gap notices. `chat.player`, `chat.unverified` (candidate sender), and `server.message` retain their provenance; server/plugin notices remain visible. Legitimate repeated chat is not deduplicated.

## Frames

Default compact frames show 12 ordinary entities plus requested/action targets. Use `--track` to preserve a target, including with `--max-entities 0`, or `--detail full` for extra game/investigation fields. `entity find` searches all loaded tracks. Omitted players are not offline; use `bot players` for the online registry. One-point position/inventory/entity queries remain available.

Compact self includes position, yaw/pitch (including 0), health, food, oxygen, held item, occupied equipment, and active controls. Slots retain their original numbers. Ready frames preserve known-empty equipment `{}`, controls `[]`, and inventory `slots: []`. Absent heldItem/window means empty/closed unless its path appears in `unknownFields`; an unavailable ready field is unknown. Not-ready observations do not carry last body/held/window values as current; inventory has `known: false`. These rules apply to full observations in either detail mode. Full detail is not a raw object or authentication dump.

Optional `observe frame --since <frame>` compares projected public snapshots. Results declare `type: full` or `type: delta`. Keep the same projection options. `delta.changed` replaces changed top-level fields completely: replace self rather than recursively merging it, so a removed heldItem disappears. Missing delta fields mean unchanged. Delete JSON Pointer paths in `delta.unset` (for example `/window`); pointer escapes are `~0` for `~` and `~1` for `/`. Arrays are replaced completely, including empty slots/controls. `changed.entities` upserts by track; `delta.removed` reports `omitted`, `lost`, or `dead`. Apply entity removals/upserts, then reorder to the track IDs in `delta.entityOrder` when present. Applying a baseline's delta must reproduce the full frame under the same projection. Omitted means filtered, not target loss.

Baseline expiration, world reset, or projection change returns a compact full frame with `reset.reason` (`BASELINE_EXPIRED`, `WORLD_CHANGED`, or `PROJECTION_CHANGED`). Replace the baseline and continue with compact detail (the default), even if the previous request used full detail. A different runtime is rejected. Full fallback does not repair event gaps or recreate expired chat.

## Actions and recovery

Bare `--wait` waits 5 seconds; the maximum is 30 seconds. Ordinary requests have a 5-second communication deadline; timeout leaves the outcome unknown.

Successful `navigate goto` returns `completionReason` (`within_range` or `already_within_range`), goal/range, finalPosition, and distanceToGoal at settlement. Success follows the navigation goal condition, not exact-coordinate arrival; it does not guarantee a subsequent interaction. Continuous follow/look remains running.

`navigate configure --allow-dig --allow-place` persists for later movement. Reset with `--no-dig --no-place`. Explicit `world dig/place` are independent.

Automatic recovery is an explicit startup policy (`session start --auto-reconnect`); agent harnesses enable it. Retry budgets are finite, carry across short reconnects, and rearm only after 30 seconds continuously ready or explicit operator resumption. Authentication intervention, server rejection, stopping, and terminal failure require intervention. Not-ready actions are rejected, not queued; old actions and uncertain POSTs are not replayed. Use a known action ID with status/wait; otherwise retain outcome uncertainty. Recovery needs fresh context.

`session diagnose` and `session ensure-ready --timeout 30000` are explicit operator/test tools. `session status --detail full` exposes operational metadata while account identifiers and secrets stay private. Alive and ready are distinct. Select Minecraft's protocol with `session start --minecraft-version <version>`.

API v3 uses `X-MC-Agent-API: 3`; mixed versions fail with `DAEMON_INCOMPATIBLE`. Before upgrading, stop live sessions with their matching CLI and confirm `stopped: true`; then update, restart, and observe fresh context.
