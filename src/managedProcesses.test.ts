import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedProcesses } from "./managedProcesses.js";
import type { ManagedProcessLauncher, ManagedProcessRecord } from "./managedProcessTypes.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "managed-core-")); directories.push(path); return path; }
function controlledLauncher() {
  const live = new Set<string>();
  const started: ManagedProcessRecord[] = [];
  const launcher: ManagedProcessLauncher = {
    supervision: { kind: "systemd" },
    launch: (record) => { started.push(record); live.add(record.id); return Promise.resolve(); },
    inspect: (record) => Promise.resolve(live.has(record.id) ? "running" : "gone"),
    stop: (record) => { live.delete(record.id); return Promise.resolve(); },
    stopSession: () => { live.clear(); return Promise.resolve(); },
    release: () => Promise.resolve(),
  };
  return { launcher, live, started };
}

describe("managed processes", () => {
  it("persists child ownership and explicit keep updates across owners", async () => {
    const root = await directory(); const { launcher } = controlledLauncher();
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "child-owner", launcher });
    await manager.initialize();
    try {
      await manager.start({ id: "one", command: "cat", cwd: root, child: { name: "worker", runId: "run-1" } });
      await manager.setKeepAfterChild("one", true);
      await manager.dispose();
      await manager.initialize();
      expect(await manager.status("one")).toMatchObject({ child: { name: "worker", runId: "run-1" }, keepAfterChild: true });
      await manager.setKeepAfterChild("one", false);
      expect((await manager.status("one")).keepAfterChild).toBe(false);
    } finally { await manager.dispose(); }
  });
  it("retains only the newest 50 finished records and clears finished folders, never running ones", async () => {
    const root = await directory(); const { launcher, live } = controlledLauncher();
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "retention", launcher });
    await manager.initialize();
    try {
      await manager.start({ id: "running", command: "cat", cwd: root });
      for (let n = 0; n < 52; n++) {
        const record = await manager.start({ id: `ended-${String(n).padStart(2, "0")}`, command: "true", cwd: root });
        await writeFile(join(record.directory, "result"), "success\nexited\n0\n");
        live.delete(record.id);
      }
      await manager.maintain();
      expect((await manager.list()).filter(record => record.state.kind !== "running")).toHaveLength(52);
      await manager.maintain((await manager.list()).filter(record => record.state.kind !== "running").map(record => record.id));
      expect((await manager.list()).map((item) => item.id)).toEqual([...Array.from({ length: 50 }, (_, n) => `ended-${String(n + 2).padStart(2, "0")}`), "running"]);
      await expect(readFile(join(root, "managed-processes/retention/ended-00/command.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await manager.start({ id: "lost", command: "cat", cwd: root });
      live.delete("lost");
      const cleared = await manager.clearFinished();
      expect(cleared).toHaveLength(51);
      expect(cleared).toContain("lost");
      await expect(readFile(join(root, "managed-processes/retention/lost/command.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await manager.list()).map((item) => item.id)).toEqual(["running"]);
    } finally { await manager.dispose(); }
  });
  it("releases each finished record once, across reads and owners, and retries a failed release", async () => {
    const root = await directory(); const { launcher, live } = controlledLauncher();
    const released: string[] = [];
    let failNext = false;
    launcher.release = (record) => {
      if (failNext) { failNext = false; return Promise.reject(new Error("systemctl failed")); }
      released.push(record.id); return Promise.resolve();
    };
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "release-once", launcher });
    await manager.initialize();
    try {
      const ended = await manager.start({ id: "ended", command: "true", cwd: root });
      await writeFile(join(ended.directory, "result"), "success\nexited\n0\n");
      live.delete("ended");
      await manager.start({ id: "lost", command: "cat", cwd: root });
      live.delete("lost");
      await manager.start({ id: "running", command: "cat", cwd: root });
      for (let n = 0; n < 5; n++) await manager.list();
      await manager.status("ended");
      await manager.maintain();
      expect(released.sort()).toEqual(["ended", "lost"]);
      await manager.dispose();
      await manager.initialize();
      await manager.list();
      expect(released.sort()).toEqual(["ended", "lost"]);
      const late = await manager.start({ id: "late", command: "true", cwd: root });
      await writeFile(join(late.directory, "result"), "success\nexited\n0\n");
      live.delete("late");
      failNext = true;
      await expect(manager.list()).rejects.toThrow("systemctl failed");
      await manager.list();
      await manager.list();
      expect(released.filter((id) => id === "late")).toEqual(["late"]);
    } finally { await manager.dispose(); }
  });
  it("reuses a running answer for the liveness window, but sees exits, stops and expiry at once", async () => {
    const root = await directory(); const { launcher, live } = controlledLauncher();
    const inspected: string[] = [];
    const inspect = launcher.inspect.bind(launcher);
    launcher.inspect = (record) => { inspected.push(record.id); return inspect(record); };
    let now = 1_000_000;
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "liveness", launcher, livenessCacheMs: 15_000, now: () => now });
    await manager.initialize();
    try {
      const exits = await manager.start({ id: "exits", command: "true", cwd: root });
      await manager.start({ id: "stopped", command: "cat", cwd: root });
      await manager.start({ id: "vanishes", command: "cat", cwd: root });
      inspected.length = 0;
      for (let n = 0; n < 5; n++) { await manager.list(); await manager.readOutput("vanishes"); now += 1000; }
      expect(inspected).toEqual([]);
      // A published result wins at once, inside the window.
      await writeFile(join(exits.directory, "result"), "success\nexited\n0\n");
      live.delete("exits");
      expect((await manager.status("exits")).state.kind).toBe("ended");
      // An explicit stop forgets the answer, so the next read asks the supervisor.
      await manager.stop("stopped");
      expect((await manager.status("stopped")).state.kind).toBe("lost");
      expect(inspected).toEqual(["stopped"]);
      // A supervisor that vanishes without a result is seen once the window ends.
      live.delete("vanishes");
      expect((await manager.status("vanishes")).state.kind).toBe("running");
      now += 10_001;
      expect((await manager.status("vanishes")).state.kind).toBe("lost");
      expect(inspected).toEqual(["stopped", "vanishes"]);
    } finally { await manager.dispose(); }
  });
  it("asks the supervisor on every read when no liveness window is set", async () => {
    const root = await directory(); const { launcher } = controlledLauncher();
    let inspections = 0;
    const inspect = launcher.inspect.bind(launcher);
    launcher.inspect = (record) => { inspections++; return inspect(record); };
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "no-window", launcher });
    await manager.initialize();
    try {
      await manager.start({ id: "one", command: "cat", cwd: root });
      await manager.list(); await manager.list();
      expect(inspections).toBe(3);
    } finally { await manager.dispose(); }
  });
  it("gives one owner the session lease and releases it without stopping durable processes", async () => {
    const root = await directory(); const { launcher } = controlledLauncher();
    const first = new ManagedProcesses({ stateDirectory: root, sessionId: "lease", launcher });
    const second = new ManagedProcesses({ stateDirectory: root, sessionId: "lease", launcher });
    await first.initialize();
    try {
      await first.start({ id: "one", command: "cat", cwd: root });
      await expect(second.initialize()).rejects.toMatchObject({ code: "ELOCKED" });
      await first.dispose();
      expect((await second.initialize())[0]?.state.kind).toBe("running");
    } finally { await first.dispose(); await second.dispose(); }
  });
  it("keeps failed launch intent, but never retries it during recovery", async () => {
    const root = await directory(); const { launcher, started } = controlledLauncher();
    launcher.launch = () => Promise.reject(new Error("client died before receiving the launch reply"));
    const first = new ManagedProcesses({ stateDirectory: root, sessionId: "uncertain", launcher });
    await first.initialize();
    try { await expect(first.start({ id: "one", command: "do-not-repeat", cwd: root })).rejects.toMatchObject({ name: "ManagedProcessLaunchError", id: "one" }); }
    finally { await first.dispose(); }
    const second = new ManagedProcesses({ stateDirectory: root, sessionId: "uncertain", launcher });
    try {
      expect((await second.initialize())[0]?.state.kind).toBe("lost");
      expect(started).toEqual([]);
    } finally { await second.dispose(); }
  });
  it("reads a result published between first lookup and supervisor inspection", async () => {
    const root = await directory(); const { launcher } = controlledLauncher();
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "result-race", launcher });
    try {
      await manager.initialize(); const record = await manager.start({ id: "one", command: "cat", cwd: root });
      launcher.inspect = async () => { await writeFile(join(record.directory, "result"), "signal\nkilled\nKILL\n"); return "gone"; };
      expect((await manager.status("one")).state).toEqual({ kind: "ended", result: { result: "signal", code: "killed", status: "KILL" } });
    } finally { await manager.dispose(); }
  });
  it("recovers running, ended and lost processes without ever re-running commands", async () => {
    const root = await directory();
    const { launcher, live, started } = controlledLauncher();
    const first = new ManagedProcesses({ stateDirectory: root, sessionId: "session-a", launcher });
    await first.initialize();
    const running = await first.start({ id: "running", command: "cat", cwd: root });
    const ended = await first.start({ id: "ended", command: "exit 7", cwd: root });
    await first.start({ id: "lost", command: "do-not-repeat", cwd: root });
    live.delete("ended"); live.delete("lost");
    await writeFile(join(ended.directory, "result"), "exit-code\nexited\n7\n");
    await first.dispose();
    const second = new ManagedProcesses({ stateDirectory: root, sessionId: "session-a", launcher });
    try {
      const records = await second.initialize();
      expect(records.map((record) => [record.id, record.state])).toEqual([
        ["ended", { kind: "ended", result: { result: "exit-code", code: "exited", status: "7" } }],
        ["lost", { kind: "lost" }],
        ["running", { kind: "running" }],
      ]);
      expect(started).toHaveLength(3);
      expect(records.find((record) => record.id === "running")?.directory).toBe(running.directory);
      live.add("lost");
      expect((await second.status("lost")).state.kind).toBe("lost");
      await expect(second.start({ id: "lost", command: "repeat", cwd: root })).rejects.toThrow();
    } finally { await second.dispose(); }
  });

  it("persists read acknowledgements and leaves unread output available after restart", async () => {
    const root = await directory(); const { launcher } = controlledLauncher();
    const first = new ManagedProcesses({ stateDirectory: root, sessionId: "reads", launcher });
    await first.initialize();
    const record = await first.start({ id: "one", command: "cat", cwd: root });
    await writeFile(join(record.directory, "output.log"), "first\nsecond\npartial");
    const batch = await first.readOutput("one");
    expect(batch.lines.map((line) => line.text)).toEqual(["first", "second"]);
    expect((await first.readOutput("one")).lines).toEqual(batch.lines);
    await first.acknowledgeOutput("one", batch.cursor);
    await first.dispose();
    const second = new ManagedProcesses({ stateDirectory: root, sessionId: "reads", launcher });
    try {
      await second.initialize();
      expect((await second.readOutput("one")).lines).toEqual([]);
      await writeFile(join(record.directory, "result"), "success\nexited\n0\n");
      const tail = await second.readOutput("one");
      expect(tail.lines).toEqual([{ number: 3, text: "partial", terminated: false, truncatedStart: false }]);
      await second.acknowledgeOutput("one", tail.cursor);
      expect((await second.readOutput("one")).lines).toEqual([]);
    } finally { await second.dispose(); }
  });

  it("drops the output of a lost process whose log a crash emptied, so the session still opens", async () => {
    const root = await directory(); const { launcher, live } = controlledLauncher();
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "crash", launcher });
    await manager.initialize();
    try {
      const record = await manager.start({ id: "one", command: "cat", cwd: root });
      await writeFile(join(record.directory, "output.log"), "first\nsecond\n");
      const batch = await manager.readOutput("one");
      await manager.acknowledgeOutput("one", batch.cursor);
      // A power cut loses the log's data blocks but keeps the saved reader and the pending cursor.
      await writeFile(join(record.directory, "output.log"), "");
      live.delete("one");
      await manager.maintain();
      expect(await manager.lastOutput("one")).toBeNull();
      await expect(manager.acknowledgeOutput("one", batch.cursor)).resolves.toBeUndefined();
      const browse = await manager.readOutput("one", { cursor: { offset: 0, line: 1 } });
      expect(browse).toEqual({ lines: [], cursor: { offset: 0, line: 3 }, droppedLines: 2 });
      expect((await manager.readTail("one", 10)).lines).toEqual([]);
      expect((await manager.status("one")).state.kind).toBe("lost");
    } finally { await manager.dispose(); }
  });

  it("keeps a truncated log of a running process an error", async () => {
    const root = await directory(); const { launcher } = controlledLauncher();
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "live-cut", launcher });
    await manager.initialize();
    try {
      const record = await manager.start({ id: "one", command: "cat", cwd: root });
      await writeFile(join(record.directory, "output.log"), "first\n");
      await manager.acknowledgeOutput("one", (await manager.readOutput("one")).cursor);
      await writeFile(join(record.directory, "output.log"), "");
      await expect(manager.maintain()).rejects.toThrow("externally truncated");
      await expect(manager.readOutput("one")).rejects.toThrow("externally truncated");
      expect(JSON.parse(await readFile(join(record.directory, "read-position.json"), "utf8"))).toMatchObject({ read: { offset: 6, line: 2 } });
    } finally { await manager.dispose(); }
  });

  it("does not classify manager inspection failures as lost", async () => {
    const root = await directory(); const { launcher } = controlledLauncher();
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "errors", launcher });
    try {
      await manager.initialize(); await manager.start({ id: "one", command: "cat", cwd: root });
      launcher.inspect = () => Promise.reject(new Error("manager unavailable"));
      await expect(manager.status("one")).rejects.toThrow("manager unavailable");
      await expect(readFile(join(root, "managed-processes/errors/one/lost.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await manager.dispose(); }
  });

  it("rejects invalid boundaries before creating a process and filters the agent environment", async () => {
    const root = await directory(); const { launcher, started } = controlledLauncher();
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "validation", launcher,
      environment: { PATH: "/agent/bin", PC_SOCKET: "/private", INVOCATION_ID: "private-id", NODE_ENV: "development", PORT: "12", HOME: root, PI_WEB_DOCKER_HOST: "safe" } });
    try {
      await manager.initialize();
      await expect(manager.start({ id: "../escape", command: "cat", cwd: root })).rejects.toThrow();
      await expect(manager.start({ command: "cat", cwd: "relative" })).rejects.toThrow();
      await expect(manager.start({ command: "cat", cwd: root, stopTimeoutSeconds: 0 })).rejects.toThrow();
      await manager.start({ command: "echo '$HOME'", cwd: root });
      expect(started[0]?.environment).toEqual({ PATH: "/agent/bin", HOME: root, NODE_ENV: "development", PORT: "12", PI_WEB_DOCKER_HOST: "safe", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", GFORTRAN_UNBUFFERED_ALL: "y", NSUnbufferedIO: "YES", NO_COLOR: "1" });
    } finally { await manager.dispose(); }
  });
});

