import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const text = z.string().refine((value) => !value.includes("\0"), "NUL is not allowed");
const absolutePath = text.refine((value) => value.startsWith("/") && !/[\r\n]/.test(value), "An absolute Unix path is required");
const child = z.object({ name: text.min(1), runId: text.min(1) });
const timeout = z.number().min(0.1).max(3600);
export const managedProcessStartSchema = z.object({
  id: identifier.optional(), command: text.min(1), cwd: absolutePath,
  stopTimeoutSeconds: timeout.optional(),
  child: child.optional(), keepAfterChild: z.boolean().optional(),
});
export type ManagedProcessStart = z.infer<typeof managedProcessStartSchema>;

/** Deliberately omits the execFile error: its argv can contain provider credentials. */
export class ManagedProcessLaunchError extends Error {
  override readonly name = "ManagedProcessLaunchError";
  constructor(readonly id: string) {
    super(`Managed process ${id} launch failed or was not confirmed. Inspect its saved record and unit before any retry.`);
  }
}
export const managedProcessRecordSchema = z.object({
  version: z.literal(1), child: child.optional(), keepAfterChild: z.boolean().optional(), id: identifier, sessionId: identifier,
  command: text.min(1), cwd: absolutePath, directory: absolutePath,
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), text),
  stopTimeoutSeconds: timeout, createdAt: z.iso.datetime(),
  supervision: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("systemd") }),
    z.object({ kind: z.literal("attached"), instance: z.uuid() }),
  ]),
});
export type ManagedProcessRecord = z.infer<typeof managedProcessRecordSchema>;
export interface ManagedProcessResult { result: string; code: string; status: string }
export type ManagedProcessState = { kind: "running" } | { kind: "ended"; result: ManagedProcessResult } | { kind: "lost" };
export type ManagedProcessSnapshot = ManagedProcessRecord & { state: ManagedProcessState };

/** No launcher ever re-runs a saved command. Inspection errors must reject, not return gone. */
export interface ManagedProcessLauncher {
  readonly supervision: ManagedProcessRecord["supervision"];
  launch(record: ManagedProcessRecord): Promise<void>;
  inspect(record: ManagedProcessRecord): Promise<"running" | "gone">;
  stop(record: ManagedProcessRecord): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  /** Called only after the terminal record is safely on disk. Idempotent. */
  release(record: ManagedProcessRecord): Promise<void>;
}
export type ManagedProcessInputResult =
  | { kind: "written"; bytesWritten: number }
  | { kind: "stdin-full"; bytesWritten: number }
  | { kind: "stdin-closed"; bytesWritten: number };
