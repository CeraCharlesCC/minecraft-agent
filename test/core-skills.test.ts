import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/events.js";
import { getSkillContent } from "../src/core/skills.js";

describe("core skill content", () => {
  it("returns compact guidance and optional discovery notes", () => {
    const compact = getSkillContent("core", false);
    const full = getSkillContent("core", true);

    expect(compact.trim().length).toBeGreaterThan(0);
    expect(compact.length).toBeLessThan(1600);
    expect(full.startsWith(`${compact}\n\n`)).toBe(true);
    expect(full.length).toBeGreaterThan(compact.length);
  });

  it("rejects unknown skill names", () => {
    expect(() => getSkillContent("missing", false)).toThrow("Unknown skill 'missing'");
  });

  it("keeps ordinary play focused on observation and action", () => {
    const compact = getSkillContent("core", false);
    expect(compact).toContain("observe → action with observation → next action");
    expect(compact).toContain("`MC_AGENT_CLIENT_ID`");
    expect(compact).toContain("`unknownFields`");
    expect(compact).toContain("old actions are not replayed");
    expect(compact).not.toContain("`session ensure-ready");
  });

  it("explains deletion, fallback, and event history limits", () => {
    const full = getSkillContent("core", true);
    expect(full).toContain("replaces changed top-level fields completely");
    expect(full).toContain("`delta.unset`");
    expect(full).toContain("`reset.reason`");
    expect(full).toContain("does not repair event gaps");
    expect(full).toContain("`chat.player`, `chat.unverified`");
    expect(full).toContain("does not acknowledge unread events");
  });

  it("drops the oldest event of a type when its retention limit is reached", () => {
    const store = new EventStore(1);
    store.add({ type: "test", text: "first" });
    store.add({ type: "test", text: "second" });
    expect(store.list(0, 10)).toEqual([expect.objectContaining({ type: "test", text: "second" })]);
  });
});
