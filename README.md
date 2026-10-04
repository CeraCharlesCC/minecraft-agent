# minecraft-agent

`mc-agent` controls a Minecraft bot through [Mineflayer](https://github.com/PrismarineJS/mineflayer). A local daemon maintains the session between commands. Requires Node.js ≥22.12.0.

```sh
npm install -g minecraft-agent
mc-agent session start --host localhost --username AgentBot --auth offline --auto-reconnect
mc-agent --output json observe frame
```

Copy the observation's `data.context` into physical commands. Use `entity find` to obtain a loaded `trackId` for entity targets; pass handles unchanged.

```sh
mc-agent --output json navigate goto --x <x> --y <y> --z <z> --context <context> --wait 10000
mc-agent --output json observe frame
```

Check the action state before dependent work: `completed` is success; `ok: true` means the request was processed. `timedOut: true` leaves work running; use `action status` or wait again. Re-observe after stale-target errors or reconnection. Navigation starts with digging and placement disabled.

Use `observe frame` for current state, `--detail full` for extra game state, or a one-point query such as `bot position`. Respect `connection.ready`, `inventory.known`, and `unknownFields`: unknown state is not empty. In ready frames, absent heldItem/window means empty/closed unless listed as unknown.

With `--auto-reconnect`, the daemon handles bounded recovery. Observe connection/recovery state and report required intervention. A `DAEMON_TIMEOUT` operation may already have executed; inspect action/state before retrying. Operators can use `session diagnose`, `session ensure-ready`, and `session status --detail full`.

Discover commands with `mc-agent <group> <command> --help`. Use `--session <name>` for another session, `--minecraft-version <version>` to select the protocol, and `session stop` to disconnect.

The public API is v3. Before upgrading, stop live sessions with their matching CLI and confirm `stopped: true`; then update, restart, and observe fresh context. Mixed CLI/daemon versions return `DAEMON_INCOMPATIBLE`.

For agents: [minecraft skill](skills/minecraft/SKILL.md) or `mc-agent skills get core`. Schema, events, optional deltas, and recovery details: [reference](skills/minecraft/references/playbooks.md) or `mc-agent skills get core --full`.

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`npm run measure:projection` compares synthetic response sizes with the pinned v2 baseline; it requires this checkout's git history. These measurements do not measure live-server performance.

MIT · [LICENSE](LICENSE)
