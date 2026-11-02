import { appendFile, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ManagedProcesses } from "./managedProcesses.js";
import type { ManagedProcessLauncher, ManagedProcessRecord, ManagedProcessResult } from "./managedProcessTypes.js";
import { ManagedProcessTools } from "./processTool.js";
import type { ProcessEventSummary } from "./processWatchState.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(attached = false, now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "forgerie-process-tool-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const live = new Map<string, ManagedProcessRecord>();
  const launcher: ManagedProcessLauncher = {
    supervision: attached ? { kind: "attached", instance: "8bdc9320-3afc-4c7c-87c7-2a1fabc0a3b1" } : { kind: "systemd" },
    launch: (record) => { live.set(record.id, record); return Promise.resolve(); },
    inspect: (record) => Promise.resolve(live.has(record.id) ? "running" : "gone"),
    stop: (record) => { live.delete(record.id); return Promise.resolve(); },
    stopSession: () => { live.clear(); return Promise.resolve(); }, release: () => Promise.resolve(),
  };
  const summaries: ProcessEventSummary[] = [];
  let core: ManagedProcesses;
  async function open() {
    core = new ManagedProcesses({ stateDirectory: root, sessionId: "test", launcher, environment: { SECRET_TOKEN: "private-value", PATH: process.env["PATH"] } });
    await core.initialize();
    cleanups.push(() => core.dispose());
    const tool = new ManagedProcessTools({ sessionId: "test", cwd: root, stateFile: join(root, "watches.json"), ...(now === undefined ? {} : { now }), getManagedProcesses: () => Promise.resolve(core) });
    await tool.initialize((summary) => { summaries.push(summary); return Promise.resolve(); });
    return tool;
  }
  const tool = await open();
  return { tool, open, summaries, live, core: () => core, root,
    log: (id: string, text: string) => appendFile(join(root, "managed-processes/test", id, "output.log"), text),
    end: (id: string, result: ManagedProcessResult = { result: "success", code: "exited", status: "0" }) =>
      writeFile(join(root, "managed-processes/test", id, "result"), `${result.result}\n${result.code}\n${result.status}\n`) };
}

it("projects tool actions without private records and browsing never consumes watch output", async () => {
  const f = await fixture();
  const started = await f.tool.execute({ action: "start", name: "build", command: "build", notify: { logMatches: [{ pattern: "ready" }] } });
  const id = started.process?.id;
  if (id === undefined) throw new Error("No process ID");
  await f.log(id, "ready\n");
  expect(await f.tool.execute({ action: "output", id })).toMatchObject({ lines: [{ number: 1, text: "ready" }] });
  expect((await f.core().readOutput(id)).lines).toHaveLength(1);
  await f.tool.dispatch(false);
  expect(f.summaries).toHaveLength(1);
  expect((await f.core().readOutput(id)).lines).toHaveLength(0);
  const listed = await f.tool.execute({ action: "list" });
  expect(JSON.stringify(listed)).not.toMatch(/private-value|environment|instance/);
  expect(listed.processes?.[0]).toMatchObject({ name: "build", status: "running" });
});

it("replays missed matches and exits as one summary after dispose and a new owner, with watch attention preserved", async () => {
  const f = await fixture();
  const one = await f.tool.execute({ action: "start", name: "one", command: "one", notify: { onSuccess: "context", logMatches: [{ pattern: "ready", on: "turn" }, { pattern: "quiet", on: "ignore" }] } });
  const two = await f.tool.execute({ action: "start", name: "two", command: "two", notify: { onSuccess: "ignore", logMatches: [{ pattern: "info", on: "context" }] } });
  const id = one.process?.id; const second = two.process?.id;
  if (id === undefined || second === undefined) throw new Error("No ID");
  await f.tool.dispose(); await f.core().dispose();
  await f.log(id, "ready\nquiet\n"); await f.log(second, "info\n"); await f.end(id); await f.end(second);
  const resumed = await f.open();
  expect(f.summaries).toHaveLength(1);
  expect(f.summaries[0]).toMatchObject({ missed: true });
  expect(f.summaries[0]?.events.map(event => event.attention).sort()).toEqual(["context", "context", "ignore", "ignore", "turn"]);
  await resumed.dispatch(false);
  expect(f.summaries).toHaveLength(1);
  await resumed.dispose(); await f.core().dispose(); await f.open();
  expect(f.summaries).toHaveLength(1);
});

