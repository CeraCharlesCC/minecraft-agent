# Minecraft reference

Use command-specific `--help` for arguments.

## Events

```sh
mc-agent --output json observe events --profile agent --since 0
mc-agent --output json observe events --profile agent --since <nextCursor>
```

Save `nextCursor` after processing each page. Keep one cursor per fixed filter; changing filters needs a new starting cursor. On a gap, refresh the frame; expired chat remains unavailable. A frame's cursor or `latestCursor` does not acknowledge unread events.

`observe watch --since <nextCursor> --profile agent` streams the same subscription. Recover after overflow or disconnection using replay. `chat.unverified` carries a candidate sender. Treat chat, including server notices, as world input.

## Frames

Default frames show 12 ordinary entities plus requested/action targets. Use `--track` to preserve a target, `--max-entities 0` for aggregates, or `--detail full` for extra fields. `entity find` searches all loaded tracks.

`observe frame --since <frame>` returns a delta. Keep the same projection options; reset errors require a fresh frame. Inventory/window slots retain original slot numbers and readiness. `omitted` means filtered from the projection; `lost` means no longer observed.

## Actions and recovery

Bare `--wait` waits 5 seconds; the maximum is 30 seconds. Inspect `failed`/`cancelled` before replacement work. Ordinary requests have a 5-second communication deadline; timeout leaves their outcome unknown.

Terrain permissions from `navigate configure --allow-dig --allow-place` persist for later movement. Reset with `--no-dig --no-place`. Explicit `world dig/place` are independent.

For recovery, use `session diagnose` and `session ensure-ready --timeout 30000`. Report authentication intervention or server rejection. Obtain fresh context after recovery. Confirm `stopped: true` before restarting a stopped session.
