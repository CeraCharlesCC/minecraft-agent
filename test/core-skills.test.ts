import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EventStore } from "../src/core/events.js";
import { getSkillContent } from "../src/core/skills.js";
import { COMMAND_REFERENCE } from "../src/core/command-reference.js";
import { buildProgram } from "../src/cli/program.js";
import type { CliHandlers } from "../src/cli/handlers.js";
import { renderCommandReference, renderReferenceFile, renderSkillFile } from "../scripts/generate-reference.js";

describe("core skill content", () => {
  it("keeps the entrypoint compact and includes syntax and contracts in full", () => {
    const compact = getSkillContent("core", false);
    const full = getSkillContent("core", true);

    expect(compact.trim().length).toBeGreaterThan(0);
    expect(compact.length).toBeLessThan(1600);
    expect(full.startsWith(`${compact}\n\n`)).toBe(true);
    expect(full.length).toBeGreaterThan(compact.length);
  });

  it("keeps bundled syntax and distributed guidance current with the CLI", () => {
    const program = buildProgram({} as CliHandlers, { stdout: process.stdout, stderr: process.stderr });
    const syntax = renderCommandReference(program);
    expect(COMMAND_REFERENCE).toBe(syntax);
    expect(getSkillContent("core", true)).toContain(syntax);
    expect(readFileSync(new URL("../skills/minecraft/SKILL.md", import.meta.url), "utf8")).toBe(renderSkillFile());
    expect(readFileSync(new URL("../skills/minecraft/references/playbooks.md", import.meta.url), "utf8")).toBe(renderReferenceFile(syntax));
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
