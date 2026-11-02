# pi-durable-processes

A `process` tool for long-running commands in [pi](https://pi.dev), and a library for embedded agent hosts. Extracted from [Forgerie](https://github.com/simonwjackson/forgerie).

```sh
pi install git:github.com/simonwjackson/pi-durable-processes@v0.1.0
```

The pi manifest loads the default extension and the `processes` skill. It does not replace the built-in `bash` tool. Do not load another extension that registers `process`.

```json
{"action":"start","name":"build","command":"npm run build","notify":{"logMatches":[{"pattern":"ready"}]}}
```

Use `list`, `output`, `write`, `update`, `stop`, and `clear` to control a process. Read [the skill](skills/processes/SKILL.md) for arguments, watches, stdin, retention, and child handoff.

## Supervision and ownership

- On Linux with an available systemd user manager, processes survive pi/host application restarts. Commands run in separate transient user units. Enable user linger if they must survive logout.
- Without a user manager, Unix attached supervision is used. Those processes end when the host application exits. Every public result labels the supervision mode. Windows is unsupported.
- Processes belong to the originating session. Quit, reload, fork, and session switching release the raw-pi lease but do not stop systemd processes. Resume that same session to reconnect. Explicitly `stop` obsolete work. A lost process is never relaunched automatically.
- Raw pi watches only the active session. Inactive or closed sessions do not wake; missed events are summarized on resume. Forgerie's registry can watch and wake inactive sessions independently.
- State defaults to `$XDG_STATE_HOME/pi-durable-processes` or `~/.local/state/pi-durable-processes`. Set the absolute `PI_DURABLE_PROCESSES_STATE_DIR` to override it. State is host-local; do not synchronize it across machines.
- The existing `forgerie-proc-<session hash>` systemd unit namespace and record format are retained so extraction does not orphan existing processes.

## Raw-pi wake-up

The extension uses pi's `sendMessage` with `triggerTurn: true` and `deliverAs: "followUp"`. Exit and log-match `turn` events wake an idle agent; while the agent runs, they queue a follow-up. `context` adds context without waking. `ignore` appends a non-context session entry. No agent polling is required.

The core fsyncs its watch outbox before acknowledging log output. Pi's extension `sendMessage` API returns no durable acceptance receipt. A crash between pi queueing/persisting a message and the outbox acknowledgement can lose or duplicate that notification. Forgerie retains its own transactional, deduplicating event sink; this raw-pi limitation does not weaken it. The command record and retained output remain inspectable. These contracts are tested against pi 1.1.0; newer host APIs must remain compatible.

## Library API

Forgerie and other hosts import the built ESM library, not the default extension:

```ts
import {
  ManagedProcesses, ManagedProcessRegistry, ManagedProcessTools,
  prepareManagedProcessLauncher, createProcessTool,
} from "@simonwjackson/pi-durable-processes";

const launcher = await prepareManagedProcessLauncher();
const core = new ManagedProcesses({
  stateDirectory: "/absolute/private/state",
  sessionId: "session-id",
  launcher,
  // Optional host policy. Portable hygiene is applied after this builder.
  buildEnvironment: env => Object.fromEntries(
    Object.entries(env).filter(([key]) => key !== "HOST_PRIVATE_KEY")),
});
await core.initialize();
const tools = new ManagedProcessTools({
  sessionId: "session-id", cwd: "/absolute/workspace",
  stateFile: "/absolute/private/state/watches.json",
  getManagedProcesses: async () => core,
});
await tools.initialize(async summary => { /* durably accept/deduplicate events */ });
tools.watch(error => { /* report an operational error */ });
const definition = tools.definition(); // or createProcessTool(execute)
// Register definition in the host. Dispose tools before core on shutdown.
```

`ManagedProcessRegistry` owns multiple session cores and dispatchers. It accepts the same environment builder, a launcher factory, session resolution, error reporting, and wake callbacks. `initialize`/`attach` on `ManagedProcessTools` inject the event sink. The sink must resolve only after durable acceptance and must deduplicate retries. Runtime shutdown releases durable ownership; `closeSession` stops the session before deleting records. Child-run ownership and `keepAfterChild` are available to embedded hosts.

Records include private environment values. Never serialize a record or snapshot into tool/browser output. Use `publicProcess` or the tool factory's public projection. Portable filtering removes supervisor controls and `PC_*` keys; the embedding host must inject any additional secret/configuration policy. Raw pi intentionally retains ordinary variables such as `NODE_ENV` and `PORT`.

The public entry point also exports schemas, launchers, watch state, log types, and public projections. `@simonwjackson/pi-durable-processes/testing` exposes the configurable test launcher. `@simonwjackson/pi-durable-processes/extension` exposes the default extension and configurable extension factory.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
```

Node 22.19+ and a Unix-like host are required. Git installs run `prepare` to build the library. Pi supplies `@earendil-works/pi-coding-agent` and `typebox` as peers; runtime dependencies are `proper-lockfile` and `zod`. Development pins pi's companion packages to 1.1.0 because mixed 1.1/1.5 package graphs are not API-compatible. No host packages are bundled.
