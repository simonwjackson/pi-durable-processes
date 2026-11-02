import { AttachedManagedProcessLauncher } from "./managedProcessLauncher.js";
import { mkdtemp, mkdir, readFile, rm, writeFile, access, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ManagedProcessRegistry } from "./managedProcessRegistry.js";
import { controlledManagedProcessLauncher } from "./managedProcesses.testSupport.js";

const roots: string[] = [];
const registries: ManagedProcessRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "managed-registry-")); roots.push(root);
  const control = controlledManagedProcessLauncher();
  const errors: unknown[] = [];
  const registry = () => {
    const registry = new ManagedProcessRegistry({ stateDirectory: root, prepareLauncher: () => Promise.resolve(control.launcher),
      intervalMs: 10, logCapBytes: 8, onError: (error) => { errors.push(error); } });
    registries.push(registry); return registry;
  };
  return { root, ...control, errors, registry };
}

it("shares concurrent ownership, resumes all saved sessions, and maintains unread logs on a schedule", async () => {
  const f = await fixture(); const first = f.registry();
  const [a, b] = await Promise.all([first.get("idle"), first.get("idle")]);
  expect(a).toBe(b);
  const record = await a.start({ id: "one", command: "cat", cwd: f.root });
  await first.dispose();
  expect(f.stoppedSessions).toEqual([]);
  await writeFile(join(record.directory, "output.log"), "first\nsecond\nthird\n");
  // An abruptly killed owner can leave this sibling directory behind.
  const staleLease = join(f.root, "managed-processes/idle.lock");
  await mkdir(staleLease);
  const stale = new Date(Date.now() - 20_000);
  await utimes(staleLease, stale, stale);
  const second = f.registry(); await second.initialize();
  await vi.waitFor(async () => {
    const position = await readFile(join(record.directory, "read-position.json"), "utf8");
    expect(position).toContain('"base":{"offset":11');
  });
  expect(f.started).toHaveLength(1);
  expect((await (await second.get("idle")).status("one")).state.kind).toBe("running");
  expect(f.errors).toEqual([]);
});

it("stops the slice before deleting records and logs, and rejects stale owner starts", async () => {
  const f = await fixture(); const registry = f.registry(); const owner = await registry.get("closed");
  const record = await owner.start({ id: "one", command: "cat", cwd: f.root });
  const stop = f.launcher.stopSession.bind(f.launcher);
  f.launcher.stopSession = async (id) => { await access(join(record.directory, "command.json")); await stop(id); };
  await registry.closeSession("closed");
  expect(f.stoppedSessions).toEqual(["closed"]);
  expect(f.live.size).toBe(0);
  await expect(access(join(f.root, "managed-processes/closed"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(owner.start({ command: "cat", cwd: f.root })).rejects.toThrow();
});

it("retains records and logs on stop failure and permits a close retry", async () => {
  const f = await fixture(); const registry = f.registry(); const owner = await registry.get("closed");
  const record = await owner.start({ id: "one", command: "cat", cwd: f.root });
  const stop = f.launcher.stopSession.bind(f.launcher);
  f.launcher.stopSession = () => Promise.reject(new Error("manager unavailable"));
  await expect(registry.closeSession("closed")).rejects.toThrow("manager unavailable");
  await access(join(record.directory, "command.json"));
  expect(f.live.size).toBe(1);
  f.launcher.stopSession = stop;
  await registry.closeSession("closed");
  expect(f.live.size).toBe(0);
});

it("stops only the finishing child run, retaining kept, session-owned, and second-run processes", async () => {
  const f = await fixture(); const registry = f.registry(); const owner = await registry.get("parent");
  for (const [id, runId, keepAfterChild] of [["first", "run-1", false], ["kept", "run-1", true], ["second", "run-2", false]] as const) {
    await owner.start({ id, command: "cat", cwd: f.root, child: { name: "worker", runId }, keepAfterChild });
  }
  await owner.start({ id: "session", command: "cat", cwd: f.root });
  await registry.childFinished("parent", { name: "worker", runId: "run-1" });
  expect(f.stopped).toEqual(["parent/first"]);
  expect((await owner.status("second")).state.kind).toBe("running");
  await registry.childFinished("parent", { name: "worker", runId: "run-2" });
  expect(f.stopped).toEqual(["parent/first", "parent/second"]);
  expect((await owner.status("kept")).state.kind).toBe("running");
  expect((await owner.status("session")).state.kind).toBe("running");
});

it("closes a real attached command before removing its files", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-attached-close-")); roots.push(root);
  const registry = new ManagedProcessRegistry({ stateDirectory: root, prepareLauncher: () => Promise.resolve(new AttachedManagedProcessLauncher()),
    onError: (error) => { throw error; } });
  registries.push(registry);
  const owner = await registry.get("attached");
  const record = await owner.start({ id: "one", command: "printf ready; exec /bin/cat", cwd: root });
  expect(record.supervision.kind).toBe("attached");
  await vi.waitFor(async () => { expect(await readFile(join(record.directory, "output.log"), "utf8")).toContain("ready"); });
  await registry.closeSession("attached");
  await expect(access(record.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reuses a running answer across the maintenance passes of the sessiond default window", async () => {
  const f = await fixture(); const registry = f.registry(); const owner = await registry.get("busy");
  let inspections = 0;
  const inspect = f.launcher.inspect.bind(f.launcher);
  f.launcher.inspect = (record) => { inspections++; return inspect(record); };
  await owner.start({ id: "one", command: "cat", cwd: f.root });
  // intervalMs is 10, so this spans many maintenance passes, all inside the 15-second window.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await owner.list();
  expect(inspections).toBe(1);
  expect(f.errors).toEqual([]);
});

it("applies the host environment builder before portable environment hygiene", async () => {
  const f = await fixture();
  const registry = new ManagedProcessRegistry({ stateDirectory: f.root, prepareLauncher: () => Promise.resolve(f.launcher),
    environment: { HOST_SECRET: "private", PATH: "/bin", NODE_ENV: "development", INVOCATION_ID: "manager" },
    buildEnvironment: environment => Object.fromEntries(Object.entries(environment).filter(([key]) => key !== "HOST_SECRET")),
    onError: error => { throw error; } });
  registries.push(registry);
  const owner = await registry.get("injection");
  await owner.start({ command: "exit 0", cwd: f.root });
  expect(f.started[0]?.environment).toMatchObject({ PATH: "/bin", NODE_ENV: "development", PYTHONUNBUFFERED: "1" });
  expect(f.started[0]?.environment).not.toHaveProperty("HOST_SECRET");
  expect(f.started[0]?.environment).not.toHaveProperty("INVOCATION_ID");
});
