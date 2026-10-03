import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CanonicalChat } from "../src/core/chat.js";
import { EventStore } from "../src/core/events.js";

const tick = async (): Promise<void> => { await Promise.resolve(); };

describe("semantic event replay", () => {
  it("allocates new runtime identities and rejects handles from a prior runtime", () => {
    const first = new EventStore();
    const restarted = new EventStore();
    first.add({ type: "chat.player", text: "hello" });
    expect(first.runtimeId).not.toBe(restarted.runtimeId);
    expect(() => restarted.query(first.getCursor())).toThrow(expect.objectContaining({ code: "RUNTIME_MISMATCH" }));
    expect(() => first.query(1)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    expect(() => first.query(`${first.runtimeId}:s900`)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
  });

  it("reports sparse retention gaps by the requested types", () => {
    const events = new EventStore({ maxEvents: 1, retention: { "chat.player": 4 } });
    events.add({ type: "entity.appeared", trackId: "one" });
    const chat = events.add({ type: "chat.player", text: "retained" });
    events.add({ type: "entity.appeared", trackId: "two" });
    expect(events.query(0)).toMatchObject({ gap: true, expiredTypes: ["entity.appeared"] });
    expect(events.query(0, 50, ["chat.player"])).toMatchObject({ gap: false, expiredTypes: [], events: [chat] });
    expect(events.query(chat.cursor)).toMatchObject({ gap: false, expiredTypes: [] });
  });

  it("does not advance pagination past unread events", () => {
    const events = new EventStore();
    const a = events.add({ type: "chat.player", text: "one" });
    events.add({ type: "entity.appeared" });
    const b = events.add({ type: "chat.player", text: "two" });
    events.add({ type: "action.failed", reason: "TRACK_LOST" });
    const first = events.query(0, 1, ["chat.player"]);
    expect(first.nextCursor).toBe(a.cursor);
    expect(first.latestCursor).toBe(events.getCursor());
    const second = events.query(first.nextCursor, 1, ["chat.player"]);
    expect(second.events).toEqual([b]);
    expect(second.nextCursor).toBe(b.cursor);
    const exhausted = events.query(second.nextCursor, 1, ["chat.player"]);
    expect(exhausted.events).toEqual([]);
    expect(exhausted.nextCursor).toBe(events.getCursor());
  });

  it("keeps longer chat and failure retention and never exposes raw payloads in replay", () => {
    const events = new EventStore({ maxEvents: 1, debugLimit: 1 });
    const raw = { packet: { value: 1 } };
    events.add({ type: "chat.player", text: "one", raw });
    events.add({ type: "chat.player", text: "two" });
    events.add({ type: "action.failed", reason: "TRACK_LOST" });
    events.add({ type: "action.failed", reason: "WORLD_CHANGED" });
    expect(events.query().events).toHaveLength(4);
    expect(events.query().events.every(event => !("raw" in event))).toBe(true);
    raw.packet.value = 2;
    expect(events.getDebug()[0]?.raw).toEqual({ packet: { value: 1 } });
  });

  it("detaches inputs, subscriber records, query results, and debug records", () => {
    const events = new EventStore();
    const detail = { nested: { health: 20 } };
    events.subscribe(event => { (event.detail as typeof detail).nested.health = 10; });
    const event = events.add({ type: "self.damaged", detail, raw: detail });
    detail.nested.health = 1;
    (event.detail as typeof detail).nested.health = 2;
    (events.getDebug()[0]!.raw as typeof detail).nested.health = 3;
    expect(events.query().events[0]?.detail).toEqual({ nested: { health: 20 } });
    expect(events.getDebug()[0]?.raw).toEqual({ nested: { health: 20 } });
  });

  it("disconnects a failed subscriber and serializes protocol bigint values", () => {
    const events = new EventStore();
    let calls = 0;
    events.subscribe(() => { calls++; throw new Error("stream closed"); });
    expect(() => events.add({ type: "server.message", raw: { timestamp: 1n } })).not.toThrow();
    events.add({ type: "server.message" });
    expect(calls).toBe(1);
    expect(JSON.stringify(events.getDebug())).toContain('"timestamp":"1"');
  });
});

describe("canonical chat receipt", () => {
  function setup() {
    const events = new EventStore();
    const bot = new EventEmitter();
    const chat = new CanonicalChat(events, (username, senderUuid) => username === "Alex" ? { username, uuid: senderUuid, trackId: `${events.runtimeId}:p1` } : undefined);
    chat.attach(bot);
    return { bot, chat, events };
  }

  it.each(["message-first", "chat-first"])("correlates callbacks in %s order", async order => {
    const { bot, events } = setup();
    const json = { translate: "chat.type.text", with: [{ text: "Alex" }, { text: "hello" }] };
    if (order === "message-first") {
      bot.emit("message", json, "chat");
      bot.emit("chat", "Alex", "hello", json.translate, json);
    } else {
      bot.emit("chat", "Alex", "hello", json.translate, json);
      bot.emit("message", json, "chat");
    }
    await tick();
    expect(events.query().events).toHaveLength(1);
    expect(events.query().events[0]).toMatchObject({ type: "chat.player", text: "hello", sender: "Alex", channel: "player", senderIdentity: { trackId: `${events.runtimeId}:p1` } });
    expect(events.getDebug(events.query().events[0]!.messageId as string)).toHaveLength(1);
  });

  it("preserves identical messages, including re-emitting the identical object", async () => {
    const { bot, events } = setup();
    const json = { text: "<Alex> hello" };
    for (let i = 0; i < 3; i++) {
      bot.emit("message", json, "chat");
      bot.emit("chat", "Alex", "hello", undefined, json);
    }
    await tick();
    expect(events.query().events).toHaveLength(3);
    expect(new Set(events.query().events.map(event => event.messageId)).size).toBe(3);
    bot.emit("message", json, "chat");
    bot.emit("chat", "Alex", "hello", undefined, json);
    await tick();
    expect(events.query().events).toHaveLength(4);
  });

  it("correlates a reused object with its current dispatch across different channels", async () => {
    const { bot, events } = setup();
    const json = { text: "same payload object" };
    bot.emit("message", json, "chat");
    bot.emit("chat", "Alex", "hello", undefined, json);
    bot.emit("message", json, "system");
    bot.emit("whisper", "Alex", "secret", undefined, json);
    await tick();
    expect(events.query().events).toEqual([
      expect.objectContaining({ type: "chat.player", text: "hello" }),
      expect.objectContaining({ type: "chat.whisper", text: "secret" }),
    ]);
  });

  it("joins multiple legacy patterns to one anchored receive record", async () => {
    const { bot, events } = setup();
    const json = { text: "<Alex> hello" };
    bot.emit("message", json, "chat");
    bot.emit("chat", "Alex", "hello", undefined, json);
    bot.emit("chat", "Alex", "hello", undefined, json);
    await tick();
    expect(events.query().events).toHaveLength(1);
  });

  it("does not deduplicate equal text across different receipt objects", async () => {
    const { bot, events } = setup();
    bot.emit("chat", "Alex", "hello", undefined, { text: "hello" });
    bot.emit("chat", "Alex", "hello", undefined, { text: "hello" });
    await tick();
    expect(events.query().events).toHaveLength(2);
  });

  it("classifies modern metadata without relying on legacy chat callbacks", async () => {
    const { bot, events } = setup();
    const senderUuid = "12345678-1234-1234-1234-123456789abc";
    bot.emit("message", { translate: "chat.type.text", with: [{ text: "Alex" }, { text: "hello" }] }, "chat", senderUuid, true);
    bot.emit("message", { translate: "commands.message.display.incoming", with: [{ text: "Alex" }, { text: "secret" }] }, "system", senderUuid);
    bot.emit("message", { text: "announcement" }, "system", null);
    await tick();
    expect(events.query().events).toEqual([
      expect.objectContaining({ type: "chat.player", text: "hello", attribution: "verified", senderIdentity: { username: "Alex", uuid: senderUuid, trackId: `${events.runtimeId}:p1` } }),
      expect.objectContaining({ type: "chat.whisper", text: "secret", channel: "whisper" }),
      expect.objectContaining({ type: "server.message", text: "announcement", attribution: "unknown", senderIdentity: {} }),
    ]);
  });

  it("gives whisper priority and flushes pending receipts at frame boundaries", () => {
    const { bot, chat, events } = setup();
    const json = { text: "Alex whispers: secret" };
    bot.emit("message", json, "system");
    bot.emit("chat", "Alex", "whispers: secret", undefined, json);
    bot.emit("whisper", "Alex", "secret", undefined, json);
    chat.flush();
    expect(events.query().events).toEqual([expect.objectContaining({ type: "chat.whisper", text: "secret", channel: "whisper", attribution: "pattern" })]);
    chat.dispose();
    bot.emit("chat", "Alex", "ignored");
    expect(events.query().events).toHaveLength(1);
  });
});
