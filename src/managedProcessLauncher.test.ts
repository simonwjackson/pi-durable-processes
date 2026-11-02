import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProcessFiles } from "./managedProcessIo.js";
import { readResult } from "./managedProcessFiles.js";
import { AttachedManagedProcessLauncher, managedProcessUnits, prepareManagedProcessLauncher } from "./managedProcessLauncher.js";
import { ManagedProcesses } from "./managedProcesses.js";
import type { ManagedProcessInputResult, ManagedProcessSnapshot } from "./managedProcessTypes.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "attached-process-")); directories.push(directory);
  const launcher = new AttachedManagedProcessLauncher();
  const manager = new ManagedProcesses({ stateDirectory: directory, sessionId: "attached", launcher, environment: { PATH: process.env["PATH"], HOME: directory } });
  await manager.initialize();
  return { directory, launcher, manager };
}
async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 200; index++) { const value = await read(); if (accept(value)) return value; await delay(10); }
  throw new Error("Managed process did not reach the expected state");
}
const ended = (snapshot: ManagedProcessSnapshot) => snapshot.state.kind === "ended";
const written = (result: ManagedProcessInputResult) => result.kind === "written";

describe("attached managed process launcher", () => {
  it("selects attached supervision when the user-manager probe cannot run", async () => {
    expect((await prepareManagedProcessLauncher({ PATH: "/nonexistent" })).supervision.kind).toBe("attached");
  });
  it("uses one session slice without accidental UUID ancestor slices", () => {
    const first = managedProcessUnits("a-b-c", "one");
    const second = managedProcessUnits("a-b-c", "two");
    expect(first.slice).toBe(second.slice);
    expect(first.unit).not.toBe(second.unit);
    expect(first.slice).toMatch(/^forgerie-proc-[a-f0-9]{64}\.slice$/);
    expect(managedProcessUnits("a_b_c", "one").slice).not.toBe(first.slice);
  });
  it("keeps stdin open across writers, records exact exit and marks every record attached", async () => {
    const { manager, directory } = await setup();
    try {
      const record = await manager.start({ id: "reader", cwd: directory, command: "while IFS= read -r line; do printf '%s\\n' \"$line\"; done; printf tail; exit 7" });
      expect(record.supervision.kind).toBe("attached");
      await waitFor(() => manager.writeStdin("reader", "first\n"), written);
      await delay(30);
      expect((await manager.status("reader")).state.kind).toBe("running");
      expect(await manager.writeStdin("reader", "second\n")).toEqual({ kind: "written", bytesWritten: 7 });
      await waitFor(() => manager.closeStdin("reader"), written);
      const snapshot = await waitFor(() => manager.status("reader"), ended);
      expect(snapshot.state).toEqual({ kind: "ended", result: { result: "exit-code", code: "exited", status: "7" } });
      expect((await manager.readOutput("reader")).lines.map((line) => line.text)).toEqual(["first", "second", "tail"]);
      expect((await manager.writeStdin("reader", "no reader")).kind).toBe("stdin-closed");
      expect((await manager.closeStdin("reader")).kind).toBe("stdin-closed");
    } finally { await manager.dispose(); }
  });
  it("returns stdin-full with an exact partial byte count instead of blocking", async () => {
    const { manager, directory } = await setup();
    try {
      await manager.start({ id: "full", cwd: directory, command: "exec sleep 30" });
      const result = await waitFor(() => manager.writeStdin("full", Buffer.alloc(1024 * 1024)), (value) => value.kind !== "stdin-closed");
      expect(result.kind).toBe("stdin-full");
      expect(result.bytesWritten).toBeGreaterThan(0);
      expect(result.bytesWritten).toBeLessThan(1024 * 1024);
      expect(await manager.writeStdin("full", "x")).toEqual({ kind: "stdin-full", bytesWritten: 0 });
    } finally { await manager.dispose(); }
  });
  it("escalates a TERM-ignoring attached process and ends attached processes on disposal", async () => {
    const { manager, directory } = await setup();
    try {
      const record = await manager.start({ id: "stubborn", cwd: directory, stopTimeoutSeconds: 0.1,
        command: "trap '' TERM; printf ready; while :; do sleep 1; done" });
      await waitFor(() => readFile(join(record.directory, "output.log"), "utf8"), (value) => value === "ready");
      await manager.stop("stubborn");
      expect((await waitFor(() => manager.status("stubborn"), ended)).state).toEqual({ kind: "ended", result: { result: "signal", code: "killed", status: "KILL" } });
      const other = await manager.start({ id: "other", cwd: directory, command: "exec sleep 30" });
      await manager.dispose();
      expect(await readFile(join(other.directory, "result"), "utf8")).toContain("TERM");
    } finally { await manager.dispose(); }
  });
  it("reports records of a previous attached launcher as lost, never as running PIDs", async () => {
    const { manager, directory } = await setup();
    const record = await manager.start({ id: "old", cwd: directory, command: "exit 0" });
    await waitFor(() => manager.status("old"), ended);
    await manager.dispose();
    await rm(join(record.directory, "result"));
    const resumed = new ManagedProcesses({ stateDirectory: directory, sessionId: "attached", launcher: new AttachedManagedProcessLauncher() });
    try { expect((await resumed.initialize())[0]?.state.kind).toBe("lost"); }
    finally { await resumed.dispose(); }
  });
  it("fails closed on corrupt durable state", async () => {
    const { manager, directory } = await setup();
    try {
      const record = await manager.start({ id: "corrupt", cwd: directory, command: "exit 0" });
      await waitFor(() => manager.status("corrupt"), ended);
      await writeFile(join(record.directory, "result"), "success");
      await expect(manager.status("corrupt")).rejects.toThrow("Invalid managed process result");
    } finally { await manager.dispose(); }
  });
});


describe("durable result hook", () => {
  it.each([
    ["success", "exited", "0"],
    ["exit-code", "exited", "3"],
    ["timeout", "killed", "KILL"],
    ["signal", "killed", "KILL"],
  ])("records %s/%s/%s without Node or the caller's PATH", async (result, code, status) => {
    const directory = await mkdtemp(join(tmpdir(), 'managed-result %h $HOME "quote"-')); directories.push(directory);
    await prepareProcessFiles({
      version: 1, id: "result", sessionId: "hook", directory, cwd: directory,
      command: "exit 0", environment: {}, stopTimeoutSeconds: 1,
      createdAt: new Date().toISOString(), supervision: { kind: "systemd" },
    });
    // Publication must replace the previous inode, not truncate it.
    // The hook needs no systemd manager.
    await writeFile(join(directory, "result"), "previous\nexited\n1\n");
    const before = await stat(join(directory, "result"));
    await promisify(execFile)("/bin/sh", [join(directory, "result.sh"), directory], {
      env: { PATH: "/nonexistent", SERVICE_RESULT: result, EXIT_CODE: code, EXIT_STATUS: status },
    });
    expect(await readFile(join(directory, "result"), "utf8")).toBe(`${result}\n${code}\n${status}\n`);
    expect(await readResult(directory)).toEqual({ result, code, status });
    const after = await stat(join(directory, "result"));
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    await expect(stat(join(directory, "result.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
