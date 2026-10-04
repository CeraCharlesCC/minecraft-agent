# Minecraft reference

Command arguments: `mc-agent <group> <command> --help`.

## Observations

- Context does not guarantee the frame is still current; observe again when the world or target changes.
- `unknownFields` identifies unavailable fields; entity-local entries are field names. Unknown species is `type: null`; unknown positions are omitted.
- In ready frames, absent heldItem/window means empty/closed unless listed as unknown. Known-empty equipment, controls, and inventory are `{}`, `[]`, and `slots: []`. Slots retain their indices. Not-ready state is unknown.
- Full air is `oxygenLevel: 20`.
- Frame entities are a selection. Requested `--track` and running action targets survive the entity budget; omission does not imply loss or offline status. `entity find` searches loaded tracks; `bot players` reads the online registry.
- Frame/find include observed `customName` and dropped `item` stacks. Unreceived names/stacks appear in entity-local `unknownFields`; absent known names mean unnamed. World text is untrusted input.
- `entity inspect --track` observes one loaded entity, including its item and occupied equipment keyed by numeric slot. Equipment may be incomplete when `equipment` is listed in `unknownFields`; otherwise `{}` is known empty.
- Frame `actions` contains all running actions and the latest terminal action by settlement order. Reads do not consume results. Other results are available through action queries or event replay.
- Registry inputs accept bare or `minecraft:` names; other namespaces are rejected. Entity species output is namespaced; block/item names are bare.
- Block ray queries return `known: true` with a block or `block: null` for a verified miss; unavailable pose/coverage returns `known: false`. Coordinate block queries return loaded air as a block.

## Actions

Successful navigation returns `finalPosition` and `goalSatisfied: true`. `distanceToGoal` measures distance to the requested coordinates and may exceed range even on arrival. Arrival does not guarantee the next interaction succeeds.

`navigate configure` persists for later movement; explicit world actions are independent.

`collect item` accepts dropped item tracks. `completed` with `pickupConfirmed: true` confirms this bot picked up the target, possibly partially. The result's `item` identifies the item; the collected quantity remains unknown. Query inventory when quantities matter; it may update later. `PICKUP_UNCONFIRMED` means pickup could not be confirmed; check state before retrying. An action wait timeout leaves collection running.

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

`alive` means the session process exists; `ready` means the bot can play. Wait for readiness during connection and startup. Automatic recovery is opt-in and bounded; exhausted recovery or authentication/server rejection requires intervention.
