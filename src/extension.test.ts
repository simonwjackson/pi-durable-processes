import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { createDurableProcessesExtension } from "./extension.js";
import { AttachedManagedProcessLauncher } from "./managedProcessLauncher.js";

it("loads in raw pi and wakes an idle agent on a log match and exit without polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-extension-"));
  const agentDir = join(root, "agent");
  const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const provider = fauxProvider({ tokensPerSecond: 100000 });
  models.registerNativeProvider(provider.provider); await models.refresh({ allowNetwork: false });
  const model = models.getModel("faux", "faux-1");
  if (model === undefined) throw new Error("Missing test model");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [createDurableProcessesExtension({ stateDirectory: root, prepareLauncher: () => Promise.resolve(new AttachedManagedProcessLauncher()) })] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: models, model, resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(root, join(root, "sessions")) });
  const errors: unknown[] = [];
  session.extensionRunner.onError(error => { errors.push(error); });
  let wakes = 0;
  try {
    await session.bindExtensions({});
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall("process", { action: "start", name: "wake-proof", command: "while [ ! -f match ]; do sleep 0.02; done; printf 'ready\\n'; while [ ! -f finish ]; do sleep 0.02; done; exit 7", notify: { logMatches: [{ pattern: "ready" }] } })], { stopReason: "toolUse" }),
      fauxAssistantMessage("started"),
      () => { wakes++; return fauxAssistantMessage("saw ready"); },
      () => { wakes++; return fauxAssistantMessage("saw exit"); },
    ]);
    await session.prompt("Start a watched command.");
    expect(session.isStreaming).toBe(false);
    expect(wakes).toBe(0);
    expect(session.getActiveToolNames()).toContain("process");
    await writeFile(join(root, "match"), "");
    await vi.waitFor(() => { expect(wakes).toBe(1); expect(session.isStreaming).toBe(false); }, { timeout: 5000 });
    expect(JSON.stringify(session.messages)).toContain("ready");
    await writeFile(join(root, "finish"), "");
    await vi.waitFor(() => { expect(wakes).toBe(2); expect(session.isStreaming).toBe(false); }, { timeout: 5000 });
    const messages = JSON.stringify(session.messages);
    expect(messages).toContain("exit-code");
    expect(messages).not.toContain('"environment"');
    expect(errors).toEqual([]);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 15000);
