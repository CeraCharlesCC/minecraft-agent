# minecraft-agent

`mc-agent` controls a Minecraft bot through [Mineflayer](https://github.com/PrismarineJS/mineflayer). A local daemon keeps the session between commands. Requires Node.js ≥22.12.0.

```sh
npm install -g minecraft-agent
mc-agent session start --host localhost --username AgentBot --auth offline --auto-reconnect
mc-agent --output json observe frame
```

`session start` streams new chat after startup; keep its process handle and run gameplay commands separately. Use `--no-listen` for one startup response or `chat listen` to attach. Closing the listener leaves the daemon running; `session stop` disconnects.

Copy the observation's `data.context` into physical commands. Entity targets require a loaded `trackId` from `entity find`; pass handles unchanged.

```sh
mc-agent --output json navigate goto --x <x> --y <y> --z <z> --context <context> --wait 10000
mc-agent --output json observe frame
```

Before dependent work, check action state: `completed` is success; `ok: true` means processed. `timedOut: true` leaves work running. Navigation starts with digging/placement disabled.

Arguments: `mc-agent <group> <command> --help`. Agent loop: [skill](skills/minecraft/SKILL.md) or `skills get core`. Observation, action, replay, delta, and upgrade contracts: [reference](skills/minecraft/references/playbooks.md) or `skills get core --full`.

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`npm run measure:projection` compares synthetic response sizes with the pinned v2 baseline and requires this checkout's git history.

MIT · [LICENSE](LICENSE)
