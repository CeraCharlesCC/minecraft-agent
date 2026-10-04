import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import { EventStore } from "../src/core/events.js";
import { projectAction } from "../src/core/actions.js";
import { BotController } from "../src/daemon/bot.js";

class FakeBot extends EventEmitter {
  username: string | undefined = "AgentBot";
  entity = { position: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 0, height: 1.8 };
  world = { getBlock: (position: Vec3) => ({ name: "dirt", displayName: "Dirt", type: 3, position,
    shapes: [[0, 0, 0, 1, 1, 1]] as [number, number, number, number, number, number][] }) };
  entities = {
    "10": { id: 10, name: "cow", type: "mob", position: { x: 3, y: 2, z: 3 } },
    "12": { id: 12, name: "sniffer", type: "mob", position: { x: 5, y: 2, z: 3 } },
  };
  players = {
    Steve: { username: "Steve", entity: { id: 11, username: "Steve", type: "player", position: { x: 4, y: 2, z: 3 } } },
  };
  tablist = { header: "Welcome", footer: "Bye" };
  scoreboards = { main: { name: "main" } };
  scoreboard = { sidebar: { name: "main" } };
  teams = { red: { name: "red" } };
  teamMap = { Steve: "red" };
  game = { dimension: "overworld" };
  health = 20;
  food = 20;
  quickBarSlot = 0;
  controlState = { forward: false };
  heldItem = { name: "dirt", displayName: "Dirt" };
  inventory = {
    items: () => [
      { name: "dirt", displayName: "Dirt", count: 2, slot: 36 },
      { name: "coal", displayName: "Coal", count: 2, slot: 37 },
      { name: "lapis_lazuli", displayName: "Lapis Lazuli", count: 3, slot: 38 },
      { name: "iron_sword", displayName: "Iron Sword", count: 1, slot: 39 },
    ],
  };
  registry = {
    blocksByName: { dirt: { id: 3 }, wheat: { id: 59 } },
    itemsByName: { dirt: { id: 3 }, stick: { id: 280 }, coal: { id: 263 }, lapis_lazuli: { id: 351 }, iron_sword: { id: 267 } },
    entitiesByName: { cow: { category: "Passive mobs" }, sniffer: { category: "Passive mobs" } },
  };
  currentWindow = {
    id: 1,
    type: "minecraft:chest",
    title: { toString: () => "Chest" },
    containerItems: () => [{ name: "dirt", displayName: "Dirt", count: 4, slot: 0 }],
    deposit: vi.fn(),
    withdraw: vi.fn(),
    close: vi.fn(),
  };
  chat = vi.fn();
  whisper = vi.fn();
  tabComplete = vi.fn(async () => ["hello"]);
  quit = vi.fn();
  setControlState = vi.fn();
  clearControlStates = vi.fn();
  lookAt = vi.fn();
  look = vi.fn();
  blockAt = vi.fn((position: Vec3) =>
    position.x === 20
      ? { name: "wheat", displayName: "Wheat", type: 59, position, getProperties: () => ({ age: 7 }) }
      : { name: "dirt", displayName: "Dirt", type: 3, position },
  );
  blockInSight = vi.fn(() => ({ name: "dirt", displayName: "Dirt", type: 3, position: new Vec3(2, 2, 2) }));
  blockAtCursor = vi.fn(() => ({ name: "dirt", displayName: "Dirt", type: 3, position: new Vec3(3, 3, 3) }));
  canDigBlock = vi.fn(() => true);
  digTime = vi.fn(() => 250);
  findBlocks = vi.fn((options?: any) => (options?.matching === 59 ? [new Vec3(20, 64, 20)] : [new Vec3(1, 2, 3)]));
  equipCalls = vi.fn();
  equip = this.equipCalls;
  unequip = vi.fn();
  setQuickBarSlot = vi.fn();
  toss = vi.fn();
  consume = vi.fn();
  fish = vi.fn();
  activateItem = vi.fn();
  deactivateItem = vi.fn();
  recipesFor = vi.fn(() => [{ id: "recipe", result: { count: 4 } }]);
  craft = vi.fn();
  digCalls = vi.fn();
  dig = this.digCalls;
  stopDigging = vi.fn();
  placeBlockCalls = vi.fn();
  placeBlock = this.placeBlockCalls;
  placeEntity = vi.fn(async () => ({ id: 12, name: "boat", type: "object", position: { x: 1, y: 2, z: 3 } }));
  activateBlockCalls = vi.fn();
  activateBlock = this.activateBlockCalls;
  updateSign = vi.fn();
  sleep = vi.fn();
  wake = vi.fn();
  elytraFly = vi.fn();
  activateEntityCalls = vi.fn();
  activateEntity = this.activateEntityCalls;
  useOn = vi.fn();
  attack = vi.fn();
  swingArm = vi.fn();
  mount = vi.fn();
  dismount = vi.fn();
  moveVehicle = vi.fn();
  openContainer = vi.fn(async () => this.currentWindow);
  clickWindow = vi.fn();
  pathfinder = {
    searchRadius: -1,
    thinkTimeout: 5000,
    tickTimeout: 40,
    movements: { canDig: true, allowSprinting: true, allowParkour: true, canOpenDoors: false, maxDropDown: 4 } as never,
    setMovements: vi.fn(),
    goto: vi.fn(),
    setGoal: vi.fn(),
    stop: vi.fn(),
    isMoving: vi.fn(() => false),
    isMining: vi.fn(() => false),
    isBuilding: vi.fn(() => false),
  };
}

