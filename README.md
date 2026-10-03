# minecraft-agent

[![coverage](https://img.shields.io/codecov/c/github/justjavac/minecraft-agent/main?label=coverage)](https://codecov.io/gh/justjavac/minecraft-agent)

`minecraft-agent` provides `mc-agent`, a CLI for controlling a Minecraft bot through [mineflayer](https://github.com/PrismarineJS/mineflayer). A local daemon keeps the bot connected while agents inspect state, read events, and perform bounded in-world actions.

The repository also includes a `minecraft` skill for agents that need a compact operating guide for `mc-agent`.

## Features

- Persistent local bot sessions
- JSON frames for bot, entity, inventory, window, navigation, and action state
- Runtime-scoped entity tracks and world guards for physical actions
- Replayable semantic events with cursors and gap reporting
- Managed actions for movement and other asynchronous work
- Commands for chat, navigation, inventory, blocks, entities, and containers

## Requirements

- Node.js `>=22.12.0`
- npm
- A Minecraft server

Local/offline servers are the default development and test target.

## Install

```bash
npm install -g minecraft-agent
mc-agent --help
```

Install the agent skill separately after it is available on [skills.sh](https://www.skills.sh):

```bash
npx skills add justjavac/minecraft-agent
```

## Quick start

Start a local offline session:

```bash
mc-agent --output json session start \
  --session default \
  --host localhost \
  --port 25565 \
  --username AgentBot \
  --auth offline
```

Inspect the session and current world state:

```bash
mc-agent --output json session status --session default
mc-agent --output json observe frame --session default
mc-agent --output json observe events --session default --since 0 --limit 50
```

Send chat, then stop the session:

```bash
mc-agent --output json chat send --session default --message "I am online."
mc-agent --output json session stop --session default
```

Use command-specific help for exact flags:

```bash
mc-agent observe frame --help
mc-agent navigate follow --help
mc-agent window deposit --help
```

## Runtime model

A frame is a coherent local observation of the connected bot, not a server-wide snapshot. It includes the current `runtimeId`, `worldEpoch`, frame handle, event cursor, bot state, loaded entity tracks, inventory, window, and managed actions.

Frame `actions` contain summaries of all running actions and the eight most recently settled actions, including targets, state, reason, and error code. Results and error details are available through `action status`; the runtime retains up to 256 settled action records. Navigation goals contain `kind`, finite scalar `parameters`, and an available target track instead of live entity data.

Runtime-scoped handles are valid only for the daemon instance that created them. A daemon restart invalidates frame, track, cursor, and action handles. World changes invalidate world-dependent state and actions.

Physical mutations require `--runtime` and `--world-epoch` values copied from a recent frame. Entity actions use loaded `--track` handles rather than guessed names or numeric entity IDs.

Commands that start managed work return an action ID. Inspect it with:

```bash
mc-agent --output json action status --session default --action <action>
```

Stop, clear, configuration, and cancellation commands may complete directly without creating a new action.

For semantic events, keep the returned `nextCursor` after processing a page and use it as the next `--since` value. Do not use `latestCursor` or a frame's `eventCursor` as an acknowledgement of unread events. If replay reports a gap, refresh current state with a frame and treat expired transient events as unavailable.

## Agent skill

The bundled skill lives in [`skills/minecraft`](skills/minecraft). Its entrypoint intentionally contains only the operating rules an agent needs at runtime. Multi-step examples are kept in [`skills/minecraft/references/playbooks.md`](skills/minecraft/references/playbooks.md).

The installed CLI can also print its runtime guide:

```bash
mc-agent skills get core
mc-agent skills get core --full
```

Prefer the installed CLI and command-specific `--help` output when exact behavior depends on the installed version.

## Guardrails

`mc-agent` enforces several mechanical checks at the CLI/runtime boundary:

- Physical mutations require current runtime/world context.
- Slash-prefixed chat requires `--allow-command`.
- Attacking players or passive mobs requires the corresponding explicit allow flag.
- Stale tracks and changed world context fail with structured errors instead of silently reusing old bindings.

These checks are mechanisms, not a substitute for deciding whether an action is appropriate for the user's task.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Useful development commands:

```bash
npm run dev -- --help
npm run dev -- --output json session list
```

Set `MC_AGENT_STATE_DIR` to isolate local session state and daemon logs during tests or development.

## License

MIT. See [LICENSE](LICENSE).