describe("panel output tail", () => {
  /** The browse algorithm the panel used before readTail: every batch is a separate admission. */
  async function browsedTail(manager: ManagedProcesses, id: string, tailLines: number) {
    let cursor = { offset: 0, line: 1 };
    let lines: Awaited<ReturnType<ManagedProcesses["readOutput"]>>["lines"] = [];
    let droppedLines = 0;
    for (;;) {
      const batch = await manager.readOutput(id, { cursor, maxLines: 1000 });
      const combined = [...lines, ...batch.lines];
      lines = combined.slice(-tailLines);
      droppedLines += batch.droppedLines + combined.length - lines.length;
      cursor = batch.cursor;
      if (batch.lines.length < 1000) return { lines, cursor, droppedLines };
    }
  }
  const body = (count: number) => Array.from({ length: count }, (_, index) => `line ${String(index + 1)} ${"x".repeat(40)}\n`).join("");

  it("returns the same running tail as a full browse with one supervisor inspection and no acknowledgement", async () => {
    const root = await directory(); const { launcher } = controlledLauncher();
    let inspections = 0;
    const inspect = launcher.inspect.bind(launcher);
    launcher.inspect = (record) => { inspections++; return inspect(record); };
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "tail", launcher });
    await manager.initialize();
    try {
      const record = await manager.start({ id: "one", command: "cat", cwd: root });
      await writeFile(join(record.directory, "output.log"), `${body(25_001)}unfinished`);
      inspections = 0;
      const tail = await manager.readTail("one", 50);
      expect(inspections).toBe(1);
      expect(tail).toEqual(await browsedTail(manager, "one", 50));
      expect(tail.lines).toHaveLength(50);
      expect(tail.lines.at(-1)).toMatchObject({ number: 25_001, terminated: true });
      expect(tail.droppedLines).toBe(24_951);
      // The durable watch reader still starts at the first line.
      expect((await manager.readOutput("one", { maxLines: 1 })).lines[0]?.number).toBe(1);
    } finally { await manager.dispose(); }
  });

  it("matches a full browse on a retained ended log, including the base and the final unterminated line", async () => {
    const root = await directory(); const { launcher } = controlledLauncher();
    const manager = new ManagedProcesses({ stateDirectory: root, sessionId: "tail-retained", launcher, logCapBytes: 64 * 1024 });
    await manager.initialize();
    try {
      const record = await manager.start({ id: "one", command: "cat", cwd: root });
      await writeFile(join(record.directory, "output.log"), `${body(12_000)}final`);
      await writeFile(join(record.directory, "result"), "success\nexited\n0\n");
      const tail = await manager.readTail("one", 200);
      expect(tail).toEqual(await browsedTail(manager, "one", 200));
      expect(tail.lines.at(-1)).toEqual({ number: 12_001, text: "final", terminated: false, truncatedStart: false });
      expect(tail.droppedLines).toBe(11_801);
      const short = await manager.readTail("one", 5000);
      expect(short).toEqual(await browsedTail(manager, "one", 5000));
      expect(short.lines[0]?.number).toBeGreaterThan(1);
    } finally { await manager.dispose(); }
  });
});
