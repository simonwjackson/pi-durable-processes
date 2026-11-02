import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicWrite, hasCode } from "./managedProcessFiles.js";
import { managedProcessControlEnvKeys } from "./managedProcessEnvironment.js";
import type { ManagedProcessLauncher, ManagedProcessRecord } from "./managedProcessTypes.js";

const execute = promisify(execFile);

/** Hash only the session component: UUID dashes would create many ancestor slices. */
export function managedProcessUnits(sessionId: string, id: string): { slice: string; unit: string } {
  const session = createHash("sha256").update(sessionId).digest("hex");
  return { slice: `forgerie-proc-${session}.slice`, unit: `forgerie-proc-${session}-${id}.service` };
}
function unitArgument(value: string): string {
  return JSON.stringify(value.replaceAll("$", "$$"));
}

export class SystemdManagedProcessLauncher implements ManagedProcessLauncher {
  readonly supervision = { kind: "systemd" } as const;
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async launch(record: ManagedProcessRecord): Promise<void> {
    const { unit, slice } = managedProcessUnits(record.sessionId, record.id);
    const output = join(record.directory, "output.log");
    const hook = ["/bin/sh", join(record.directory, "result.sh"), record.directory].map(unitArgument).join(" ");
    // A user manager can have a different environment from Forgerie. Do not
    // accidentally reintroduce daemon-only keys through manager inheritance.
    const inherited = (await this.control(["show-environment"])).stdout.split("\n").map((line) => line.split("=")[0] ?? "");
    const unset = [...new Set([...managedProcessControlEnvKeys, ...inherited.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !Object.hasOwn(record.environment, key))])];
    await execute("systemd-run", ["--user", "--collect", `--unit=${unit}`, `--slice=${slice}`, "--expand-environment=no",
      "--property=Type=exec", "--property=KillMode=control-group", "--property=Restart=no",
      `--property=WorkingDirectory=${record.cwd}`, `--property=TimeoutStopSec=${String(record.stopTimeoutSeconds)}`,
      "--property=StandardInput=null", `--property=StandardOutput=append:${output}`, `--property=StandardError=append:${output}`,
      `--property=ExecStopPost=${hook}`,
      `--property=UnsetEnvironment=${unset.join(" ")}`,
      ...Object.entries(record.environment).map(([key, value]) => `--setenv=${key}=${value}`),
      "--", "/bin/sh", join(record.directory, "keeper.sh"), join(record.directory, "stdin"), "/bin/sh", "-c", record.command,
    ], { env: this.environment, timeout: 30_000, maxBuffer: 64 * 1024 });
  }
  async inspect(record: ManagedProcessRecord): Promise<"running" | "gone"> {
    if (record.supervision.kind === "attached") return "gone";
    const state = await this.unitState(managedProcessUnits(record.sessionId, record.id).unit);
    if (["active", "activating", "deactivating", "reloading"].includes(state)) return "running";
    if (["inactive", "failed"].includes(state)) return "gone";
    throw new Error(`Cannot inspect managed process ${record.id}: ${state}`);
  }
  async stop(record: ManagedProcessRecord): Promise<void> {
    if (record.supervision.kind === "attached") return;
    await this.stopUnit(managedProcessUnits(record.sessionId, record.id).unit);
  }
  async stopSession(sessionId: string): Promise<void> { await this.stopUnit(managedProcessUnits(sessionId, "unused").slice); }
  async release(record: ManagedProcessRecord): Promise<void> {
    if (record.supervision.kind === "attached") return;
    const unit = managedProcessUnits(record.sessionId, record.id).unit;
    // --collect normally did this already. Clear failures left by an interrupted
    // launch or older launcher, but never reset someone else's units with a glob.
    if (await this.unitState(unit) === "failed") await this.control(["reset-failed", unit]);
  }
  private async stopUnit(unit: string): Promise<void> {
    if (await this.unitState(unit) !== "inactive") await this.control(["stop", "--no-block", unit]);
  }
  private async unitState(unit: string): Promise<string> {
    const { stdout } = await this.control(["show", unit, "--property=ActiveState", "--value"]);
    return stdout.trim();
  }
  private control(args: string[]) { return execute("systemctl", ["--user", ...args], { env: this.environment, timeout: 5000, maxBuffer: 64 * 1024 }); }
}

