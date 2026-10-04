# Minecraft reference

Command arguments: `mc-agent <group> <command> --help`.

## Observations

- Context validates runtime/world epoch; it does not guarantee the frame is still current.
- `unknownFields` identifies unavailable fields; entity-local entries are field names. Unknown species is `type: null`; unknown positions are omitted.
- In ready frames, absent heldItem/window means empty/closed unless listed as unknown. Known-empty equipment, controls, and inventory are `{}`, `[]`, and `slots: []`. Slots retain their indices. Not-ready state is unknown.
- `oxygenLevel` is rounded air supply / 15 (full air = 20).
- Frame entities are a selection. Requested `--track` and running action targets survive the entity budget; omission does not imply loss or offline status. `entity find` searches loaded tracks; `bot players` reads the online registry.
- Frame `actions` contains all running actions and the latest terminal action by settlement order. Reads do not consume results. Other results are available through action queries or event replay.
- Registry inputs accept bare or `minecraft:` names; other namespaces are rejected. Entity species output is namespaced; block/item names are bare.
- Block ray queries return `known: true` with a block or `block: null` for a verified miss; unavailable pose/coverage returns `known: false`. Coordinate block queries return loaded air as a block.

## Actions

Successful navigation returns settlement-time `finalPosition` and `goalSatisfied: true`. `goalMetricDistance <= range` uses `block_node_euclidean` with `effectiveGoal` and `goalNode`. `distanceToGoal` uses `euclidean_to_requested_position` and may exceed range. Arrival does not guarantee the next interaction succeeds.

`navigate configure` persists for later movement; explicit world actions are independent.

Not-ready actions are rejected.

## Events

Reuse each processed page's `nextCursor` with the same filter. A frame cursor or `latestCursor` does not acknowledge unread events. Changed filters need a new starting cursor. On gaps, refresh state; expired events cannot be recovered.

`observe watch` streams events. `--since now` skips prior history, including disconnected history when reconnecting with now.

Chat streams use NDJSON in JSON mode. `chat listen` attaches from now and excludes self/outgoing echoes unless `--include-self` is set. `chat.player`, `chat.unverified`, and `server.message` preserve attribution.

## Optional deltas

Keep the baseline and projection options for `observe frame --since <frame>`.

- `type: full` replaces the baseline.
- `delta.changed` replaces changed top-level fields completely; absent fields are unchanged. Arrays are replaced, including empty arrays.
- Delete JSON Pointer paths in `delta.unset`; decode `~0` as `~` and `~1` as `/`.
- `changed.entities` upserts by track. Apply `delta.removed` and then `delta.entityOrder` when present. Removal `omitted` means filtered, not lost/dead.

Expired baselines, changed worlds/projections return a compact full frame with `reset.reason` (`BASELINE_EXPIRED`, `WORLD_CHANGED`, `PROJECTION_CHANGED`). Replace the baseline and use compact detail for subsequent deltas. A different runtime is rejected. Full fallback does not repair event gaps.

## Sessions

`alive` means the daemon process exists; `ready` means the bot can play. Automatic recovery is opt-in and bounded; exhausted recovery or authentication/server rejection requires intervention. Operators use `session diagnose` / `session ensure-ready`.

API v3.1 uses `X-MC-Agent-API: 3.1`; mixed versions return `DAEMON_INCOMPATIBLE`. Before upgrading, stop with the matching CLI and confirm `stopped: true`; restart and obtain fresh context.
