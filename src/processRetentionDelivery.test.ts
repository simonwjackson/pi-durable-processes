import { controlledManagedProcessLauncher } from "./managedProcesses.testSupport.js";
import { ManagedProcesses } from "./managedProcesses.js";
import { ManagedProcessTools } from "./processTool.js";
import { mkdtemp, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ManagedProcessRegistry } from "./managedProcessRegistry.js";
import { AttachedManagedProcessLauncher } from "./managedProcessLauncher.js";
import type { ProcessEventSummary } from "./processWatchState.js";

it("spools all 51 attached-process matches and exits before keeping only 50 finished records", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-retention-events-"));
  const errors: unknown[] = [];
  const create = () => new ManagedProcessRegistry({ stateDirectory: root, prepareLauncher: () => Promise.resolve(new AttachedManagedProcessLauncher()),
    intervalMs: 60000, onError: error => { errors.push(error); } });
  let registry = create();
  const location = { cwd: root, stateFile: join(root, "retention.process-watches.json") };
  const tool = await registry.tools("retention", location);
  const core = await registry.get("retention");
  const summaries: ProcessEventSummary[] = [];
  try {
    for (let index = 0; index < 51; index++) {
      const started = await tool.execute({ action: "start", name: `attached-${String(index)}`, command: "printf 'watched\\n'", notify: { onSuccess: "ignore", logMatches: [{ pattern: "watched", on: "ignore" }] } });
      expect(started.error).toBeUndefined();
    }
    await vi.waitFor(async () => { expect((await core.list()).filter(record => record.state.kind === "running")).toHaveLength(0); });
    await registry.maintain();
    expect((await core.list())).toHaveLength(50);
    expect(summaries).toHaveLength(0);
    await registry.dispose(); registry = create();
    const restored = await registry.tools("retention", location);
    const detach = await restored.attach(summary => { summaries.push(summary); return Promise.resolve(); });
    expect(summaries).toHaveLength(1);
    await detach();
    expect(summaries.flatMap(summary => summary.events).filter(event => event.kind === "match")).toHaveLength(51);
    expect(summaries.flatMap(summary => summary.events).filter(event => event.kind === "exit")).toHaveLength(51);
    expect(errors).toEqual([]);
  } finally { await registry.dispose(); await rm(root, { recursive: true, force: true }); }
}, 15000);

it("does not reclaim unread records when outbox persistence fails, but can reclaim after spooling even if runtime delivery fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-outbox-failure-"));
  const control = controlledManagedProcessLauncher();
  const core = new ManagedProcesses({ sessionId: "failure", stateDirectory: root, launcher: control.launcher });
  const watchDir = join(root, "watches");
  const stateFile = join(watchDir, "failure.process-watches.json");
  const tool = new ManagedProcessTools({ sessionId: "failure", cwd: root, stateFile, getManagedProcesses: () => Promise.resolve(core) });
  await core.initialize(); await tool.initialize();
  try {
    for (let index = 0; index < 51; index++) {
      const result = await tool.execute({ action: "start", name: `one-${String(index)}`, command: "printf ready", notify: { logMatches: [{ pattern: "ready" }] } });
      expect(result.error).toBeUndefined();
    }
    for (const record of control.started) {
      await writeFile(join(record.directory, "output.log"), "ready\n");
      await writeFile(join(record.directory, "result"), "success\nexited\n0\n");
    }
    await rename(watchDir, join(root, "saved-watches"));
    await expect(tool.maintain()).rejects.toMatchObject({ code: "ENOENT" });
    expect(await core.list()).toHaveLength(51);
    const first = control.started[0];
    if (first === undefined) throw new Error("No process");
    expect((await core.readOutput(first.id)).lines).toHaveLength(1);
    await rename(join(root, "saved-watches"), watchDir);
    const detach = await tool.attach(() => Promise.reject(new Error("Runtime journal unavailable")));
    await expect(tool.maintain()).rejects.toThrow("Runtime journal unavailable");
    expect(await core.list()).toHaveLength(50);
    await detach();
    const summaries: ProcessEventSummary[] = [];
    await tool.attach(summary => { summaries.push(summary); return Promise.resolve(); });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.events.filter(event => event.kind === "match")).toHaveLength(51);
    expect(summaries[0]?.events.filter(event => event.kind === "exit")).toHaveLength(51);
  } finally { await tool.dispose(); await core.dispose(); await rm(root, { recursive: true, force: true }); }
});