it("reports a lost process as ended, never launches it again, and labels attached results", async () => {
  const f = await fixture(true);
  const started = await f.tool.execute({ action: "start", name: "attached", command: "cat" });
  const id = started.process?.id;
  if (id === undefined) throw new Error("No ID");
  expect(started.process?.notice).toBe("Attached process: ends when the host restarts.");
  f.live.delete(id);
  const output = await f.tool.execute({ action: "output", id });
  expect(output.process).toMatchObject({ state: "ended", reason: "supervisor lost", notice: "Attached process: ends when the host restarts." });
  await f.tool.dispatch(false);
  expect(f.summaries[0]?.events[0]).toMatchObject({ reason: "supervisor lost", attention: "turn" });
  expect(f.live.size).toBe(0);
});

it("validates before launch, updates watches from current output, and suppresses intentional stop events", async () => {
  const f = await fixture();
  expect((await f.tool.execute({ action: "start", name: "bad", command: "bad", notify: { logMatches: [{ pattern: " " }] } })).error).toContain("patterns");
  expect(f.live.size).toBe(0);
  const started = await f.tool.execute({ action: "start", name: "watch", command: "watch", notify: { logMatches: [{ pattern: "ready", repeat: true }] } });
  const id = started.process?.id;
  if (id === undefined) throw new Error("No ID");
  await f.log(id, "old\nready\n");
  expect(await f.tool.execute({ action: "update", id, name: "renamed", watches: { mode: "replace", items: [{ pattern: "old" }, { pattern: "new", mode: "regex", on: "context" }] } })).toMatchObject({ process: { name: "renamed" } });
  expect(f.summaries).toHaveLength(1);
  await f.log(id, "new\nnew\n"); await f.tool.dispatch(false);
  expect(f.summaries).toHaveLength(2);
  expect(f.summaries[1]?.events).toMatchObject([{ name: "renamed", count: 1, attention: "context", line: 3 }]);
  await f.tool.execute({ action: "update", id, watches: { mode: "remove", items: [{ index: 0, pattern: "new" }] } });
  expect((await f.tool.execute({ action: "list" })).processes?.[0]?.watches).toHaveLength(1);
  await f.tool.execute({ action: "update", id, watches: { mode: "clear" } });
  expect((await f.tool.execute({ action: "list", statuses: ["running"] })).processes?.[0]?.watches).toEqual([]);
  expect(await f.tool.execute({ action: "write", id })).toMatchObject({ error: "write requires input or end: true" });
  await f.tool.execute({ action: "stop", id }); await f.tool.dispatch(false);
  expect(f.summaries).toHaveLength(2);
  expect((await f.tool.execute({ action: "list", statuses: ["running"] })).processes).toEqual([]);
});

it("retains failed delivery in the fsynced outbox and merges it with later missed events on resume", async () => {
  const f = await fixture();
  const started = await f.tool.execute({ action: "start", name: "repeat", command: "repeat", notify: { logMatches: [{ pattern: "ready", repeat: true }] } });
  const id = started.process?.id;
  if (id === undefined) throw new Error("No ID");
  await f.tool.dispose();
  const failing = new ManagedProcessTools({ sessionId: "test", cwd: f.root, stateFile: join(f.root, "watches.json"), getManagedProcesses: () => Promise.resolve(f.core()) });
  let failedId: string | undefined;
  await failing.initialize(summary => { failedId = summary.id; return Promise.reject(new Error("Delivery unavailable")); });
  await f.log(id, "ready\n");
  await expect(failing.dispatch(false)).rejects.toThrow("Delivery unavailable");
  expect((await f.core().readOutput(id)).lines).toEqual([]);
  expect(await readFile(join(f.root, "watches.json"), "utf8")).toContain('"samples":[{"number":1,"text":"ready"}]');
  await failing.dispose(); await f.core().dispose();
  await f.log(id, "ready\n");
  await f.open();
  expect(f.summaries).toHaveLength(1);
  expect(f.summaries[0]?.missed).toBe(true);
  expect(f.summaries[0]?.events).toHaveLength(1);
  expect(f.summaries[0]?.events[0]).toMatchObject({ line: 2, count: 2, totalCount: 2, samples: [{ number: 1, text: "ready" }, { number: 2, text: "ready" }] });
  expect(f.summaries[0]?.id).not.toBe(failedId);
  expect((await f.core().readOutput(id)).lines).toEqual([]);
});

it("preserves absolute lines across batches and bounds output without consuming repeat watches", async () => {
  const f = await fixture();
  const started = await f.tool.execute({ action: "start", name: "many", command: "many", notify: { logMatches: [{ pattern: "line", repeat: true }] } });
  const id = started.process?.id;
  if (id === undefined) throw new Error("No ID");
  await f.log(id, Array.from({ length: 2100 }, (_, index) => `line ${String(index + 1)} ${"x".repeat(50)}\n`).join(""));
  const output = await f.tool.execute({ action: "output", id, tailLines: 2000 });
  expect(output.truncated).toBe(true);
  expect(output.lines?.at(-1)?.number).toBe(2100);
  await f.tool.dispatch(false);
  expect(f.summaries[0]?.events[0]).toMatchObject({ line: 2100, count: 2100 });
  expect(f.summaries[0]?.events[0]?.samples).toHaveLength(20);
});

