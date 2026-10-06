# Minecraft Agent

A stateful Minecraft CLI for agents, powered by [Mineflayer](https://github.com/PrismarineJS/mineflayer). `mc-agent` keeps a bot connected between commands and provides structured observations and actions for navigation, inventory, and world interaction.

## Quick start

Requires **Node.js ≥22.12.0** and a Minecraft server the bot can join.

```sh
npm install -g @ceracharlescc/minecraft-agent
```

Connect to a local server with offline authentication and inspect the bot's state:

```sh
mc-agent session start --host localhost --username AgentBot --auth offline --no-listen
mc-agent --output json observe frame
mc-agent session stop
```

## Documentation

- [Agent skill](skills/minecraft/SKILL.md) — operating instructions for agents.
- [Command reference](skills/minecraft/references/playbooks.md) — command syntax, options, and behavior.

The full guide is also available from the CLI via `mc-agent skills get core --full`.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
```

After changing CLI definitions or guidance, run `npm run docs:generate` to refresh the bundled syntax and skill/reference files.

## Credits and license

Fork of [justjavac/minecraft-agent](https://github.com/justjavac/minecraft-agent), maintained by [CeraCharlesCC](https://github.com/CeraCharlesCC). [Source](https://github.com/CeraCharlesCC/minecraft-agent) · [Issues](https://github.com/CeraCharlesCC/minecraft-agent/issues).

Released under the [MIT License](LICENSE).
