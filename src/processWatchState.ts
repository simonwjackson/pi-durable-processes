import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProcessToolInputError, type ProcessToolArguments } from "./processToolSchema.js";

const attention = z.enum(["turn", "context", "ignore"]);
const cursor = z.object({ offset: z.number().int().nonnegative(), line: z.number().int().positive() });
const watch = z.object({
  id: z.string(), pattern: z.string().min(1).max(500), mode: z.enum(["literal", "regex"]),
  stream: z.enum(["stdout", "stderr", "both"]), repeat: z.boolean(), on: attention,
  line: z.number().int().nonnegative(), matched: z.number().int().nonnegative().default(0), fired: z.boolean(), lastNotifiedAt: z.number().nonnegative().default(0),
});
export const processWatchSchema = z.object({
  name: z.string(), onSuccess: attention, onFailure: attention, onKilled: attention,
  watches: z.array(watch).max(20), stopped: z.boolean(), exitDelivered: z.boolean(),
});
export type ProcessWatch = z.infer<typeof processWatchSchema>;
const event = z.object({
  processId: z.string(), name: z.string(), watchId: z.string(), attention,
  kind: z.enum(["match", "exit"]), line: z.number().int().nonnegative(), count: z.number().int().positive(),
  samples: z.array(z.object({ number: z.number().int().positive(), text: z.string() })),
  reason: z.string().optional(), notice: z.string().optional(),
  result: z.string().optional(), code: z.string().optional(), status: z.string().optional(),
  totalCount: z.number().int().nonnegative().optional(),
});
export type ProcessWatchEvent = z.infer<typeof event>;
export const processOverflowSchema = z.object({
  turn: z.number().int().nonnegative(), context: z.number().int().nonnegative(), ignore: z.number().int().nonnegative(),
  samples: z.number().int().nonnegative(), aggregates: z.number().int().nonnegative(),
});
export type ProcessOverflow = z.infer<typeof processOverflowSchema>;
export const processSummarySchema = z.object({ id: z.string(), missed: z.boolean(), events: z.array(event),
  seriesId: z.string().optional(), overflow: processOverflowSchema.optional(), turnRequired: z.boolean().optional(),
});
export type ProcessEventSummary = z.infer<typeof processSummarySchema>;
export const processWatchStateSchema = z.object({
  version: z.literal(1), processes: z.record(z.string(), processWatchSchema),
  pending: z.object({ summary: processSummarySchema, cursors: z.record(z.string(), cursor) }).optional(),
});
export type ProcessWatchState = z.infer<typeof processWatchStateSchema>;

export function matchPattern(pattern: string, mode: "literal" | "regex" = "literal"): (text: string) => boolean {
  if (pattern.trim() === "") throw new ProcessToolInputError("Log patterns must not be empty or whitespace-only");
  if (mode === "literal") return (text) => text.includes(pattern);
  let regex: RegExp;
  try { regex = new RegExp(pattern); } catch { throw new ProcessToolInputError("Invalid log regular expression"); }
  return (text) => regex.test(text);
}
function watches(items: NonNullable<NonNullable<ProcessToolArguments["notify"]>["logMatches"]>): ProcessWatch["watches"] {
  return items.map(item => {
    matchPattern(item.pattern, item.mode);
    return { id: randomUUID(), pattern: item.pattern, mode: item.mode ?? "literal", stream: item.stream ?? "both", repeat: item.repeat ?? false,
      on: item.on ?? "turn", line: 0, matched: 0, fired: false, lastNotifiedAt: 0 };
  });
}
export function newProcessWatch(name: string, notify?: ProcessToolArguments["notify"]): ProcessWatch {
  return { name, onSuccess: notify?.onSuccess ?? "turn", onFailure: notify?.onFailure ?? "turn", onKilled: notify?.onKilled ?? "context",
    watches: watches(notify?.logMatches ?? []), stopped: false, exitDelivered: false };
}
export function updateProcessWatch(current: ProcessWatch, args: ProcessToolArguments): ProcessWatch {
  const next = structuredClone(current);
  if (args.name !== undefined) {
    if (args.name.trim() === "") throw new ProcessToolInputError("Process name must not be empty");
    next.name = args.name;
  }
  if (args.notify !== undefined) {
    if (args.notify.onSuccess !== undefined) next.onSuccess = args.notify.onSuccess;
    if (args.notify.onFailure !== undefined) next.onFailure = args.notify.onFailure;
    if (args.notify.onKilled !== undefined) next.onKilled = args.notify.onKilled;
    if (args.notify.logMatches !== undefined) next.watches = watches(args.notify.logMatches);
  }
  const change = args.watches;
  if (change !== undefined) {
    if (change.mode === "clear") next.watches = [];
    else {
      if (change.items === undefined || change.items.length === 0) throw new ProcessToolInputError("Watch items are required");
      if (change.mode === "remove") {
        for (const item of change.items) if (item.index === undefined && item.pattern === undefined) throw new ProcessToolInputError("Remove requires index or pattern");
        next.watches = next.watches.filter((watch, index) => change.items?.some(item => item.index === undefined ? item.pattern === watch.pattern : item.index === index) !== true);
      } else {
        const added = watches(change.items.map(item => {
          if (item.pattern === undefined) throw new ProcessToolInputError("A watch pattern is required");
          return { ...item, pattern: item.pattern };
        }));
        next.watches = change.mode === "append" ? [...next.watches, ...added] : added;
      }
    }
  }
  return processWatchSchema.parse(next);
}