interface AttachedChild {
  record: ManagedProcessRecord;
  child: ChildProcess;
  finished: Promise<void>;
  exited: boolean;
}
export class AttachedManagedProcessLauncher implements ManagedProcessLauncher {
  readonly supervision = { kind: "attached", instance: randomUUID() } as const;
  private readonly children = new Map<string, AttachedChild>();
  async launch(record: ManagedProcessRecord): Promise<void> {
    const output = await open(join(record.directory, "output.log"), "a");
    try {
      const child = spawn("/bin/sh", [join(record.directory, "keeper.sh"), join(record.directory, "stdin"), String(record.stopTimeoutSeconds), "/bin/sh", "-c", record.command], {
        cwd: record.cwd, env: record.environment, detached: true, stdio: ["ignore", output.fd, output.fd, "ignore", "pipe"],
      });
      const entry: AttachedChild = { record, child, finished: Promise.resolve(), exited: false };
      this.children.set(record.directory, entry);
      entry.finished = new Promise<void>((resolve, reject) => {
        child.once("error", (error) => {
          entry.exited = true;
          atomicWrite(join(record.directory, "result"), `launch-error\n\n${error.name}\n`).then(resolve, reject);
        });
        child.once("exit", (code, signal) => {
          entry.exited = true;
          try { signalGroup(child, "SIGKILL"); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
          child.stdio[4]?.destroy();
          const result = signal === null ? `${code === 0 ? "success" : "exit-code"}\nexited\n${String(code)}\n` : `signal\nkilled\n${signal.replace(/^SIG/, "")}\n`;
          atomicWrite(join(record.directory, "result"), result).then(resolve, reject);
        });
      });
      // Keep a rejected completion observable through inspect/release, without
      // creating an unhandled rejection before the next caller polls it.
      void entry.finished.catch(() => undefined);
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    } finally { await output.close(); }
  }
  async inspect(record: ManagedProcessRecord): Promise<"running" | "gone"> {
    if (record.supervision.kind === "systemd") throw new Error("Systemd user manager is unavailable; cannot inspect saved managed processes");
    const entry = this.children.get(record.directory);
    if (record.supervision.instance !== this.supervision.instance || entry === undefined) return "gone";
    if (!entry.exited) return "running";
    await entry.finished;
    return "gone";
  }
  stop(record: ManagedProcessRecord): Promise<void> {
    if (record.supervision.kind === "systemd") throw new Error("Systemd user manager is unavailable; cannot stop saved managed processes");
    const entry = this.children.get(record.directory);
    if (entry === undefined || entry.exited) return Promise.resolve();
    // The same lifeline helper handles explicit stop and abrupt parent death.
    // Its timeout remains effective even if Forgerie dies midway through stop.
    entry.child.stdio[4]?.destroy();
    return Promise.resolve();
  }
  async stopSession(sessionId: string): Promise<void> {
    const entries = [...this.children.values()].filter((entry) => entry.record.sessionId === sessionId);
    await Promise.all(entries.map(async (entry) => { await this.stop(entry.record); await entry.finished; }));
  }
  async release(record: ManagedProcessRecord): Promise<void> {
    const entry = this.children.get(record.directory);
    if (entry?.exited === true) { await entry.finished; this.children.delete(record.directory); }
  }
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (!hasCode(error, "ESRCH")) throw error; }
}

/** Same user-manager probe as LocalWorkspaceServicesLauncher.prepare(). */
export async function prepareManagedProcessLauncher(environment: NodeJS.ProcessEnv = process.env): Promise<ManagedProcessLauncher> {
  if (process.platform === "win32") throw new Error("Managed processes require a Unix-like host");
  try { await access("/bin/sh", constants.X_OK); }
  catch (cause) { throw new Error("Managed processes require an executable /bin/sh", { cause }); }
  try {
    await execute("systemctl", ["--user", "show", "--property=SystemState"], { env: environment, timeout: 5000 });
    return new SystemdManagedProcessLauncher(environment);
  } catch { return new AttachedManagedProcessLauncher(); }
}
