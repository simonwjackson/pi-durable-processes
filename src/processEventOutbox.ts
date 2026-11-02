import type { ProcessEventSummary, ProcessWatchEvent } from "./processWatchState.js";

const MAX_MATCH_BYTES = 1024 * 1024;
const MAX_MATCH_AGGREGATES = 1000;
const MAX_SAMPLES = 20;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const key = (event: ProcessWatchEvent): string => JSON.stringify([event.processId, event.watchId, event.attention]);

/** Bound lossy match detail, never mandatory exit receipts or the obligation to wake the agent. */
export function compactProcessSummary(summary: ProcessEventSummary): ProcessEventSummary {
  const overflow = { turn: 0, context: 0, ignore: 0, samples: 0, aggregates: 0, ...summary.overflow };
  const matches = new Map<string, ProcessWatchEvent>();
  const exits = new Map<string, ProcessWatchEvent>();
  const turnRequired = summary.turnRequired === true || summary.events.some(event => event.attention === "turn");
  for (const input of summary.events) {
    if (input.kind === "exit") {
      // Exit receipts are exempt: each requires a process start, so the session's starts bound
      // their number. Keep identity/result/attention, not output samples or unbounded names.
      exits.set(key(input), { ...input, name: input.name.slice(0, 120), count: 1, samples: [] });
      continue;
    }
    const previous = matches.get(key(input));
    if (previous !== undefined && input.line <= previous.line) continue;
    const samples = input.attention === "ignore" ? [] : [
      ...previous?.samples ?? [], ...input.samples.filter(sample => sample.number > (previous?.line ?? 0)).map(sample => ({ ...sample, text: sample.text.slice(0, 2000) })),
    ];
    if (samples.length > MAX_SAMPLES) overflow.samples += samples.length - MAX_SAMPLES;
    matches.set(key(input), { ...input, count: (previous?.count ?? 0) + input.count, samples: samples.slice(-MAX_SAMPLES) });
  }
  const events = [...matches.values()];
  const remove = (event: ProcessWatchEvent) => {
    overflow[event.attention] += event.count;
    overflow.aggregates++;
    overflow.samples += event.samples.length;
  };
  while (events.length > MAX_MATCH_AGGREGATES) {
    const oldest = events.shift();
    if (oldest !== undefined) remove(oldest);
  }
  // Exact encoded bytes, including UTF-8, JSON quoting, separators, and overflow metadata.
  // This is a match budget: compact exits are deliberately excluded from both limits.
  let eventBytes = events.reduce((sum, event) => sum + bytes(event), 0);
  const size = () => bytes({ ...summary, events: [], overflow, turnRequired }) + eventBytes + Math.max(0, events.length - 1);
  for (const event of events) {
    while (event.samples.length > 0 && size() > MAX_MATCH_BYTES) {
      const sample = event.samples.shift();
      if (sample !== undefined) eventBytes -= bytes(sample) + (event.samples.length > 0 ? 1 : 0);
      overflow.samples++;
    }
    if (size() <= MAX_MATCH_BYTES) break;
  }
  while (events.length > 0 && size() > MAX_MATCH_BYTES) {
    const oldest = events.shift();
    if (oldest !== undefined) { eventBytes -= bytes(oldest); remove(oldest); }
  }
  return { ...summary, events: [...events, ...exits.values()], overflow: Object.values(overflow).some(value => value > 0) ? overflow : undefined, turnRequired };
}
