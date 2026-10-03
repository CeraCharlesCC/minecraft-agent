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

  it("drops the oldest event of a type when its retention limit is reached", () => {
    const store = new EventStore(1);
    store.add({ type: "test", text: "first" });
    store.add({ type: "test", text: "second" });
    expect(store.list(0, 10)).toEqual([expect.objectContaining({ type: "test", text: "second" })]);
  });
});
