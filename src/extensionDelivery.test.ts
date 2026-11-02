import { expect, it } from "vitest";
import { deliverProcessEvents } from "./extension.js";
import { type ProcessEventSummary } from "./processWatchState.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

it.each(["turn", "context", "ignore"] as const)("delivers %s with the requested raw-pi attention", async attention => {
  const messages: { content: unknown; triggerTurn: boolean | undefined; deliverAs: string | undefined }[] = [];
  const entries: unknown[] = [];
  const delivery: Pick<ExtensionAPI, "sendMessage" | "appendEntry"> = {
    sendMessage: (message, options) => { messages.push({ content: message.content, triggerTurn: options?.triggerTurn, deliverAs: options?.deliverAs }); },
    appendEntry: (_kind, entry) => { entries.push(entry); },
  };
  const summary: ProcessEventSummary = { id: "receipt", missed: false, events: [{ processId: "one", name: "build", watchId: "exit", attention, kind: "exit", line: 1, count: 1, samples: [], result: "success", code: "exited", status: "0" }] };
  await deliverProcessEvents(delivery, summary);
  if (attention === "ignore") { expect(messages).toEqual([]); expect(entries).toEqual([summary]); }
  else { expect(messages).toHaveLength(1); expect(messages[0]?.content).toContain("build (one)"); expect(messages[0]?.triggerTurn).toBe(attention === "turn"); expect(messages[0]?.deliverAs).toBe("followUp"); expect(entries).toEqual([]); }
});

it("preserves a required wake after match details have been compacted away", async () => {
  let triggerTurn: boolean | undefined;
  await deliverProcessEvents({ sendMessage: (_message, options) => { triggerTurn = options?.triggerTurn; }, appendEntry: () => { throw new Error("Must wake"); } }, { id: "compacted", missed: true, events: [], turnRequired: true });
  expect(triggerTurn).toBe(true);
});
