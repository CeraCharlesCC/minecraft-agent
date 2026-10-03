import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { buildProgram } from "../src/cli/program.js";
import type { CliHandlers } from "../src/cli/handlers.js";

describe("mc-agent help", () => {
  it("prints help without failing", async () => {
    const exitCode = await main(["node", "mc-agent", "--help"]);
    expect(exitCode).toBe(0);
  });

  it("distinguishes package and Minecraft versions in help", () => {
    const program = buildProgram({} as CliHandlers, { stdout: process.stdout, stderr: process.stderr }, "9.8.7");
    const start = program.commands.find(command => command.name() === "session")!.commands.find(command => command.name() === "start")!;
    const daemonRun = program.commands.find(command => command.name() === "daemon")!.commands.find(command => command.name() === "run")!;

    expect(program.helpInformation()).toContain("-V, --version");
    for (const command of [start, daemonRun]) {
      expect(command.helpInformation()).toContain("--minecraft-version <version>");
      expect(command.helpInformation()).not.toMatch(/(?:^|\s)--version <version>/);
    }
  });

  it("advertises 12 projected entities by default", () => {
    const program = buildProgram({} as CliHandlers, { stdout: process.stdout, stderr: process.stderr });
    const frame = program.commands.find(command => command.name() === "observe")!.commands.find(command => command.name() === "frame")!;

    expect(frame.helpInformation()).toMatch(/--max-entities <count>[\s\S]*?\(default:\s+"12"\)/);
  });
});
