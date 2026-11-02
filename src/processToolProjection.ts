import { join } from "node:path";
import type { ManagedProcessSnapshot } from "./managedProcessTypes.js";
import type { ProcessWatch } from "./processWatchState.js";
import type { ProcessToolArguments } from "./processToolSchema.js";

/** Allowlist only. A snapshot contains the private launch environment. */
export function publicProcess(snapshot: ManagedProcessSnapshot, watch: ProcessWatch) {
  const result = snapshot.state.kind === "ended" ? snapshot.state.result : undefined;
  const success = result?.code === "exited" && result.status === "0";
  const status: "running" | "terminating" | "terminate_timeout" | "killed" | "exited" = snapshot.state.kind === "running" ? (watch.stopped ? "terminating" : "running")
    : result?.result === "timeout" ? "terminate_timeout" : result?.code === "killed" || result?.code === "dumped" ? "killed" : "exited";
  return {
    id: snapshot.id, name: watch.name, command: snapshot.command, cwd: snapshot.cwd, startTime: Date.parse(snapshot.createdAt),
    state: snapshot.state.kind === "running" ? "running" : "ended", status, success,
    ...(snapshot.state.kind === "lost" ? { reason: "supervisor lost" } : {}),
    ...(result === undefined ? {} : { result: result.result, exitCode: result.code === "exited" ? Number(result.status) : null, signal: result.code === "exited" ? null : result.status }),
    stdoutFile: join(snapshot.directory, "output.log"), stderrFile: join(snapshot.directory, "output.log"),
    outputNote: "stdout and stderr share one ordered log; stream selectors inspect this merged output.",
    supervision: snapshot.supervision.kind,
    ...(snapshot.supervision.kind === "attached" ? { notice: "Attached process: ends when the host restarts." } : {}),
    ...(snapshot.child === undefined ? {} : { child: { name: snapshot.child.name, runId: snapshot.child.runId }, keepAfterChild: snapshot.keepAfterChild ?? false }),
    watches: watch.watches.map(({ pattern, mode, stream, repeat, on, fired, line }) => ({ pattern, mode, stream, repeat, on, fired, line })),
  };
}
export type PublicProcess = ReturnType<typeof publicProcess>;
export function selectProcesses(processes: PublicProcess[], args: ProcessToolArguments): PublicProcess[] {
  const filters = args.statuses ?? [];
  const selected = processes.filter(process => filters.length === 0 || filters.includes("all") || filters.some(filter =>
    filter === "finished" ? process.status === "exited" && process.success
      : filter === "failed" ? process.status === "terminate_timeout" || (process.status === "exited" && !process.success) : process.status === filter));
  selected.sort((a, b) => {
    switch (args.sortBy ?? "startTime_desc") {
      case "startTime_desc": return b.startTime - a.startTime;
      case "startTime_asc": return a.startTime - b.startTime;
      case "name_asc": return a.name.localeCompare(b.name);
      case "name_desc": return b.name.localeCompare(a.name);
      case "status_asc": return a.status.localeCompare(b.status);
    }
  });
  return args.limit !== undefined && args.limit > 0 ? selected.slice(0, Math.floor(args.limit)) : selected;
}
