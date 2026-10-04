# @ceracharlescc/minecraft-agent

Fork of [justjavac/minecraft-agent](https://github.com/justjavac/minecraft-agent), maintained by [CeraCharlesCC](https://github.com/CeraCharlesCC). Source and issues: [CeraCharlesCC/minecraft-agent](https://github.com/CeraCharlesCC/minecraft-agent).

`mc-agent` controls a persistent [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot. Requires Node.js ≥22.12.0.

```sh
npm install -g @ceracharlescc/minecraft-agent
export MC_AGENT_CLIENT_ID=player-one # stable per actor; normally set by the harness
mc-agent session start --host localhost --username AgentBot --auth offline --auto-reconnect
mc-agent --output json observe frame
mc-agent --output json navigate goto --x 10 --y 64 --z 5 --wait 10000
# Read data.state and data.observation before choosing the next action.
```

Ready frame/surroundings/find/inspect saves context for that client/session. Without a client ID, or with `--strict-context`, pass `--context`. `--no-observe` omits the attached frame. Only `completed` means success; `timedOut: true` leaves the action running. After world changes, explicitly observe again.

`session start` streams chat; retain its process handle. Use `--no-listen` to return once or `chat listen` to attach. Closing a listener leaves the daemon running; `session stop` disconnects.

`observe frame` reports inventory, controls, the current window, and the observed vehicle. Use `entity interact` to right-click, `entity mount` for confirmed riding, and `action stop` to stop resource owners and clear controls.

Arguments: `mc-agent <group> <command> --help`. Agent loop: [skill](skills/minecraft/SKILL.md) or `skills get core`. Contracts: [reference](skills/minecraft/references/playbooks.md) or `skills get core --full`.

Nearby surfaces: `mc-agent observe surroundings [--range 32] [--detail] [--bounds=-8,-4,-8:8,4,8]`. This fresh scan uses fixed world axes; omitted surfaces mean unobserved, and visible floors do not establish safe routes.

Development: `npm ci`, `npm test`, `npm run typecheck`, `npm run build`.

MIT · [LICENSE](LICENSE)
