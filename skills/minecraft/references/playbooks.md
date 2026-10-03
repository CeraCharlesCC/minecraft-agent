# Minecraft agent playbooks

Use these examples only for multi-step tasks. For exact flags, run `mc-agent <group> <command> --help` against the installed version.

All physical examples assume `runtimeId`, `worldEpoch`, and entity tracks were copied from a recent `observe frame`.

## Monitor chat

Start from the last processed replay cursor, or `0` for a new consumer:

```bash
mc-agent --output json observe events --session default --since 0 --limit 50 \
  --type chat.player --type chat.whisper --type server.message
```

After processing a page, continue from its `nextCursor`:

```bash
mc-agent --output json observe events --session default --since <nextCursor> --limit 50 \
  --type chat.player --type chat.whisper --type server.message
```

For a long-lived consumer, stream from the same processed cursor:

```bash
mc-agent observe watch --session default --since <nextCursor> \
  --type chat.player --type chat.whisper --type server.message --output json
```

React only to events relevant to the user's requested trigger. If replay reports a gap, refresh current state with `observe frame`; expired chat cannot be reconstructed.

## Follow a loaded player

```bash
mc-agent --output json observe frame --session default
mc-agent --output json navigate follow --session default \
  --track <playerTrack> --range 2 \
  --runtime <runtimeId> --world-epoch <worldEpoch>
mc-agent --output json action status --session default --action <returnedAction>
```

A running follow action is expected. If the track is lost or the action fails, observe again before starting another follow action.

Stop following with current runtime/world context:

```bash
mc-agent --output json navigate stop --session default \
  --runtime <runtimeId> --world-epoch <worldEpoch>
```

## Build a small shape

Inspect inventory and each support location before placement:

```bash
mc-agent --output json observe frame --session default
mc-agent --output json bot inventory --session default
mc-agent --output json world block --session default --x <supportX> --y <supportY> --z <supportZ>
mc-agent --output json world place --session default \
  --x <supportX> --y <supportY> --z <supportZ> --face up --item dirt \
  --runtime <runtimeId> --world-epoch <worldEpoch>
mc-agent --output json world block --session default --x <placedX> --y <placedY> --z <placedZ>
```

For larger builds, place incrementally and re-observe representative blocks instead of assuming earlier state remains valid.

## Harvest and replant crops

```bash
mc-agent --output json observe frame --session default
mc-agent --output json bot inventory --session default
mc-agent --output json world find-blocks --session default --name wheat --radius 32 --count 50
mc-agent --output json world block-info --session default --x <cropX> --y <cropY> --z <cropZ>
mc-agent --output json world dig --session default \
  --x <cropX> --y <cropY> --z <cropZ> \
  --runtime <runtimeId> --world-epoch <worldEpoch>
mc-agent --output json world place --session default \
  --x <farmlandX> --y <farmlandY> --z <farmlandZ> --face up --item wheat_seeds \
  --runtime <runtimeId> --world-epoch <worldEpoch>
```

Check crop properties before harvesting and verify the required seed is available before replanting.

## Transfer items through a container

```bash
mc-agent --output json observe frame --session default
mc-agent --output json world block-info --session default --x <x> --y <y> --z <z>
mc-agent --output json window open-block --session default \
  --x <x> --y <y> --z <z> \
  --runtime <runtimeId> --world-epoch <worldEpoch>
mc-agent --output json window status --session default
mc-agent --output json window deposit --session default --item dirt --count 64 \
  --runtime <runtimeId> --world-epoch <worldEpoch>
mc-agent --output json window close --session default \
  --runtime <runtimeId> --world-epoch <worldEpoch>
```

Use `window click` only when a task specifically requires raw slot interaction; it is not an extra step after `deposit` or `withdraw`.

## Recover from a failed command

Read the structured `error.code`, `error.remediation`, and `error.details` when present. Re-observe after stale tracks, changed world context, replay gaps, or frame-reset errors. Do not repeat an identical failed physical command without new state or changed inputs.
