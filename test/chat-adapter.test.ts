import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CanonicalChat } from "../src/core/chat.js";
import { EventStore } from "../src/core/events.js";

const require = createRequire(import.meta.url);
const ALEX_UUID = "12345678-1234-1234-1234-123456789abc";
const SELF_UUID = "aabbccdd-1122-3344-5566-778899aabbcc";
function adapter() {
  const registry = require("prismarine-registry")("1.21.4");
  const bot = Object.assign(new EventEmitter(), {
    registry, username: "AgentBot", entity: { uuid: SELF_UUID },
    supportFeature: registry.supportFeature, _client: new EventEmitter(),
  });
  require("mineflayer/lib/plugins/chat.js")(bot, {});
  const events = new EventStore();
  const chat = new CanonicalChat(events, (username, uuid) => {
    if (uuid === ALEX_UUID || username === "Alex") return { username: "Alex", uuid: ALEX_UUID, trackId: `${events.runtimeId}:p1` };
    if (uuid === SELF_UUID || username === "AgentBot") return { username: "AgentBot", uuid: SELF_UUID };
    return undefined;
  });
  chat.attach(bot);
  return { bot, chat, events };
}

describe("installed Mineflayer chat adapter", () => {
  it("attributes outgoing whisper echoes to self and incoming whispers to the sender without merging repeated packets", () => {
    const { bot, chat, events } = adapter();
    for (const direction of ["outgoing", "incoming", "incoming"]) {
      bot._client.emit("systemChat", { positionId: 1, formattedMessage: JSON.stringify({
        translate: `commands.message.display.${direction}`, with: [{ text: "Alex" }, { text: "secret" }],
      }) });
    }
    chat.flush();
    expect(events.query().events).toEqual([
      expect.objectContaining({ type: "chat.whisper", text: "secret", direction: "outgoing", sender: "AgentBot",
        senderIdentity: { username: "AgentBot", uuid: SELF_UUID },
        recipientIdentity: { username: "Alex", uuid: ALEX_UUID, trackId: `${events.runtimeId}:p1` }, attribution: "structured" }),
      expect.objectContaining({ type: "chat.whisper", text: "secret", direction: "incoming", sender: "Alex", attribution: "structured" }),
      expect.objectContaining({ type: "chat.whisper", text: "secret", direction: "incoming", sender: "Alex", attribution: "structured" }),
    ]);
    expect(new Set(events.query().events.map(e => e.messageId)).size).toBe(3);
  });

  it.each(["chat.type.team.text", "chat.type.team.sent"])("reads the sender after the team in %s and preserves signed UUID identity", translation => {
    const { bot, chat, events } = adapter();
    const ChatMessage = require("prismarine-chat")(bot.registry);
    const message = new ChatMessage({ translate: translation, with: [{ text: "Builders" }, { text: "Alex" }, { text: "bring stone" }] });
    bot.emit("message", message, "chat", ALEX_UUID, true);
    // An overlapping broad legacy pattern must not replace structured attribution.
    bot.emit("chat", "Builders", "Alex bring stone", translation, message);
    chat.flush();
    expect(events.query().events).toEqual([expect.objectContaining({
      type: "chat.player", sender: "Alex", text: "bring stone", team: "Builders",
      direction: translation.endsWith("sent") ? "outgoing" : "incoming", attribution: "verified", verified: true,
      senderIdentity: { username: "Alex", uuid: ALEX_UUID, trackId: `${events.runtimeId}:p1` },
    })]);
  });

  it("joins the installed legacy chat pattern to one structured receipt", () => {
    const { bot, chat, events } = adapter();
    bot._client.emit("systemChat", { positionId: 1, formattedMessage: JSON.stringify({
      translate: "chat.type.text", with: [{ text: "Alex" }, { text: "hello" }],
    }) });
    chat.flush();
    expect(events.query().events).toEqual([expect.objectContaining({ type: "chat.player", sender: "Alex", text: "hello", attribution: "structured" })]);
    expect(events.getDebug()[0].raw).toHaveProperty("chat");
  });
});
