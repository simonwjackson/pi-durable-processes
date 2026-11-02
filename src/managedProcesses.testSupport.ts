import type { ManagedProcessLauncher, ManagedProcessRecord } from "./managedProcessTypes.js";

export function controlledManagedProcessLauncher() {
  const live = new Set<string>();
  const stoppedSessions: string[] = [];
  const stopped: string[] = [];
  const started: ManagedProcessRecord[] = [];
  const key = (record: ManagedProcessRecord) => `${record.sessionId}/${record.id}`;
  const launcher: ManagedProcessLauncher = {
    supervision: { kind: "systemd" },
    launch: (record) => { started.push(record); live.add(key(record)); return Promise.resolve(); },
    inspect: (record) => Promise.resolve(live.has(key(record)) ? "running" : "gone"),
    stop: (record) => { stopped.push(key(record)); live.delete(key(record)); return Promise.resolve(); },
    stopSession: (sessionId) => {
      stoppedSessions.push(sessionId);
      for (const id of live) if (id.startsWith(`${sessionId}/`)) live.delete(id);
      return Promise.resolve();
    },
    release: () => Promise.resolve(),
  };
  return { launcher, live, started, stopped, stoppedSessions };
}
