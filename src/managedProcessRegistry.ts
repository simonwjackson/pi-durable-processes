import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { hasCode } from "./managedProcessFiles.js";
import { prepareManagedProcessLauncher } from "./managedProcessLauncher.js";
import { ManagedProcesses } from "./managedProcesses.js";
import { ManagedProcessTools } from "./processTool.js";
import type { ManagedProcessLauncher } from "./managedProcessTypes.js";

export interface ManagedProcessSession { cwd: string; stateFile: string }

const DEFAULT_LIVENESS_CACHE_MS = 15_000;

export interface ManagedProcessRegistryOptions {
  stateDirectory: string;
  environment?: NodeJS.ProcessEnv;
  buildEnvironment?: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  prepareLauncher?: () => Promise<ManagedProcessLauncher>;
  onError(error: unknown, sessionId: string): void;
  intervalMs?: number;
  logCapBytes?: number;
  /** See ManagedProcessesOptions.livenessCacheMs. Sessiond reuses a running answer for 15 seconds. */
  livenessCacheMs?: number;
  resolveSession?(sessionId: string): Promise<ManagedProcessSession | undefined>;
  onTurn?(sessionId: string): Promise<void>;
}

/** Sessiond ownership, independent of browser connections and agent runtimes. */
export class ManagedProcessRegistry {
  private readonly owners = new Map<string, Promise<ManagedProcesses>>();
  private readonly dispatchers = new Map<string, ManagedProcessTools>();
  private readonly closing = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private maintenance: Promise<void> | undefined;
  private stopped = false;
  constructor(private readonly options: ManagedProcessRegistryOptions) {
    const interval = options.intervalMs ?? 30_000;
    if (!Number.isFinite(interval) || interval <= 0) throw new Error("Managed process maintenance interval must be positive");
  }

  async initialize(onRecovered?: (sessionId: string) => Promise<void>): Promise<void> {
    let entries: Dirent[];
    try { entries = await readdir(join(this.options.stateDirectory, "managed-processes"), { withFileTypes: true }); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; entries = []; }
    for (const entry of entries) {
      // proper-lockfile keeps sibling <session>.lock directories, including after a crash.
      if (!entry.isDirectory() || entry.name.endsWith(".lock")) continue;
      try {
        await this.get(entry.name);
        await onRecovered?.(entry.name);
      } catch (error) {
        // A lazy, unused session may have no catalog entry. Orphans with evidence must
        // remain untouched too. Report this owner, not a fatal failure of sessiond.
        this.options.onError(error, entry.name);
      }
    }
    this.start();
  }

  get(sessionId: string, session?: ManagedProcessSession): Promise<ManagedProcesses> {
    if (this.stopped || this.closing.has(sessionId)) return Promise.reject(new Error("Managed process owner is closing"));
    let owner = this.owners.get(sessionId);
    if (owner === undefined) {
      owner = this.open(sessionId, session);
      this.owners.set(sessionId, owner);
      void owner.catch(() => { if (this.owners.get(sessionId) === owner) this.owners.delete(sessionId); });
      this.start();
    }
    return owner;
  }

  async tools(sessionId: string, session?: ManagedProcessSession): Promise<ManagedProcessTools> {
    await this.get(sessionId, session);
    const dispatcher = this.dispatchers.get(sessionId);
    if (dispatcher === undefined) throw new Error(`No managed process watch location for session ${sessionId}`);
    return dispatcher;
  }

  closeSession(sessionId: string): Promise<void> {
    const existing = this.closing.get(sessionId);
    if (existing !== undefined) return existing;
    const owner = this.get(sessionId);
    const closing = (async () => {
      const processes = await owner;
      await processes.closeSession();
      await this.dispatchers.get(sessionId)?.dispose();
      await processes.dispose();
      this.owners.delete(sessionId);
      this.dispatchers.delete(sessionId);
      await rm(join(this.options.stateDirectory, "managed-processes", sessionId), { recursive: true, force: true });
    })();
    this.closing.set(sessionId, closing);
    void closing.then(() => { this.closing.delete(sessionId); }, () => { this.closing.delete(sessionId); });
    return closing;
  }

  async childFinished(sessionId: string, child: { name: string; runId: string }): Promise<void> {
    if (this.closing.has(sessionId)) { await this.closing.get(sessionId); return; }
    const owner = this.owners.get(sessionId);
    if (owner !== undefined) await (await owner).stopChild(child);
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer); this.timer = undefined;
    await this.maintenance;
    const closing = await Promise.allSettled(this.closing.values());
    const disposed = await Promise.allSettled([...this.owners].map(async ([id, owner]) => {
      const core = await owner;
      await this.dispatchers.get(id)?.dispose();
      await core.dispose();
    }));
    this.dispatchers.clear();
    this.owners.clear();
    const failures: unknown[] = [];
    for (const result of [...closing, ...disposed]) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "Managed process owners could not all be disposed");
  }

  private async open(sessionId: string, session?: ManagedProcessSession): Promise<ManagedProcesses> {
    // Resolve before acquiring/classifying an orphan: even its liveness evidence stays unchanged.
    const resolved = session ?? await this.options.resolveSession?.(sessionId);
    const launcher = await (this.options.prepareLauncher?.() ?? prepareManagedProcessLauncher(this.options.environment));
    const owner = new ManagedProcesses({ stateDirectory: this.options.stateDirectory, sessionId, launcher,
      ...(this.options.buildEnvironment === undefined ? {} : { buildEnvironment: this.options.buildEnvironment }),
      livenessCacheMs: this.options.livenessCacheMs ?? DEFAULT_LIVENESS_CACHE_MS,
      ...(this.options.environment === undefined ? {} : { environment: this.options.environment }),
      ...(this.options.logCapBytes === undefined ? {} : { logCapBytes: this.options.logCapBytes }) });
    // A killed daemon's lease stays fresh for ten seconds. Never bypass a live owner.
    const deadline = Date.now() + 15_000;
    for (;;) {
      try { await owner.initialize(); break; }
      catch (error) { if (!hasCode(error, "ELOCKED") || Date.now() >= deadline) throw error; await sleep(250); }
    }
    try {
      if (resolved !== undefined) {
        const dispatcher = new ManagedProcessTools({ sessionId, ...resolved, getManagedProcesses: () => Promise.resolve(owner) });
        await dispatcher.initialize();
        this.dispatchers.set(sessionId, dispatcher);
        dispatcher.watch(error => { this.options.onError(error, sessionId); },
          this.options.onTurn === undefined ? undefined : () => this.options.onTurn?.(sessionId) ?? Promise.resolve());
      }
      return owner;
    } catch (error) { await owner.dispose(); throw error; }
  }

  private start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const interval = this.options.intervalMs ?? 30_000;
    this.timer = setInterval(() => {
      if (this.maintenance !== undefined) return;
      this.maintenance = this.maintain().finally(() => { this.maintenance = undefined; });
    }, interval);
    this.timer.unref();
  }
  async maintain(): Promise<void> {
    for (const [sessionId, owner] of this.owners) {
      if (this.closing.has(sessionId)) continue;
      try {
        const core = await owner;
        const dispatcher = this.dispatchers.get(sessionId);
        if (dispatcher === undefined) await core.maintain(); // No delivery receipt: preserve finished records.
        else await dispatcher.maintain();
      }
      catch (error) { this.options.onError(error, sessionId); }
    }
  }
}
