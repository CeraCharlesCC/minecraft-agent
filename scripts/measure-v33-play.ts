/** Opt-in live comparison. Pass an already configured harness wrapper as the sole argument. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const wrapper = process.argv[2];
if (!wrapper) throw new Error("Usage: npm run measure:play -- /absolute/path/to/configured/bin/mc");
const execute = promisify(execFile);
let tokenize: ((text: string) => number) | undefined;
for (const name of [process.env.MC_AGENT_TOKENIZER_MODULE, "js-tiktoken", "tiktoken"].filter((value): value is string => !!value)) {
  try { const mod = await import(name); const enc = (mod.getEncoding ?? mod.get_encoding)("o200k_base"); tokenize = text => enc.encode(text).length; break; }
  catch { /* Token counts are omitted if no optional tokenizer can be loaded. */ }
}
const command = async (...args: string[]) => {
  const started = performance.now();
  const { stdout } = await execute(resolve(wrapper), ["--output", "json", ...args], { timeout: 10000, maxBuffer: 2 ** 20 });
  const response = JSON.parse(stdout);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  const latencyMs = performance.now() - started;
  return { data: response.data, bytes: Buffer.byteLength(stdout), tokens: tokenize ? tokenize(stdout) : null, latencyMs };
};
const initial = (await command("observe", "frame")).data;
if (!initial.connection?.ready || !Number.isFinite(initial.self?.yaw) || !Number.isFinite(initial.self?.pitch)) {
  throw new Error("A ready observation with known yaw/pitch is required; no gameplay request was sent.");
}
let context: string = initial.context;
const look = ["advanced", "look", "--yaw", String(initial.self.yaw), "--pitch", String(initial.self.pitch), "--force", "--wait", "1000"];
const rows: unknown[] = [];
for (const mode of ["previous_workflow", "combined_workflow", "combined_result_only"] as const) {
  let outputBytes = 0, calls = 0, frameQueries = 0, outputTokens: number | null = tokenize ? 0 : null;
  const latencies: number[] = [];
  for (let i = 0; i < 10; i++) {
    let latencyMs = 0;
    const action = await command(...look, ...(mode === "previous_workflow" ? ["--context", context, "--no-observe"] : mode === "combined_result_only" ? ["--no-observe"] : []));
    latencyMs += action.latencyMs; calls++; outputBytes += action.bytes; if (outputTokens !== null) outputTokens += action.tokens!;
    if (action.data.state !== "completed" || action.data.timedOut === true) throw new Error("Look did not complete; inspect state before continuing.");
    if (mode === "previous_workflow") {
      const frame = await command("observe", "frame");
      latencyMs += frame.latencyMs; calls++; frameQueries++; outputBytes += frame.bytes; if (outputTokens !== null) outputTokens += frame.tokens!; context = frame.data.context;
    } else if (mode === "combined_workflow" && action.data.observation?.context !== context) throw new Error("Observation context changed; explicitly observe before choosing further work.");
    latencies.push(latencyMs);
  }
  latencies.sort((a, b) => a - b);
  rows.push({ mode, operations: 10, cliCalls: calls, frameQueries, outputBytes, outputTokens,
    medianLatencyMs: Math.round(latencies[5] * 100) / 100, p95LatencyMs: Math.round(latencies[9] * 100) / 100 });
}
// An already-satisfied navigation goal exercises the bounded action contract without changing location.
let navigation: Record<string, unknown> | undefined;
if (initial.self?.position) {
  const { x, y, z } = initial.self.position;
  const result = (await command("navigate", "goto", "--x", String(x), "--y", String(y), "--z", String(z), "--wait", "1000")).data;
  navigation = { state: result.state, goalSatisfied: result.result?.goalSatisfied, observation: result.observation?.type };
}
const close = (await command("window", "close")).data;
const settled = close.state === "running" ? (await command("action", "wait", "--action", close.action, "--timeout", "1000")).data : close;
console.log(JSON.stringify({ measurement: "Configured live session, repeated unchanged yaw/pitch. previous workflow manually observes after result-only action, combined workflow reads attached observation. Latencies include CLI process startup and context file I/O; initial frame and final checks excluded from rows. Dynamic world updates may affect bytes. Optional tokenizer is reported separately. No chat, item, or terrain operation.",
  tokenizer: tokenize ? "o200k_base" : "unavailable; token counts omitted", rows, checks: { navigation, windowClose: { initiallyOpen: !!initial.window, state: settled.state, closed: settled.result?.closed, error: settled.error?.code, observation: settled.observation?.type } } }, null, 2));
