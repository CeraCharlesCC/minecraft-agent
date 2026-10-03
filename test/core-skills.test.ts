import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/events.js";
import { getSkillContent } from "../src/core/skills.js";

describe("core skill content", () => {
  it("returns compact guidance and optional discovery notes", () => {
    const compact = getSkillContent("core", false);
    const full = getSkillContent("core", true);

    expect(compact).toContain("## Operating loop");
    expect(compact).toContain("keep the returned `nextCursor`");
    expect(compact).toContain("Commands that start managed physical work return an action ID");
    expect(compact).toContain("mc-agent <group> <command> --help");
    expect(compact).not.toContain("## Command discovery");

    expect(full).toContain("## Command discovery");
    expect(full).toContain("mc-agent navigate follow --help");
    expect(full).toContain("Exit codes are");
    expect(full).not.toContain("Frame and replay endpoints");
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
