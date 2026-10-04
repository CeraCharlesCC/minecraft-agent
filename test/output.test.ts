import { Writable } from "node:stream";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { badInput, CliError, commandBlocked, contextRequired, normalizeError, sessionNotFound } from "../src/output/errors.js";
import { failure, formatDefaultText, resolveOutputMode, success, writeJson, writeText } from "../src/output/response.js";

class MemoryStream extends Writable {
  value = "";

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += chunk.toString();
    callback();
  }
}

describe("output errors", () => {
  it("creates typed CLI errors", () => {
    expect(badInput("bad")).toMatchObject({ code: "BAD_INPUT", exitCode: 3 });
    expect(commandBlocked("blocked", "fix")).toMatchObject({ code: "COMMAND_BLOCKED", remediation: "fix" });
    expect(sessionNotFound("x")).toMatchObject({ code: "SESSION_NOT_FOUND", exitCode: 4 });
  });

  it("normalizes different error shapes", () => {
    const cli = new CliError("BAD_INPUT", "bad", "fix", 3);
    expect(normalizeError(cli)).toBe(cli);

    const schema = z.object({ value: z.string().min(3) });
    const zodError = schema.safeParse({ value: "x" }).error!;
    expect(normalizeError(zodError)).toMatchObject({ code: "BAD_INPUT", message: expect.stringContaining("value") });
    const rootZodError = z.string().min(3).safeParse("x").error!;
    expect(normalizeError(rootZodError)).toMatchObject({ code: "BAD_INPUT", message: expect.stringContaining("value") });

    expect(normalizeError(new Error("boom"))).toMatchObject({ code: "UNKNOWN_ERROR", message: "boom" });
    expect(normalizeError("wat")).toMatchObject({ code: "UNKNOWN_ERROR", message: "Unknown error." });
  });
});

describe("output responses", () => {
  it("formats success, failure, and output modes", () => {
    const error = new CliError("DAEMON_ERROR", "boom", "restart", 1);
    expect(success({ ok: true })).toEqual({ ok: true, data: { ok: true } });
    expect(failure(error)).toEqual({ ok: false, error: { code: "DAEMON_ERROR", message: "The operation failed. Inspect operational diagnostics for the cause." } });
    expect(resolveOutputMode(undefined, true)).toBe("text");
    expect(resolveOutputMode(undefined, false)).toBe("json");
    expect(resolveOutputMode("json", true)).toBe("json");
    expect(() => resolveOutputMode("xml", true)).toThrow("Invalid output mode");
  });

  it("writes JSON and text to streams", () => {
    const json = new MemoryStream();
    const text = new MemoryStream();
    writeJson(json, success({ value: 1 }));
    writeText(text, "hello");
    expect(json.value).toBe('{"ok":true,"data":{"value":1}}\n');
    expect(text.value).toBe("hello\n");
    expect(formatDefaultText("plain")).toBe("plain");
    expect(formatDefaultText({ nested: true })).toBe('{\n  "nested": true\n}');
  });
  it("keeps actionable track facts while excluding internal runtime details", () => {
    const details = { trackId: "runtime:p1", worldEpoch: 3 };
    const result = failure(new CliError("TRACK_LOST", "lost", "observe", 1, details));
    expect(result).toMatchObject({ ok: false, error: { code: "TRACK_LOST" } });
    expect(result.error.details).toEqual({ trackId: "runtime:p1" });
  });

  it("projects context guidance and meaningful navigation facts without private diagnostics", () => {
    expect(failure(contextRequired())).toEqual({ ok: false, error: {
      code: "CONTEXT_REQUIRED", message: "Pass context from observe frame or entity find.",
    } });
    const error = new CliError("NAVIGATION_FAILED", "account@example.com at private.example:25565", "long manual steps", 1, {
      reason: "NO_PATH", goal: { x: 10, y: 64, z: 5, range: 1 }, reachedGoal: false,
      runtimeId: "internal-runtime", worldEpoch: 3, bindingGeneration: 4,
      connection: { username: "account@example.com" }, stack: "private-stack", configuration: { canDig: true },
    });
    expect(failure(error)).toEqual({ ok: false, error: { code: "NAVIGATION_FAILED",
      message: "Navigation did not reach the goal.", details: {
        reason: "NO_PATH", goal: { x: 10, y: 64, z: 5, range: 1 }, reachedGoal: false,
      } } });
  });

  it("preserves uncertain POST outcomes and hides untrusted transport messages", () => {
    const result = failure(new CliError("DAEMON_TIMEOUT", "account@example.com private.example", "inspect stack", 1, {
      outcome: "unknown", mayHaveExecuted: true, responseConfirmed: false, timeoutMs: 0,
      pid: 123, controlPort: 3000, token: "secret", path: "/internal", stack: "private",
    }));
    expect(result).toEqual({ ok: false, error: { code: "DAEMON_TIMEOUT",
      message: "The daemon request timed out; its outcome may be unknown.",
      details: { outcome: "unknown", mayHaveExecuted: true, responseConfirmed: false, timeoutMs: 0 } } });
    const unknown = failure(normalizeError(new Error("account@example.com at private.example\nprivate stack")));
    expect(JSON.stringify(unknown)).not.toMatch(/account|private/);
  });

});