it("persists child ownership and keepAfterChild, lets the parent update it, and clears only ended records", async () => {
  const f = await fixture();
  const start = await f.tool.execute({ action: "start", name: "child-reader", command: "cat", keepAfterChild: true }, { child: { name: "worker", runId: "persisted-run-id" } });
  const id = start.process?.id;
  if (id === undefined) throw new Error("No ID");
  expect((await f.core().status(id)).child).toEqual({ name: "worker", runId: "persisted-run-id" });
  expect(start.process).toMatchObject({ child: { name: "worker", runId: "persisted-run-id" }, keepAfterChild: true });
  expect((await f.tool.execute({ action: "update", id, keepAfterChild: false })).process?.keepAfterChild).toBe(false);
  const parent = await f.tool.execute({ action: "start", name: "parent", command: "cat", keepAfterChild: true });
  expect(parent.process?.child).toBeUndefined();
  expect((await f.tool.execute({ action: "clear" })).cleared).toEqual([]);
  await f.end(id);
  expect((await f.tool.execute({ action: "clear" })).cleared?.map(process => process.id)).toEqual([id]);
  expect((await f.tool.execute({ action: "list" })).processes?.map(process => process.name)).toEqual(["parent"]);
});

it("bounds and coalesces 40 passive dispatches, preserving exact counts after reopening", async () => {
  const f = await fixture();
  const started = await f.tool.execute({ action: "start", name: "busy", command: "cat", notify: { logMatches: [
    { pattern: "hit", on: "ignore", repeat: true }, { pattern: "hit", on: "context", repeat: true },
  ] } });
  const id = started.process?.id;
  if (id === undefined) throw new Error("No ID");
  await f.tool.dispose();
  let now = 0;
  const open = () => new ManagedProcessTools({ sessionId: "test", cwd: f.root, stateFile: join(f.root, "watches.json"), now: () => now, getManagedProcesses: () => Promise.resolve(f.core()) });
  let tool = open(); await tool.initialize();
  try {
    for (let index = 0; index < 40; index++) {
      now += 15000;
      await f.log(id, (`hit ${"x".repeat(1990)}\n`).repeat(20));
      await tool.dispatch(false);
    }
    expect(Buffer.byteLength(await readFile(join(f.root, "watches.json"), "utf8"))).toBeLessThanOrEqual(1024 * 1024);
    await tool.dispose(); tool = open(); await tool.initialize();
    const summaries: ProcessEventSummary[] = [];
    await tool.attach(summary => { summaries.push(summary); return Promise.resolve(); });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.events).toHaveLength(2);
    expect(summaries[0]?.events.find(event => event.attention === "ignore")).toMatchObject({ count: 800, line: 800, samples: [] });
    expect(summaries[0]?.events.find(event => event.attention === "context")?.count).toBe(800);
    expect(summaries[0]?.events.find(event => event.attention === "context")?.samples).toHaveLength(20);
    expect(summaries[0]?.overflow?.samples).toBe(780);
  } finally { await tool.dispose(); }
});

