import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { prepareManagedProcessLauncher } from "./managedProcessLauncher.js";
import { ManagedProcesses, type ManagedProcessesOptions } from "./managedProcesses.js";
import { createProcessTool, ManagedProcessTools } from "./processTool.js";
import type { ProcessEventSummary } from "./processWatchState.js";

export interface DurableProcessesExtensionOptions {
  stateDirectory?: string;
  prepareLauncher?: () => ReturnType<typeof prepareManagedProcessLauncher>;
  buildEnvironment?: ManagedProcessesOptions["buildEnvironment"];
}
interface Owner { core: ManagedProcesses; tools: ManagedProcessTools }

/** State is host-local, never in pi's potentially synchronized settings directory. */
function stateDirectory(): string {
  return process.env["PI_DURABLE_PROCESSES_STATE_DIR"] ?? join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "pi-durable-processes");
}

export function processEventText(summary: ProcessEventSummary): string {
  const lines = summary.events.filter(event => event.attention !== "ignore").map(event =>
    `${event.name} (${event.processId}), ${event.attention}: ${event.kind === "exit" ? `ended: ${event.reason ?? `${event.result ?? "ended"}: ${event.code ?? ""} ${event.status ?? ""}`}`
      : `${String(event.count)} log match(es), through line ${String(event.line)}${event.samples.slice(0, 3).map(line => `\n  ${String(line.number)}: ${line.text.slice(0, 300)}`).join("")}`}`);
  if (summary.overflow !== undefined) lines.unshift(`[Pending detail omitted: ${String(summary.overflow.turn + summary.overflow.context)} matches; ${String(summary.overflow.samples)} samples removed. Read process output for details.]`);
  return `${summary.missed ? "Missed managed process events" : "Managed process events"}:\n${lines.join("\n")}`.slice(0, 32_000);
}

/** Pi's sendMessage enqueues synchronously, but does not expose a durable acceptance receipt. */
export function deliverProcessEvents(pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">, summary: ProcessEventSummary): Promise<void> {
  const visible = summary.events.filter(event => event.attention !== "ignore");
  const turn = summary.turnRequired === true || visible.some(event => event.attention === "turn") || (summary.overflow?.turn ?? 0) > 0;
  if (!turn && visible.length === 0 && (summary.overflow?.context ?? 0) === 0) pi.appendEntry("durable-processes.events", summary);
  else pi.sendMessage({ customType: "durable-processes.events", content: processEventText(summary), display: false,
    details: { ...summary, events: visible } }, { triggerTurn: turn, deliverAs: "followUp" });
  return Promise.resolve();
}

/** Raw pi owns only its active session. Leaving it releases the lease, not systemd processes. */
export function createDurableProcessesExtension(options: DurableProcessesExtensionOptions = {}): ExtensionFactory {
  return (pi) => {
    let owner: Owner | undefined;
    const dispose = async () => {
      const previous = owner; owner = undefined;
      if (previous === undefined) return;
      try { await previous.tools.dispose(); } finally { await previous.core.dispose(); }
    };
    pi.registerTool(createProcessTool((_id, args) => {
      if (owner === undefined) throw new Error("Managed processes are unavailable; session startup failed or the session is closing");
      return owner.tools.execute(args);
    }));
    pi.on("session_start", async (_event, ctx) => {
      await dispose();
      const directory = options.stateDirectory ?? stateDirectory();
      if (!isAbsolute(directory)) throw new Error("PI_DURABLE_PROCESSES_STATE_DIR must be absolute");
      const sessionId = ctx.sessionManager.getSessionId();
      const launcher = await (options.prepareLauncher?.() ?? prepareManagedProcessLauncher());
      const core = new ManagedProcesses({ stateDirectory: directory, sessionId, launcher,
        ...(options.buildEnvironment === undefined ? {} : { buildEnvironment: options.buildEnvironment }) });
      await core.initialize();
      const tools = new ManagedProcessTools({ sessionId, cwd: ctx.cwd, stateFile: join(directory, "watches", `${sessionId}.json`), getManagedProcesses: () => Promise.resolve(core) });
      owner = { core, tools };
      try {
        await tools.initialize(summary => deliverProcessEvents(pi, summary));
        tools.watch(() => { ctx.ui.notify("Managed process watch failed; inspect process list/output before retrying", "error"); });
      } catch (error) { await dispose(); throw error; }
    });
    pi.on("session_shutdown", dispose);
  };
}

export default createDurableProcessesExtension();
