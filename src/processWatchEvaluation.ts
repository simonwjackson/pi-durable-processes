import type { ManagedProcessLogBatch } from "./managedProcessLog.js";
import type { ManagedProcessSnapshot } from "./managedProcessTypes.js";
import { matchPattern, type ProcessWatch, type ProcessWatchEvent } from "./processWatchState.js";

interface ProcessWatchEvaluation {
  accept(lines: Readonly<ManagedProcessLogBatch["lines"]>): void;
  finish(line: number): ProcessWatchEvent[];
}
interface ProcessWatchEvaluationOptions {
  missed: boolean;
  now: () => number;
  notice: string | undefined;
}

/** One scan mutates dispatcher-owned watch state; its caller rolls it back if spooling fails. */
export function beginProcessWatchEvaluation(
  snapshot: Pick<ManagedProcessSnapshot, "id" | "state">,
  watch: ProcessWatch,
  options: ProcessWatchEvaluationOptions,
): ProcessWatchEvaluation | undefined {
  if (snapshot.state.kind !== "running" && watch.exitDelivered) return undefined;
  const { notice } = options;
  const matches = new Map<string, ProcessWatchEvent>();
  const now = options.now();
  // Eligibility is fixed for the whole scan, not recomputed after a match or a batch.
  // Offline lines have no timestamps; missed dispatch bypasses the live 15-second cooldown.
  const predicates = new Map(watch.watches.map(item => [item.id,
    !options.missed && item.repeat && item.fired && now - item.lastNotifiedAt < 15_000 ? () => false : matchPattern(item.pattern, item.mode)]));
  return {
    accept(lines) {
      for (const item of watch.watches) {
        for (const line of lines) {
          if (line.number <= item.line || (item.fired && !item.repeat)) continue;
          item.line = line.number;
          if (predicates.get(item.id)?.(line.text) !== true) continue;
          item.fired = true; item.lastNotifiedAt = now; item.matched++;
          let event = matches.get(item.id);
          if (event === undefined) {
            event = { processId: snapshot.id, name: watch.name, watchId: item.id, kind: "match", attention: item.on, line: line.number, count: 0, samples: [], ...(notice === undefined ? {} : { notice }) };
            matches.set(item.id, event);
          }
          event.line = line.number; event.count++; event.totalCount = item.matched;
          if (item.on !== "ignore" && event.samples.length < 20) event.samples.push({ number: line.number, text: line.text.slice(0, 2000) });
        }
      }
    },
    finish(line) {
      const events = [...matches.values()];
      // Use the pre-read snapshot: a process that exits during the read is terminal on the next scan.
      if (snapshot.state.kind !== "running" && !watch.exitDelivered) {
        watch.exitDelivered = true;
        if (!watch.stopped) {
          const result = snapshot.state.kind === "ended" ? snapshot.state.result : undefined;
          const attention = result?.code === "exited" && result.status === "0" ? watch.onSuccess
            : result?.result === "timeout" ? watch.onFailure : result?.code === "killed" || result?.code === "dumped" ? watch.onKilled : watch.onFailure;
          events.push({ processId: snapshot.id, name: watch.name, watchId: "exit", kind: "exit", attention, line,
            count: 1, samples: [], ...(snapshot.state.kind === "lost" ? { reason: "supervisor lost" } : { result: result?.result, code: result?.code, status: result?.status }),
            ...(notice === undefined ? {} : { notice }) });
        }
      }
      return events;
    },
  };
}
