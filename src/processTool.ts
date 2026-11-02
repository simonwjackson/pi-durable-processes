import { compactProcessSummary } from "./processEventOutbox.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { atomicWrite, hasCode } from "./managedProcessFiles.js";
import type { ManagedProcesses } from "./managedProcesses.js";
import { ManagedProcessLaunchError, type ManagedProcessInputResult, type ManagedProcessSnapshot } from "./managedProcessTypes.js";
import type { ManagedProcessLogBatch, ManagedProcessLogCursor } from "./managedProcessLog.js";
import { processToolParameters, ProcessToolInputError, type ProcessToolArguments } from "./processToolSchema.js";
import { publicProcess, selectProcesses, type PublicProcess } from "./processToolProjection.js";
import { beginProcessWatchEvaluation } from "./processWatchEvaluation.js";
import { matchPattern, newProcessWatch, processWatchStateSchema, updateProcessWatch, type ProcessEventSummary, type ProcessWatch, type ProcessWatchEvent, type ProcessWatchState } from "./processWatchState.js";

export interface ProcessToolOptions {
  sessionId: string; cwd: string; stateFile: string; now?: () => number;
  getManagedProcesses(sessionId: string): Promise<ManagedProcesses>;
}
export interface ProcessCaller { cwd?: string; child?: { name: string; runId: string } }
export interface ProcessToolResult {
  action: ProcessToolArguments["action"]; process?: PublicProcess; processes?: PublicProcess[];
  lines?: ManagedProcessLogBatch["lines"]; droppedLines?: number; truncated?: boolean;
  input?: ManagedProcessInputResult; eof?: ManagedProcessInputResult; cleared?: PublicProcess[];
  error?: string; id?: string; notice?: string;
}

/** One daemon-owned tool/watch dispatcher per core owner. Runtime bindings only drain the durable outbox. */
export class ManagedProcessTools {
  private state: ProcessWatchState = { version: 1, processes: {} };
  private operations = Promise.resolve();
  private deliver: ((summary: ProcessEventSummary) => Promise<void>) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private requestTurn: (() => Promise<void>) | undefined;
  private report: ((error: unknown) => void) | undefined;
  private wake: Promise<void> | undefined;
  private readonly changeListeners = new Set<() => Promise<void>>();
  constructor(private readonly options: ProcessToolOptions) {}