it("samples live repeat cooldown once across batches, expires at 15000ms, and bypasses it for missed matches", async () => {
  let now = 100_000;
  let clockReads = 0;
  const f = await fixture(false, () => { clockReads++; return now; });
  const started = await f.tool.execute({ action: "start", name: "cooldown", command: "cat", notify: { logMatches: [
    { pattern: "hit", repeat: true, on: "context" },
    { pattern: "hit", on: "turn" },
    { pattern: "hit", repeat: true, on: "ignore" },
  ] } });
  const id = started.process?.id;
  if (id === undefined) throw new Error("No ID");
  const lines = Array.from({ length: 2100 }, (_, index) => `hit ${String(index + 1)}${index === 0 ? "x".repeat(2100) : ""}`);
  const append = () => f.log(id, `${lines.join("\n")}\n`);
  await append(); await f.tool.dispatch(false);
  expect(clockReads).toBe(1);
  expect(f.summaries[0]?.events.map(({ attention, count, totalCount, line }) => ({ attention, count, totalCount, line }))).toEqual([
    { attention: "context", count: 2100, totalCount: 2100, line: 2100 },
    { attention: "turn", count: 1, totalCount: 1, line: 1 },
    { attention: "ignore", count: 2100, totalCount: 2100, line: 2100 },
  ]);
  expect(f.summaries[0]?.events[0]?.samples).toEqual(lines.slice(0, 20).map((text, index) => ({ number: index + 1, text: text.slice(0, 2000) })));
  expect(f.summaries[0]?.events[2]?.samples).toEqual([]);

  now = 114_999;
  await append(); await f.tool.dispatch(false);
  expect(clockReads).toBe(2);
  expect(f.summaries).toHaveLength(1);
  expect((await f.core().readOutput(id)).lines).toEqual([]);
  expect((await f.tool.execute({ action: "list" })).processes?.[0]?.watches.map(watch => watch.line)).toEqual([4200, 1, 4200]);

  now = 115_000;
  await append(); await f.tool.dispatch(false);
  expect(clockReads).toBe(3);
  expect(f.summaries[1]?.events.map(({ attention, count, totalCount, line }) => ({ attention, count, totalCount, line }))).toEqual([
    { attention: "context", count: 2100, totalCount: 4200, line: 6300 },
    { attention: "ignore", count: 2100, totalCount: 4200, line: 6300 },
  ]);
  expect(f.summaries[1]?.events[0]?.samples.map(sample => sample.number)).toEqual(Array.from({ length: 20 }, (_, index) => 4201 + index));

  now = 115_001;
  await append(); await f.tool.dispatch(true);
  expect(clockReads).toBe(4);
  expect(f.summaries[2]).toMatchObject({ missed: true, events: [
    { attention: "context", count: 2100, totalCount: 6300, line: 8400 },
    { attention: "ignore", count: 2100, totalCount: 6300, line: 8400, samples: [] },
  ] });
  expect(f.summaries).toHaveLength(3);
});

it.each([
  { result: "success", code: "exited", status: "0", attention: "context", publicStatus: "exited" },
  { result: "exit-code", code: "exited", status: "1", attention: "turn", publicStatus: "exited" },
  { result: "timeout", code: "exited", status: "1", attention: "turn", publicStatus: "terminate_timeout" },
  { result: "signal", code: "killed", status: "TERM", attention: "ignore", publicStatus: "killed" },
  { result: "core-dump", code: "dumped", status: "ABRT", attention: "ignore", publicStatus: "killed" },
  { result: "timeout", code: "killed", status: "KILL", attention: "turn", publicStatus: "terminate_timeout" },
  { result: "timeout", code: "exited", status: "0", attention: "context", publicStatus: "terminate_timeout" },
])("delivers $result/$code/$status exit attention once without changing public status precedence", async ({ result, code, status, attention, publicStatus }) => {
  const f = await fixture(true);
  const started = await f.tool.execute({ action: "start", name: "terminal", command: "cat", notify: {
    onSuccess: "context", onFailure: "turn", onKilled: "ignore", logMatches: [{ pattern: "ready" }],
  } });
  const id = started.process?.id;
  if (id === undefined) throw new Error("No ID");
  await f.log(id, "ready\nfinal tail");
  await f.end(id, { result, code, status });
  await f.tool.dispatch(false);
  expect(f.summaries).toHaveLength(1);
  expect(f.summaries[0]?.events).toEqual([
    expect.objectContaining({ kind: "match", processId: id, line: 1, count: 1 }),
    expect.objectContaining({ kind: "exit", processId: id, watchId: "exit", result, code, status, attention, line: 3, count: 1, samples: [],
      notice: "Attached process: ends when the host restarts." }),
  ]);
  expect((await f.tool.execute({ action: "list" })).processes?.[0]?.status).toBe(publicStatus);
  await f.tool.dispatch(false);
  expect(f.summaries).toHaveLength(1);
  await f.tool.dispose(); await f.core().dispose(); await f.open();
  expect(f.summaries).toHaveLength(1);
});

it("notifies mutation observers outside the tool queue and supports detaching them", async () => {
  const f = await fixture();
  const changes: string[][] = [];
  const detach = f.tool.onChange(async () => {
    const listed = await f.tool.execute({ action: "list" });
    changes.push(listed.processes?.map(process => process.name) ?? []);
  });
  const started = await f.tool.execute({ action: "start", name: "observable", command: "cat" });
  const id = started.process?.id;
  if (id === undefined) throw new Error("Process did not start");
  expect(changes).toEqual([["observable"]]);
  await f.tool.execute({ action: "list" });
  await f.tool.execute({ action: "output", id });
  expect(changes).toHaveLength(1);
  await f.tool.execute({ action: "write", id, input: "hello" });
  await f.tool.execute({ action: "stop", id });
  await f.tool.execute({ action: "clear" });
  expect(changes).toEqual([["observable"], ["observable"], ["observable"], []]);
  detach();
  await f.tool.execute({ action: "start", name: "unobserved", command: "cat" });
  expect(changes).toHaveLength(4);
});
