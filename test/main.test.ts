import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/main.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "mc-main-"));
  vi.stubEnv("MC_AGENT_STATE_DIR", stateDir);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("../src/cli/program.js");
  vi.doUnmock("../src/cli/actions.js");
  vi.resetModules();
  await rm(stateDir, { recursive: true, force: true });
});

describe("main", () => {
  it("returns Commander and CliError exit codes", async () => {
    await expect(main(["node", "mc-agent", "skills", "get", "core"])).resolves.toBe(0);
    await expect(main(["node", "mc-agent", "--help"])).resolves.toBe(0);
    await expect(main(["node", "mc-agent", "--output", "json", "session", "status", "--session", "missing"])).resolves.toBe(4);
  });

  it("rethrows unexpected parser errors", async () => {
    vi.resetModules();
    vi.doMock("../src/cli/program.js", () => ({
      buildProgram: () => ({
        exitOverride: vi.fn(),
        parseAsync: vi.fn().mockRejectedValue(new TypeError("unexpected")),
      }),
    }));
    vi.doMock("../src/cli/actions.js", () => ({ createCliHandlers: vi.fn(() => ({})) }));
    const { main: mockedMain } = await import("../src/cli/main.js");

    await expect(mockedMain(["node", "mc-agent"])).rejects.toThrow("unexpected");
  });
});