  async initialize(deliver?: (summary: ProcessEventSummary) => Promise<void>): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    try { this.state = processWatchStateSchema.parse(JSON.parse(await readFile(this.options.stateFile, "utf8"))); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    // Upgrade pre-aggregate pending batches without resetting a watch's cumulative receipt count.
    for (const event of this.state.pending?.summary.events ?? []) {
      if (event.kind !== "match" || event.totalCount !== undefined) continue;
      const watch = this.state.processes[event.processId]?.watches.find(item => item.id === event.watchId);
      if (watch !== undefined) { watch.matched += event.count; event.totalCount = watch.matched; }
    }
    this.deliver = deliver;
    await this.dispatch(true);
  }
  /** Binding does not own the dispatcher or its core lease. Detach before closing the runtime journal. */
  async attach(deliver: (summary: ProcessEventSummary) => Promise<void>): Promise<() => Promise<void>> {
    await this.exclusive(async () => {
      if (this.deliver !== undefined) throw new Error("Process event delivery already has a runtime");
      this.deliver = deliver;
      try { await this.finishPending(await this.core()); }
      catch (error) { this.deliver = undefined; throw error; }
    });
    return () => this.exclusive(() => {
      if (this.deliver === deliver) this.deliver = undefined;
      return Promise.resolve();
    });
  }
  watch(onError: (error: unknown) => void, requestTurn?: () => Promise<void>): void {
    this.report = onError;
    this.requestTurn = requestTurn;
    this.notifyTurn();
    const tick = () => {
      this.timer = setTimeout(() => {
        void this.dispatch(false).catch(onError).finally(() => { if (!this.closed) tick(); });
      }, 1000);
      this.timer.unref();
    };
    if (this.timer === undefined && !this.closed) tick();
  }
  /** Observers run after the mutation line is released, so they can safely list processes. */
  onChange(listener: () => Promise<void>): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.changeListeners.clear();
    clearTimeout(this.timer);
    await this.operations;
  }
  definition(caller: (callId: string) => Promise<ProcessCaller> = () => Promise.resolve({})) {
    return createProcessTool(async (id, args) => this.execute(args, await caller(id)));
  }
  execute(args: ProcessToolArguments, caller: ProcessCaller = {}): Promise<ProcessToolResult> {
    return this.exclusive(async () => {
      if (!Check(processToolParameters, args)) throw new Error("Invalid process arguments");
      const core = await this.core();
      await this.finishPending(core);
      let selected: PublicProcess | undefined;
      let startedId: string | undefined;
      try {
        if (args.action === "start") {
          if (args.name === undefined || args.name.trim() === "" || args.command === undefined || args.command.trim() === "") throw new ProcessToolInputError("start requires name and command");
          const id = randomUUID();
          startedId = id;
          // Commit watch intent before an arbitrary command can exit or the host can crash.
          this.state.processes[id] = newProcessWatch(args.name, args.notify);
          await this.save();
          const snapshot = await core.start({ id, command: args.command, cwd: resolve(caller.cwd ?? this.options.cwd, args.cwd ?? "."),
            ...(caller.child === undefined ? {} : { child: caller.child, keepAfterChild: args.keepAfterChild ?? false }) });
          return { action: args.action, process: publicProcess(snapshot, this.metadata(snapshot)) };
        }
        if (args.action === "list") return { action: args.action, processes: selectProcesses((await core.list()).map(snapshot => publicProcess(snapshot, this.metadata(snapshot))), args) };
        if (args.action === "clear") {
          await this.dispatchNow(false, core);
          const before = (await core.list()).map(snapshot => publicProcess(snapshot, this.metadata(snapshot)));
          const removed = await core.clearFinished();
          this.state.processes = Object.fromEntries(Object.entries(this.state.processes).filter(([id]) => !removed.includes(id)));
          await this.save();
          return { action: args.action, cleared: before.filter(process => removed.includes(process.id)) };
        }
        if (args.id === undefined) throw new ProcessToolInputError(`${args.action} requires id`);
        const snapshot = await core.status(args.id);
        const watch = this.metadata(snapshot);
        selected = publicProcess(snapshot, watch);
        if (args.action === "output") return { action: args.action, process: selected, ...await this.output(core, args.id, args) };
        if (snapshot.state.kind !== "running") throw new ProcessToolInputError("Process has ended");
        if (args.action === "stop") {
          watch.stopped = true;
          await this.save(); // An intentional stop must not create exit noise after a restart.
          await core.stop(args.id);
        } else if (args.action === "write") {
          if ((args.input === undefined || args.input === "") && args.end !== true) throw new ProcessToolInputError("write requires input or end: true");
          const input = await core.writeStdin(args.id, args.input ?? "");
          const eof = args.end === true && input.kind === "written" ? await core.closeStdin(args.id) : undefined;
          return { action: args.action, process: selected, input, ...(eof === undefined ? {} : { eof }) };
        } else {
          const next = updateProcessWatch(watch, args); // Validate before delivering or mutating anything.
          await this.dispatchNow(false, core); // New watches begin at the current event-reader position.
          // Preserve delivery state changed by the dispatch above, including once-only watches.
          const updated = updateProcessWatch(this.metadata(snapshot), args);
          updated.name = next.name;
          if (args.keepAfterChild !== undefined && snapshot.child !== undefined) await core.setKeepAfterChild(args.id, args.keepAfterChild);
          this.state.processes[args.id] = updated;
          await this.save();
        }
        return { action: args.action, process: publicProcess(await core.status(args.id), this.metadata(snapshot)) };
      } catch (error) {
        if (error instanceof ManagedProcessLaunchError) {
          try {
            const snapshot = await core.status(error.id);
            selected = publicProcess(snapshot, this.metadata(snapshot));
          } catch { /* Inspection is unavailable too; return the saved ID, never private launcher errors. */ }
        }
        // Core launch errors redact argv/environment. Never serialize an Error object or a raw snapshot.
        return { action: args.action, ...(selected === undefined ? {} : { process: selected }),
          ...(startedId === undefined ? {} : { id: startedId, notice: "If this is an attached process, it ends when the host restarts." }), error: error instanceof ProcessToolInputError || error instanceof ManagedProcessLaunchError ? error.message : "Managed process operation failed; inspect its status before retrying" };
      }
    }).then(async result => {
      // Failed launches and partial writes can still change the saved process or its output.
      if (args.action !== "list" && args.action !== "output") {
        await Promise.all([...this.changeListeners].map(listener => listener()));
      }
      return result;
    });
  }
  dispatch(missed: boolean): Promise<void> {
    return this.exclusive(async () => this.dispatchNow(missed, await this.core())).then(() => { this.notifyTurn(); });
  }
  /** Spooling and retention share the tool mutation line; only terminal receipts authorize deletion. */
  maintain(): Promise<void> {
    return this.exclusive(async () => {
      const core = await this.core();
      await this.spoolNow(false, core);
      await core.maintain(Object.entries(this.state.processes).filter(([, watch]) => watch.exitDelivered).map(([id]) => id));
      const retained = new Set((await core.list()).map(record => record.id));
      const before = Object.keys(this.state.processes).length;
      this.state.processes = Object.fromEntries(Object.entries(this.state.processes).filter(([id]) => retained.has(id)));
      if (Object.keys(this.state.processes).length !== before) await this.save();
      await this.drainOutbox();
    }).then(() => { this.notifyTurn(); });
  }
  private notifyTurn(): void {
    const pending = this.state.pending;
    const request = this.requestTurn;
    if (this.closed || this.deliver !== undefined || request === undefined || pending === undefined
      || (pending.summary.turnRequired !== true && !pending.summary.events.some(event => event.attention === "turn")) || this.wake !== undefined) return;
    // Never await runtime startup on the dispatcher mutation line: startup attaches to that same line.
    this.wake = Promise.resolve().then(request).catch((error: unknown) => { this.report?.(error); })
      .finally(() => { this.wake = undefined; });
  }
  private core(): Promise<ManagedProcesses> { return this.options.getManagedProcesses(this.options.sessionId); }
  private metadata(snapshot: ManagedProcessSnapshot): ProcessWatch {
    if (Object.hasOwn(this.state.processes, snapshot.id)) {
      const known = this.state.processes[snapshot.id];
      if (known !== undefined) return known;
    }
    return this.state.processes[snapshot.id] = newProcessWatch(snapshot.id);
  }
  private save(): Promise<void> {
    if (this.state.pending !== undefined) this.state.pending.summary = compactProcessSummary(this.state.pending.summary);
    return atomicWrite(this.options.stateFile, JSON.stringify(this.state));
  }
  private async finishPending(core: ManagedProcesses): Promise<void> {
    await this.acknowledgePending(core);
    await this.drainOutbox();
  }
  private async acknowledgePending(core: ManagedProcesses): Promise<void> {
    const pending = this.state.pending;
    if (pending === undefined) return;
    // The fsynced outbox, not a live model, now owns these events. A passive session can stay closed.
    // Acknowledgement is still dispatcher-only, and always follows durable spooling.
    for (const [id, cursor] of Object.entries(pending.cursors)) {
      try { await core.acknowledgeOutput(id, cursor); }
      catch (error) {
        // Finished-record retention can remove an already accepted log before acknowledgement.
        if (!hasCode(error, "ENOENT")) throw error;
      }
    }
    if (Object.keys(pending.cursors).length > 0) {
      pending.cursors = {};
      await this.save();
    }
  }
  private async drainOutbox(): Promise<void> {
    const pending = this.state.pending;
    if (pending === undefined) return;
    if (pending.summary.events.length > 0 || pending.summary.overflow !== undefined || pending.summary.turnRequired === true) {
      if (this.deliver === undefined) return;
      await this.deliver(pending.summary);
    }
    delete this.state.pending;
    await this.save();
  }
  private async dispatchNow(missed: boolean, core: ManagedProcesses): Promise<void> {
    await this.spoolNow(missed, core);
    await this.drainOutbox();
  }
  private async spoolNow(missed: boolean, core: ManagedProcesses): Promise<void> {
    // On resume, combine the saved outbox and new events. Consumers deduplicate accepted lines.
    // Retry cursor publication first; no runtime is needed to make spooled records reclaimable.
    await this.acknowledgePending(core);
    const previous = structuredClone(this.state);
    const pending = this.state.pending;
    const events: ProcessWatchEvent[] = [...pending?.summary.events ?? []];
    const cursors: Record<string, ManagedProcessLogCursor> = { ...pending?.cursors };
    try {
      for (const snapshot of await core.list()) {
        const watch = this.metadata(snapshot);
        const evaluation = beginProcessWatchEvaluation(snapshot, watch, {
          missed, now: () => this.options.now?.() ?? Date.now(), notice: publicProcess(snapshot, watch).notice,
        });
        if (evaluation === undefined) continue;
        let cursor: ManagedProcessLogCursor | undefined = pending?.cursors[snapshot.id];
        for (;;) {
          const batch = await core.readOutput(snapshot.id, cursor === undefined ? {} : { cursor });
          evaluation.accept(batch.lines);
          if (batch.lines.length > 0 || batch.droppedLines > 0) cursors[snapshot.id] = batch.cursor;
          if (batch.lines.length < 1000) break;
          cursor = batch.cursor;
        }
        events.push(...evaluation.finish(cursors[snapshot.id]?.line ?? 0));
      }
      if (events.length === 0 && Object.keys(cursors).length === 0) {
        if (JSON.stringify(this.state) !== JSON.stringify(previous)) await this.save();
        return;
      }
      // A previous delivery might have committed before the daemon died. New events need a fresh
      // wake receipt; unchanged retries reuse theirs. The consumer deduplicates old process/watch/lines.
      const id = events.length === pending?.summary.events.length ? pending.summary.id : randomUUID();
      this.state.pending = { summary: { ...pending?.summary, id, seriesId: pending?.summary.seriesId ?? pending?.summary.id ?? id,
        missed: missed || (pending?.summary.missed ?? false), events }, cursors };
      await this.save();
    } catch (error) { this.state = previous; throw error; }
    await this.acknowledgePending(core);
  }
  private async output(core: ManagedProcesses, id: string, args: ProcessToolArguments) {
    const matches = args.pattern === undefined ? () => true : matchPattern(args.pattern, args.mode);
    const tail = args.tailLines ?? 100;
    let cursor: ManagedProcessLogCursor = { offset: 0, line: 1 };
    let lines: ManagedProcessLogBatch["lines"] = []; let droppedLines = 0;
    for (;;) {
      const batch = await core.readOutput(id, { cursor, maxLines: 10_000 });
      droppedLines += batch.droppedLines;
      lines = [...lines, ...batch.lines.filter(line => matches(line.text))].slice(-tail);
      cursor = batch.cursor;
      if (batch.lines.length < 10_000) break;
    }
    // Bound model output without changing the durable event-reader position.
    let bytes = 0; let truncated = false;
    lines = lines.slice().reverse().flatMap(line => {
      const remaining = 50 * 1024 - bytes;
      if (remaining <= 0) { truncated = true; return []; }
      const encoded = Buffer.from(line.text); bytes += encoded.length;
      if (encoded.length <= remaining) return [line];
      truncated = true; return [{ ...line, text: encoded.subarray(0, remaining).toString("utf8") }];
    }).reverse();
    return { lines, droppedLines, truncated };
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(() => {
      if (this.closed) throw new Error("Process tool runtime is closed");
      return operation();
    });
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Register the same tool contract in an embedded host or a raw pi extension. */
export function createProcessTool(execute: (callId: string, args: ProcessToolArguments) => Promise<ProcessToolResult>) {
    return defineTool({ name: "process", label: "Process", parameters: processToolParameters,
      description: "Start, list, stop, inspect output, write stdin, update watches, and clear managed processes. Managed processes survive the host restarts; attached processes do not. Child processes end with their child run unless keepAfterChild is true. stdout/stderr are merged.",
      promptSnippet: "Manage long-running commands with process. After start, move on or end your turn; log watches and exits notify you.",
      promptGuidelines: ["Use process instead of &, nohup, or setsid. Check list before starting duplicates.",
        "turn wakes you; context records without waking; ignore records without model delivery. Do not poll or sleep for readiness: use notify.logMatches.",
        "Read the processes skill for actions and child handoff. Use stdbuf -oL for programs that still hold back output."],
      execute: async (id, args) => {
        const result = await execute(id, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(result.error === undefined ? {} : { isError: true }) };
      },
    });
}
