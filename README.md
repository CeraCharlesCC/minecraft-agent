# minecraft-agent

`mc-agent` controls a Minecraft bot through [Mineflayer](https://github.com/PrismarineJS/mineflayer). A local daemon maintains the session between commands. Requires Node.js ≥22.12.0.

```sh
npm install -g minecraft-agent
mc-agent session start --host localhost --username AgentBot --auth offline
mc-agent --output json observe frame
```

Copy the frame's `data.context` into physical commands and use loaded `trackId` values for entity targets:

```sh
mc-agent --output json navigate goto --x <x> --y <y> --z <z> --context <context> --wait 10000
mc-agent --output json observe frame
```

Check the action state before dependent work. `completed` is success; `timedOut: true` leaves work running. Re-observe after stale-target errors or reconnection. Navigation starts with digging and placement disabled.

Discover commands with `mc-agent <group> <command> --help`. Use `--session <name>` for another session, `--minecraft-version <version>` to select the protocol, and `session stop` to disconnect.

For agents: [minecraft skill](skills/minecraft/SKILL.md) or `mc-agent skills get core`. Replay and delta details: `mc-agent skills get core --full`.

```sh
npm ci
npm test
npm run typecheck
npm run build
```

MIT · [LICENSE](LICENSE)
