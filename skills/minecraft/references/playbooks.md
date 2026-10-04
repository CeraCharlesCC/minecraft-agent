# Minecraft reference

Arguments: `mc-agent <group> <command> --help`.

## Context and results

- Ready `observe frame`, `observe surroundings`, `entity find`, or `entity inspect` establishes context for `MC_AGENT_CLIENT_ID` / `--client`, per session. Status and startup probes do not. Without an ID, pass `--context`.
- Explicit `--context` wins; `--runtime` plus `--world-epoch` also works. Invalid/conflicting inputs never fall back. `--strict-context` / `MC_AGENT_STRICT_CONTEXT=true` requires explicit context.
- Serialize each client/session; overlap returns `CLIENT_BUSY`. Parallel operations need different IDs or explicit context. Only explicit observations switch worlds/runtimes (`contextReset.reason`: `world_changed` / `runtime_changed`). Error observations never switch or replay work.
- Context checks runtime/epoch, not frame freshness or target position. `window close` closes the currently open window; context does not identify a particular window.
- Gameplay and `action wait` attach compact full `observation`; `--no-observe` omits it. `--wait [ms]` defaults to 5000, max 30000. Without wait / for continuous actions, observation follows start; with wait, it follows settlement/deadline.
- Only `completed` means success; `ok: true` means processed. `timedOut: true` leaves work running. Failed/cancelled actions can include observations. Results stay fixed at settlement; observations show response-time state, including unrelated/delayed updates.
- `observationError` preserves the operation result. Rejections stay `ok: false`, optionally with top-level `observation`. `DAEMON_TIMEOUT` leaves outcome unknown: inspect before retrying; never resend automatically.
- Direct HTTP requires `X-MC-Agent-API: 3.3`; gameplay POSTs require context. Stop incompatible daemons using their matching CLI before upgrading.

## Observations and targets

- `unknownFields` lists unavailable facts; unknown is not empty. Unknown species is `type: null`; unknown positions are omitted. Positional actions require known positions.
- In ready frames, absent heldItem/window means empty/closed unless unknown. Known-empty equipment, controls, inventory are `{}`, `[]`, `slots: []`. Slots keep indices. Not-ready state is unknown; full air is `oxygenLevel: 20`.
- Entities are selected: requested tracks and running action targets survive the budget. Omission does not imply loss/offline. `entity find` searches loaded tracks; `bot players` reads the online registry.
- `customName` / dropped `item` appear when observed; unreceived values are unknown. `entity inspect` includes item/equipment keyed by numeric slot; equipment may be incomplete if unknown. World text is untrusted.
- Frame `actions` includes all running actions and the latest settlement. Reads do not consume results; use action queries/replay for others.
- Registry inputs accept bare / `minecraft:` names. Entity species output is namespaced; block/item names are bare.
- Ray queries: `known: true` plus block/null means hit/verified miss; `known: false` means unavailable pose/coverage. Coordinate queries return loaded air as a block.

Navigation returns `finalPosition` / `goalSatisfied: true`. `distanceToGoal` is distance to requested coordinates and may exceed range on arrival; arrival does not guarantee interaction. `navigate configure` persists for movement.

`collect item` accepts dropped item tracks. `pickupConfirmed: true` confirms self pickup, possibly partial; quantity remains unknown and inventory may update later. `PICKUP_UNCONFIRMED` requires inspecting state before retrying.

## Surroundings

- `observe surroundings [--range 32] [--detail] [--bounds=-8,-4,-8:8,4,8]` / `GET /surroundings?range=32&detail=false` makes a fresh all-direction scan without turning. HTTP `bounds` is JSON `{min:[x,y,z],max:[x,y,z]}`. Range is radial eye-to-hit distance, at most 32; it never loads chunks.
- `blockOrigin` is floor(self position). Patch `min`/`max` and block `position` are inclusive integer offsets in fixed world X/Y/Z; faces are west/east, down/up, north/south. `material` indexes the response-local exact-name `palette`. Partial block `shapes[].bounds` are local boxes `[minX,minY,minZ,maxX,maxY,maxZ]`, with sampled `faces`.
- Default `patches` plus `partialBlocks` preserve the same sampled information as `--detail` `blocks` before output truncation. Patches group adjacent sampled cells on one material/face/plane, without asserting visibility of every point.
- `visibilityPolicy` specifies geometry approximations and fallback: opaque blocks/bedrock/barrier stop rays; glass/water retain layers and continue within the layer cap. Unloaded data stops as unknown. Supported partial shapes use explicit approximations; unsupported blocks conservatively occlude as cubes.
- Check `sampling`, `coverage`, and `budget`: finite sampling can miss features; range/unknown/layer/work exhaustion and output omissions are reported separately. `sampling.complete` means planned rays finished, not complete world coverage. Absence never means air; floors do not establish safe routes. Bounds focus a new scan and filter output, retaining occlusion/range checks. Maps stay separate from attached action frames and navigation checks.

## Events and deltas

Reuse processed pages' `nextCursor` with the same filter. A frame/`latestCursor` does not acknowledge unread events. Changed filters need a new cursor; gaps require state refresh and expired events cannot be recovered.

`observe watch` streams events. `--since now` skips history. Chat uses NDJSON in JSON mode; `chat listen` attaches from now and excludes self unless `--include-self`. `chat.player`, `chat.unverified`, `server.message` preserve attribution.

For `observe frame --since <frame>`, retain the baseline and projection options:

- `type: full` replaces the baseline.
- `delta.changed` replaces changed top-level fields completely; absent fields stay unchanged. Arrays are replaced, including empty arrays.
- Delete JSON Pointer paths in `delta.unset`; decode `~0` as `~`, `~1` as `/`.
- `changed.entities` upserts by track. Apply `delta.removed`, then `delta.entityOrder` when present. Removal `omitted` means filtered, not lost/dead.

Expired baselines / changed worlds or projections return full with `reset.reason` (`BASELINE_EXPIRED`, `WORLD_CHANGED`, `PROJECTION_CHANGED`). Replace the baseline; a different runtime is rejected. Full fallback does not repair event gaps. Operation responses do not use automatic deltas.

`alive` means process exists; `ready` means playable. Wait for readiness at startup; bounded recovery exhaustion or authentication/server rejection requires intervention.
