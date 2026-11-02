import { expect, it } from "vitest";
import { compactProcessSummary } from "./processEventOutbox.js";
import type { ProcessEventSummary, ProcessWatchEvent } from "./processWatchState.js";

function match(index: number, attention: ProcessWatchEvent["attention"] = "context"): ProcessWatchEvent {
  return { processId: `p-${String(index)}`, watchId: "watch", name: "worker", kind: "match", attention,
    count: 1, line: 1, samples: [{ number: 1, text: "界".repeat(2000) }] };
}
const summary = (events: ProcessWatchEvent[]): ProcessEventSummary => ({ id: "batch", seriesId: "series", missed: true, events });

it("caps match aggregates and UTF-8 bytes, records losses, and preserves an evicted turn's wake obligation", () => {
  const result = compactProcessSummary(summary(Array.from({ length: 1200 }, (_, index) => match(index, index === 0 ? "turn" : "context"))));
  expect(result.events).toHaveLength(1000);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024);
  expect(result.turnRequired).toBe(true);
  expect(result.events.some(event => event.attention === "turn")).toBe(false);
  expect(result.overflow?.turn).toBe(1);
  expect(result.overflow?.context).toBe(199);
  expect(result.overflow?.samples).toBeGreaterThan(200);
  expect(result.events.reduce((sum, event) => sum + event.count, 0) + (result.overflow?.turn ?? 0) + (result.overflow?.context ?? 0)).toBe(1200);
  expect(compactProcessSummary(result)).toEqual(result);
});

it("keeps more than 1000 compact exit receipts while still capping match detail", () => {
  const exits: ProcessWatchEvent[] = Array.from({ length: 1005 }, (_, index) => ({ processId: `exit-${String(index)}`, watchId: "exit", name: "long name".repeat(1000),
    kind: "exit", attention: "context", count: 1, line: 1, samples: [{ number: 1, text: "must not persist" }], result: "exit-code", code: "exited", status: "7" }));
  const result = compactProcessSummary(summary([...exits, ...Array.from({ length: 1100 }, (_, index) => match(index))]));
  const kept = result.events.filter(event => event.kind === "exit");
  expect(kept).toHaveLength(1005);
  expect(new Set(kept.map(event => event.processId)).size).toBe(1005);
  expect(kept.every(event => event.samples.length === 0 && event.name.length <= 120 && event.result === "exit-code" && event.code === "exited" && event.status === "7")).toBe(true);
  const matches = result.events.filter(event => event.kind === "match");
  expect(matches).toHaveLength(1000);
  expect(Buffer.byteLength(JSON.stringify({ ...result, events: matches }))).toBeLessThanOrEqual(1024 * 1024);
});

it("coalesces by process, watch and attention, and ignores output samples for ignore watches", () => {
  const result = compactProcessSummary(summary([
    match(1, "ignore"), { ...match(1, "ignore"), line: 2, count: 2, totalCount: 3 },
    match(1, "context"), { ...match(1, "context"), line: 3, count: 3, totalCount: 4 },
  ]));
  expect(result.events).toHaveLength(2);
  expect(result.events[0]).toMatchObject({ count: 3, line: 2, totalCount: 3, samples: [] });
  expect(result.events[1]).toMatchObject({ count: 4, line: 3, totalCount: 4 });
});
