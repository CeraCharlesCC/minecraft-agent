/** Local HTTP response measurements with a simulated bot; never connects to Minecraft. */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runDaemon } from "../src/daemon/server.js";

class MeasurementBot extends EventEmitter {
  username = "MeasurementBot";
  entity = { id: 0, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true, equipment: Array(6).fill(null) };
  entities: Record<string, unknown> = {}; players = {}; game = { dimension: "overworld" };
  health = 20; food = 20; oxygenLevel = 20; foodSaturation = 5;
  experience = { level: 0, points: 0, progress: 0 }; quickBarSlot = 0; heldItem = null; currentWindow = null;
  inventory = { slots: Array(46).fill(null), items: () => [] };
  controlState = {}; chat() {} quit() {} setControlState() {} clearControlStates() {}
  async look(yaw: number, pitch: number) { await new Promise(resolve => setTimeout(resolve, 10)); this.entity.yaw = yaw; this.entity.pitch = pitch; }
}

const directory = await mkdtemp(join(tmpdir(), "mc-agent-v33-loop-"));
const previousDirectory = process.env.MC_AGENT_STATE_DIR;
process.env.MC_AGENT_STATE_DIR = directory;
const allocation = createServer();
await new Promise<void>(resolve => allocation.listen(0, "127.0.0.1", resolve));
const port = (allocation.address() as { port: number }).port;
await new Promise<void>(resolve => allocation.close(() => resolve()));
const bot = new MeasurementBot();
const headers = { Authorization: "Bearer measurement-token-12345678901234567890", "X-MC-Agent-API": "3.3", "Content-Type": "application/json" };
let tokenize: ((text: string) => number) | undefined;
for (const name of [process.env.MC_AGENT_TOKENIZER_MODULE, "js-tiktoken", "tiktoken"].filter((value): value is string => !!value)) {
  try { const mod = await import(name); const enc = (mod.getEncoding ?? mod.get_encoding)("o200k_base"); tokenize = text => enc.encode(text).length; break; }
  catch { /* Optional tokenizer: report missing counts without estimating them. */ }
}
const request = async (path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
};
const rows: unknown[] = [];
try {
  await runDaemon({ session: "measurement", controlPort: port, token: "measurement-token-12345678901234567890", host: "unused", port: 25565,
    username: bot.username, auth: "offline", createBotFn: () => bot, exitOnStop: false });
  bot.emit("spawn");
  for (const fixture of ["empty", "12_entities"] as const) {
    bot.entities = fixture === "empty" ? {} : Object.fromEntries(Array.from({ length: 12 }, (_, n) => [String(n + 1),
      { id: n + 1, name: "cow", type: "mob", position: { x: n + 1, y: 64, z: 0 } }]));
    const { context } = await request("/frame");
    for (const mode of ["previous_loop", "combined_loop", "previous_result_only", "combined_default_unneeded_frame", "combined_result_only"] as const) {
      let requests = 0, queries = 0, bytes = 0, outputBytes = 0, tokens: number | null = tokenize ? 0 : null, outputTokens: number | null = tokenize ? 0 : null;
      const latencies: number[] = [];
      let tokenizerTimeMs = 0;
      const counted = async (path: string, body?: unknown, displayed = true) => {
        requests++; if (body === undefined) queries++;
        const data = await request(path, body);
        const output = JSON.stringify({ ok: true, data }) + "\n";
        bytes += Buffer.byteLength(output);
        const tokenStarted = performance.now();
        const count = tokenize ? tokenize(output) : null;
        tokenizerTimeMs += performance.now() - tokenStarted;
        if (tokens !== null) tokens += count!;
        if (displayed) { outputBytes += Buffer.byteLength(output); if (outputTokens !== null) outputTokens += count!; }
        return data;
      };
      for (let i = 0; i < 20; i++) {
        tokenizerTimeMs = 0;
        const started = performance.now();
        const input = { context, yaw: (i % 2) * 0.1, pitch: 0, force: false };
        if (mode.startsWith("previous_")) {
          const action = await counted("/look/yaw-pitch", { ...input, observe: false }, false);
          await counted(`/actions/${action.action}/wait?timeout=1000&observe=false`);
          if (mode === "previous_loop") await counted("/frame");
        } else await counted("/look/yaw-pitch", { ...input, wait: 1000, observe: mode !== "combined_result_only" });
        latencies.push(performance.now() - started - tokenizerTimeMs);
      }
      latencies.sort((a, b) => a - b);
      rows.push({ fixture, mode, operations: 20, requests, queries, httpResponseBytes: bytes, httpResponseTokens: tokens, outputBytes, outputTokens,
        medianLatencyMs: Math.round(latencies[10] * 100) / 100, p95LatencyMs: Math.round(latencies[18] * 100) / 100 });
    }
  }
  console.log(JSON.stringify({ measurement: "Synthetic local HTTP, 10ms simulated look; previous request sequence on current projection. Counts exclude initial observation and startup; response bytes include CLI-style success envelopes for every HTTP response, including the old intermediate acceptance. outputBytes/outputTokens exclude the old intermediate acceptance suppressed by the CLI; httpResponseBytes/httpResponseTokens include it. Not real-server latency; token counts describe output strings, not API billing.",
    tokenizer: tokenize ? "o200k_base" : "unavailable; token counts are null", rows }, null, 2));
} finally {
  await request("/stop", {}).catch(() => {});
  for (let i = 0; i < 100; i++) {
    if (await request("/status").then(() => false, () => true)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (previousDirectory === undefined) delete process.env.MC_AGENT_STATE_DIR;
  else process.env.MC_AGENT_STATE_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
}