function controller() {
  const events = new EventStore();
  const bot = new FakeBot();
  const subject = new BotController(
    { host: "localhost", port: 25565, username: "AgentBot", auth: "offline" },
    events,
    () => bot,
  );
  subject.start();
  return { subject, bot, events };
}

describe("BotController", () => {
  it("returns actionable player and passive tracks from ready search and honors current bindings", async () => {
    const { subject, bot } = controller();
    Object.assign(bot.entities, { "11": bot.players.Steve.entity });
    Object.assign(bot.players, { Unloaded: { username: "Unloaded" } });
    expect(subject.findEntities({}).entities).toEqual([]);
    bot.emit("spawn");
    const found = subject.findEntities({ radius: 16 });
    expect(found.entities.map((item: any) => item.type)).toEqual(["minecraft:cow", "minecraft:player", "minecraft:sniffer"]);
    expect(found).toMatchObject({ context: expect.stringMatching(/^c2\./) });
    expect(found).not.toHaveProperty("runtimeId");
    const player = found.entities[1];
    subject.validateContext({ context: found.context });
    await subject.activateEntity(player.trackId);
    expect(bot.activateEntityCalls).toHaveBeenCalledWith(bot.players.Steve.entity);
    expect(() => subject.attackEntity(player.trackId)).toThrow("Refusing to attack a player");
    expect(subject.findEntities({ types: ["minecraft:sniffer"] }).entities).toEqual([expect.objectContaining({ type: "minecraft:sniffer" })]);
    bot.emit("entityGone", bot.players.Steve.entity);
    expect(subject.findEntities({ name: "Steve" }).entities).toEqual([]);
    expect(() => subject.world.resolveTrack(player.trackId)).toThrow("lost");
    bot.emit("end", "socketClosed");
    expect(subject.findEntities({}).entities).toEqual([]);
    expect(() => subject.validateContext({ context: found.context })).toThrow("World context has changed");
    subject.stop();
  });

  it("publishes only a validated game username obtained after login", () => {
    const bot = new FakeBot(); bot.username = "private-account@example.com";
    const subject = new BotController({ host: "private.server.example", port: 25565, username: bot.username, auth: "microsoft" }, new EventStore(), () => bot);
    subject.start();
    expect(subject.status()).not.toHaveProperty("username");
    expect(JSON.stringify(subject.status({ detail: "full" }))).not.toContain("private-account");
    bot.username = "GameAgent"; bot.emit("login");
    expect(subject.status()).toMatchObject({ username: "GameAgent", ready: false });
    bot.emit("error", Object.assign(new Error("private-account@example.com at private.server.example"), { code: "private-account@example.com" }));
    for (const response of [subject.status(), subject.diagnose()]) {
      expect(JSON.stringify(response)).not.toContain("private-account");
      expect(JSON.stringify(response)).not.toContain("private.server");
    }
    expect(subject.status().connection.cause?.code).toBe("CONNECTION_ERROR");
    subject.stop();
  });

  it("preserves score values, display text, and team formatting through explicit query projections", () => {
    const { subject, bot } = controller(); bot.emit("spawn");
    const scoreboard = { name: "points", title: "Team points", items: [{ name: "Steve", value: 0, displayName: { toString: () => "[Red] Steve" }, nbt: "PRIVATE" }], raw: "PRIVATE" };
    bot.scoreboards = { points: scoreboard } as any;
    const positions = Object.create({ get sidebar(): unknown { return (this as any)[1]; } }); positions[1] = scoreboard;
    bot.scoreboard = positions;
    const team = { team: "red", name: { toString: () => "Red team" }, prefix: { text: "[Red] " }, suffix: { text: "!" }, color: "red", members: ["Steve"], raw: "PRIVATE" };
    bot.teams = { red: team } as any; bot.teamMap = { Steve: team } as any;
    expect(subject.scoreboards()).toMatchObject({ scoreboards: { points: { title: "Team points", items: [{ name: "Steve", value: 0, displayName: "[Red] Steve" }] } }, scoreboard: { sidebar: { name: "points" } } });
    expect(subject.teams()).toMatchObject({ teams: { red: { name: "Red team", prefix: "[Red] ", suffix: "!", color: "red", members: ["Steve"] } }, teamMap: { Steve: "red" } });
    expect(JSON.stringify([subject.scoreboards(), subject.teams()])).not.toContain("PRIVATE");
    subject.stop();
  });

  it("distinguishes unavailable queries from a known empty or closed observation", () => {
    const { subject, bot } = controller();
    for (const query of [() => subject.position(), () => subject.inventory(), () => subject.controls(), () => subject.windowStatus(), () => subject.blockInfo(1, 2, 3)]) expect(query()).toEqual({ known: false });
    bot.emit("spawn");
    bot.currentWindow = null as any; bot.heldItem = null as any;
    expect(subject.windowStatus()).toEqual({ known: true });
    expect(subject.inventory()).toMatchObject({ known: true, items: expect.any(Array), quickBarSlot: 0 });
    expect(subject.inventory()).not.toHaveProperty("heldItem");
    delete (bot as any).currentWindow;
    expect(subject.windowStatus()).toEqual({ known: false });
    subject.stop();
  });

  it("keeps unacquired controls unknown in ready daemon frames", () => {
    const { subject, bot } = controller(); bot.emit("spawn");
    bot.controlState = undefined as any;
    const frame = subject.frame();
    expect(frame.connection.ready).toBe(true);
    expect(frame.self).not.toHaveProperty("controls");
    expect(frame.unknownFields).toContain("/self/controls");
    expect(subject.controls()).toEqual({ known: false });
    bot.controlState = { forward: false };
    const known = subject.frame();
    expect(known.self.controls).toEqual([]);
    expect(known.unknownFields ?? []).not.toContain("/self/controls");
    subject.stop();
  });

  it("explains a known game precondition in a public failed action", async () => {
    const { subject, bot } = controller(); bot.emit("spawn");
    const action = subject.runAction("item.equip", ["item"], () => subject.equip("diamond", "hand"));
    const result = projectAction(await subject.actions.wait(action.action, 1000));
    expect(result).toMatchObject({ state: "failed", error: { code: "COMMAND_BLOCKED", message: "Item 'diamond' is not in inventory." } });
    expect(result).not.toHaveProperty("runtimeId");
    subject.stop();
  });

  it("waits for Mineflayer plugin injection before installing method guards", () => {
    const bot = new FakeBot();
    const lookAt = bot.lookAt;
    const pathfinder = bot.pathfinder;
    (bot as any).lookAt = undefined;
    (bot as any).pathfinder = undefined;
    const subject = new BotController(
      { host: "localhost", port: 25565, username: "AgentBot", auth: "offline" },
      new EventStore(), () => bot,
    );
    expect(() => subject.start()).not.toThrow();
    expect(subject.status().connection.state).toBe("connecting");
    expect(pathfinder.setMovements).not.toHaveBeenCalled();
    bot.lookAt = lookAt;
    bot.pathfinder = pathfinder;
    bot.emit("inject_allowed");
    expect(bot.lookAt).not.toBe(lookAt);
    expect(pathfinder.setMovements).toHaveBeenCalledOnce();
    bot.emit("spawn");
    expect(subject.frame().connection.ready).toBe(true);
    subject.stop();
  });

  it("distinguishes connection startup from terminal disconnect and retains the kick reason in frames", () => {
    const { subject, bot } = controller();
    expect(subject.status().connection).toEqual({ state: "connecting", ready: false });
    bot.emit("spawn");
    expect(subject.frame().connection).toMatchObject({ state: "ready", ready: true });
    bot.emit("kicked", { text: "Server maintenance" });
    bot.emit("end", "socketClosed");
    const frame = subject.frame();
    expect(frame.connection).toMatchObject({
      state: "disconnected", ready: false,
      cause: { code: "SERVER_REJECTED" }, recovery: { state: "intervention_required" },
    });
    expect(subject.status().connection).toMatchObject({ state: "disconnected", cause: frame.connection.cause });
    expect(() => subject.validateContext({ context: frame.context })).toThrow(expect.objectContaining({
      code: "NOT_READY", details: expect.objectContaining({ state: "disconnected" }), remediation: expect.stringContaining("connection is ready"),
    }));
    bot.emit("login");
    expect(subject.status().connection).toMatchObject({ state: "disconnected", cause: frame.connection.cause });
    bot.emit("spawn");
    expect(subject.frame().connection).toMatchObject({ state: "disconnected", ready: false, cause: frame.connection.cause });
  });

  it("projects nested protocol kick reasons without exposing raw protocol data", () => {
    const { subject, bot } = controller();
    const reason = { type: "compound", value: { translate: { type: "string", value: "multiplayer.disconnect.kicked" } } };
    bot.emit("kicked", reason);
    bot.emit("end", "socketClosed");
    expect(subject.status().connection.cause?.code).toBe("SERVER_REJECTED");
    expect(subject.frame().connection.cause.code).toBe("SERVER_REJECTED");
    expect(JSON.stringify(subject.status())).not.toContain("multiplayer.disconnect.kicked");
  });

  it("records lifecycle and message events", () => {
    const { subject, bot, events } = controller();
    bot.emit("spawn");
    expect(subject.status()).toMatchObject({ ready: true });
    bot.emit("whisper", "Alex", "secret", undefined, { text: "secret" });
    bot.emit("message", { toString: () => "server says hi" }, "system", "Server");
    bot.emit("death");
    bot.emit("health");
    bot.emit("entitySpawn", bot.entities["10"]);
    bot.emit("itemDrop", bot.entities["10"]);
    bot.emit("blockUpdate", undefined, { name: "dirt", type: 3, position: new Vec3(1, 2, 3) });
    bot.emit("kicked", "bye");
    bot.emit("error", new Error("bad"));
    bot.emit("end");

    subject.flushChat();
    expect(subject.status()).toMatchObject({ ready: false, connection: { cause: { code: "SERVER_REJECTED" } } });
    expect(events.list(0, 50)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "connection.ready" }),
      expect.objectContaining({ type: "chat.unverified", candidateSender: "Alex", claimedChannel: "whisper", text: "secret" }),
      expect.objectContaining({ type: "server.message", sender: "Server", text: "server says hi" }),
      expect.objectContaining({ type: "self.died" }),
      expect.objectContaining({ type: "entity.appeared" }),
      expect.objectContaining({ type: "world.reset", reason: "DEATH" }),
      expect.objectContaining({ type: "connection.error", text: "bad" }),
      expect.objectContaining({ type: "connection.disconnected" }),
    ]));
    expect(events.list(0, 50).some(event => event.type === "entityMoved" || event.type === "health")).toBe(false);

  });

  it("throws when actions are used before start and quits when stopped", () => {
    const events = new EventStore();
    const subject = new BotController({ host: "localhost", port: 25565, username: "AgentBot", auth: "offline" }, events, () => new FakeBot());

    expect(() => subject.sendChat("hello")).toThrow("Bot is not started.");

    const { subject: started, bot } = controller();
    started.stop();
    expect(bot.quit).toHaveBeenCalledWith("mc-agent session stop");
  });

  it("handles missing optional bot fields and non-Error event payloads", () => {
    const events = new EventStore();
    const bot = new FakeBot();
    bot.username = undefined;
    const subject = new BotController(
      { host: "localhost", port: 25565, username: "FallbackBot", auth: "offline" },
      events,
      () => bot,
    );
    subject.start();
    bot.emit("message", undefined, "system", undefined);
    subject.flushChat();
    bot.emit("error", "plain-error");

    expect(subject.status()).not.toHaveProperty("username");
    expect(JSON.stringify(subject.status())).not.toContain("FallbackBot");
    bot.entity = undefined as unknown as FakeBot["entity"];
    bot.game = undefined as unknown as FakeBot["game"];
    bot.inventory = undefined as unknown as FakeBot["inventory"];
    bot.heldItem = null as unknown as FakeBot["heldItem"];
    expect(subject.position()).toEqual({ known: false });
    expect(subject.inventory()).toEqual({ known: false });
    subject.flushChat();
    expect(events.list(0, 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "server.message", text: "undefined" }),
        expect.objectContaining({ type: "connection.error", text: "plain-error" }),
      ]),
    );
  });

  it("exposes world observations and pathfinding state", async () => {
    const { subject, bot } = controller();

    bot.emit("spawn");
    expect(subject.players()).toMatchObject({
      players: [expect.objectContaining({ username: "Steve", distance: 3 })],
    });
    expect(subject.entities(10, 5)).toMatchObject({
      entities: expect.arrayContaining([expect.objectContaining({ name: "cow", distance: 2, trackId: expect.any(String) })]),
    });
    expect(subject.tablist()).toMatchObject({ tablist: { header: "Welcome" } });
    expect(subject.scoreboards()).toMatchObject({ scoreboards: { main: { name: "main" } } });
    expect(subject.teams()).toMatchObject({ teams: { red: { name: "red" } } });
    expect(subject.controls()).toEqual({ known: true, controls: [] });
    expect(subject.blockAt(4, 5, 6)).toMatchObject({ block: { name: "dirt", position: { x: 4, y: 5, z: 6 } } });
    expect(subject.blockInfo(4, 5, 6)).toMatchObject({ canDig: true, digTimeMs: 250 });
    expect(subject.blockInSight(256, 5)).toMatchObject({ known: true, block: { name: "dirt", position: { x: 1, y: 3, z: 3 } } });
    expect(subject.blockAtCursor(5)).toMatchObject({ known: true, block: { name: "dirt", position: { x: 1, y: 3, z: 3 } } });
    expect(subject.findBlocks("dirt", 16, 3)).toMatchObject({ blocks: [{ name: "dirt", position: { x: 1, y: 2, z: 3 } }] });

    bot.pathfinder.goto.mockImplementation(async (...args: unknown[]) => {
      const goal = args[0] as { x: number; y: number; z: number };
      bot.entity.position = { x: goal.x, y: goal.y, z: goal.z };
    });
    await subject.goto(10, 64, -2, 1);
    expect(bot.pathfinder.goto).toHaveBeenCalledWith(expect.objectContaining({ x: 10, y: 64, z: -2 }));

    expect(subject.follow("Steve", 2)).toMatchObject({ following: "Steve", range: 2, targetPosition: { x: 4, y: 2, z: 3 } });
    expect(bot.pathfinder.setGoal).toHaveBeenCalledWith(expect.objectContaining({ entity: bot.players.Steve.entity }), true);
    expect(subject.navigationStatus()).toEqual({ moving: false, mining: false, building: false });
    expect(subject.configureNavigation({ allowDig: false, allowSprinting: false, maxDropDown: 2, searchRadius: 32 })).toMatchObject({
      configured: true,
      searchRadius: 32,
      movements: { canDig: false, allowSprinting: false, maxDropDown: 2 },
    });
    const movements = bot.pathfinder.movements as { canDig: boolean; allowSprinting: boolean; maxDropDown: number };
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.maxDropDown = 4;
    await subject.goto(12, 64, -2, 1);
    expect(bot.pathfinder.movements).toMatchObject({ canDig: false, allowSprinting: false, maxDropDown: 2 });
    await expect(subject.collectItem(10, 1)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
    expect(subject.stopNavigation()).toEqual({ stopped: true });
    expect(bot.pathfinder.stop).toHaveBeenCalled();
  });

  it("equips items and interacts with blocks", async () => {
    const { subject, bot } = controller();
    bot.emit("spawn");

    subject.sendWhisper("Steve", "hi");
    expect(bot.whisper).toHaveBeenCalledWith("Steve", "hi");
    await expect(subject.tabComplete("/gi", true, false, 1000)).resolves.toEqual({ matches: ["hello"] });
    subject.setControl("forward", true);
    expect(bot.setControlState).toHaveBeenCalledWith("forward", true);
    expect(subject.controls()).toEqual({ known: true, controls: ["forward"] });
    expect(subject.clearControls()).toEqual({ cleared: true });
    expect(bot.clearControlStates).toHaveBeenCalled();
    expect(subject.controls()).toEqual({ known: true, controls: [] });
    await subject.look(1, 0.5, true);
    expect(bot.look).toHaveBeenCalledWith(1, 0.5, true);

    await expect(subject.equip("dirt", "hand")).resolves.toMatchObject({ equipped: "dirt", destination: "hand" });
    expect(bot.equipCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }), "hand");
    await expect(subject.unequip("hand")).resolves.toEqual({ unequipped: true, destination: "hand" });
    expect(subject.setQuickBarSlot(2)).toEqual({ quickBarSlot: 2 });
    expect(bot.setQuickBarSlot).toHaveBeenCalledWith(2);
    await expect(subject.toss("dirt", 1)).resolves.toEqual({ tossed: "dirt", count: 1 });
    expect(bot.toss).toHaveBeenCalledWith(3, null, 1);
    await expect(subject.consume()).resolves.toEqual({ consumed: true });
    bot.heldItem = { name: "fishing_rod", displayName: "Fishing Rod" };
    await expect(subject.fish()).resolves.toEqual({ fished: true });
    bot.heldItem = null as unknown as FakeBot["heldItem"];
    await expect(subject.consume()).rejects.toThrow("No held item is equipped to consume.");
    await expect(subject.fish()).rejects.toThrow("A fishing_rod must be equipped before fishing.");
    expect(subject.activateItem(false)).toEqual({ activated: true, offhand: false });
    expect(subject.deactivateItem()).toEqual({ deactivated: true });
    expect(subject.recipes("stick", 1)).toMatchObject({ item: "stick", recipes: [{ id: "recipe" }] });
    await expect(subject.craft("stick", 1)).resolves.toMatchObject({
      crafted: "stick",
      count: 1,
      requestedCount: 1,
      craftCount: 1,
      expectedResultCount: 4,
      recipeIndex: 0,
      recipeId: "recipe",
    });
    await expect(subject.craft("stick", 5)).resolves.toMatchObject({ craftCount: 2, expectedResultCount: 8 });
    expect(bot.craft).toHaveBeenLastCalledWith(expect.objectContaining({ id: "recipe" }), 2, undefined);
    await expect(subject.craft("stick", 1, undefined, 0)).resolves.toMatchObject({ recipeIndex: 0 });
    await expect(subject.craft("stick", 1, undefined, undefined, "recipe")).resolves.toMatchObject({ recipeId: "recipe" });

    const dug = subject.runAction("world.dig", ["movement", "look", "item"], () => subject.dig(1, 2, 3));
    expect(await subject.actions.wait(dug.action, 1000)).toMatchObject({ state: "completed", result: { dug: true, block: { name: "dirt" } } });
    expect(bot.digCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }), true);
    expect(subject.stopDigging()).toEqual({ stopped: true });

    const placed = subject.runAction("world.place", ["look", "item"], () => subject.place(1, 2, 3, "east", "dirt"));
    expect(await subject.actions.wait(placed.action, 1000)).toMatchObject({ state: "completed", result: { placed: true, face: "east" } });
    expect(bot.placeBlockCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }), expect.objectContaining({ x: 1, y: 0, z: 0 }));
    await expect(subject.placeEntity(1, 2, 3, "up", "dirt")).resolves.toMatchObject({ placed: true, entity: { name: "boat" } });
    await expect(subject.activate(1, 2, 3)).resolves.toMatchObject({ activated: true, block: { name: "dirt" } });
    expect(bot.activateBlockCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }));
    expect(subject.updateSign(1, 2, 3, "hello", false)).toMatchObject({ updated: true });
    await expect(subject.sleep(1, 2, 3)).resolves.toMatchObject({ sleeping: true });
    await expect(subject.wake()).resolves.toEqual({ awake: true });
    await expect(subject.elytraFly()).resolves.toEqual({ flying: true });

    await expect(subject.openWindowAt(1, 2, 3)).resolves.toMatchObject({ opened: true, window: { type: "minecraft:chest", slots: [{ name: "dirt" }] } });
    await expect(subject.openEntityWindow(10)).resolves.toMatchObject({ opened: true, entity: { name: "cow" }, window: { type: "minecraft:chest" } });
    expect(subject.windowStatus()).toMatchObject({ window: { type: "minecraft:chest" } });
    await expect(subject.windowDeposit("dirt", 1)).resolves.toMatchObject({ deposited: "dirt", count: 1 });
    await expect(subject.windowWithdraw("dirt", 1)).resolves.toMatchObject({ withdrew: "dirt", count: 1 });
    await expect(subject.windowClick(5, 0, 0)).resolves.toMatchObject({ clicked: true, slot: 5, window: { type: "minecraft:chest" } });
    expect(bot.clickWindow).toHaveBeenCalledWith(5, 0, 0);
    expect(subject.closeWindow()).toEqual({ closed: true });

    await expect(subject.activateEntity(10)).resolves.toMatchObject({ activated: true, entity: { name: "cow" } });
    expect(subject.useOnEntity(10)).toMatchObject({ usedOn: true, entity: { name: "cow" } });
    expect(subject.findEntities({ name: "cow", radius: 16, limit: 5, includePassive: true })).toMatchObject({ entities: [expect.objectContaining({ trackId: expect.any(String), type: "minecraft:cow", status: "loaded" })] });
    expect(() => subject.attackEntity(10)).toThrow("Refusing to attack a passive mob");
    expect(subject.attackEntity(10, { allowPassive: true })).toMatchObject({ attacked: true, entity: { name: "cow" } });
    expect(subject.findEntities({ name: "sniffer", radius: 16, limit: 5 })).toMatchObject({ entities: [expect.objectContaining({ type: "minecraft:sniffer", status: "loaded" })] });
    expect(() => subject.attackEntity(12)).toThrow("Refusing to attack a passive mob");
    expect(subject.swingArm("right", true)).toEqual({ swung: true, hand: "right", showHand: true });
    expect(subject.mountEntity(10)).toMatchObject({ mounted: true, entity: { name: "cow" } });
    expect(subject.dismount()).toEqual({ dismounted: true });
    expect(subject.moveVehicle(0.5, 1)).toEqual({ moved: true, left: 0.5, forward: 1 });
  });
});
