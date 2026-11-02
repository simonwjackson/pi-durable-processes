import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { hasCode } from "./managedProcessFiles.js";
import type { ManagedProcessInputResult, ManagedProcessRecord } from "./managedProcessTypes.js";

const execute = promisify(execFile);
// The helper, not the command, owns the write end. The command stays MainPID.
const keeper = `f=$1; shift
exec 3<>"$f"
{ read -r _ < "$f.eof"; } 4<&- &
exec "$@" < "$f" 3>&- 4<&-
`;
// fd 4 is a lifeline to Forgerie, not the managed process's stdin. This helper
// also handles SIGKILL of Forgerie. The attached command is still its child;
// a separate process group makes ordinary descendant cleanup possible.
const attachedKeeper = `f=$1; timeout=$2; shift 2
main=$$
{
  trap '' TERM
  read -r _ <&4
  kill -TERM -"$main" 2>/dev/null
  sleep "$timeout"
  kill -KILL -"$main" 2>/dev/null
} 3<&- &
${keeper.replace("f=$1; shift\n", "")}`;
// Resolve only stable system paths, never PATH or a Nix store path captured at
// launch. GNU sync with file operands calls fsync (including for directories).
const resultWriter = `set -eu
umask 077
for tools in /run/current-system/sw/bin /usr/bin /bin; do
  if [ -x "$tools/sync" ] && [ -x "$tools/mv" ]; then
    case "$("$tools/sync" --version)" in
      *"GNU coreutils"*) break ;;
    esac
  fi
  tools=
done
if [ -z "$tools" ]; then
  printf '%s\\n' 'Managed process result requires GNU sync and mv at stable system paths' >&2
  exit 1
fi
cd "$1"
printf '%s\\n' "\${SERVICE_RESULT:-unknown}" "\${EXIT_CODE:-}" "\${EXIT_STATUS:-}" > result.tmp
"$tools/sync" -- result.tmp
"$tools/mv" -f -- result.tmp result
"$tools/sync" -- .
`;
export async function prepareProcessFiles(record: ManagedProcessRecord): Promise<void> {
  await writeFile(join(record.directory, "output.log"), "", { flag: "wx", mode: 0o600 });
  await execute("mkfifo", ["-m", "600", join(record.directory, "stdin"), join(record.directory, "stdin.eof")]);
  await writeFile(join(record.directory, "keeper.sh"), record.supervision.kind === "attached" ? attachedKeeper : keeper, { mode: 0o600 });
  await writeFile(join(record.directory, "result.sh"), resultWriter, { mode: 0o600 });
}

/** Never waits for a reader or free pipe capacity. Retry only the unwritten suffix. */
export async function writeProcessInput(directory: string, input: Buffer | "eof"): Promise<ManagedProcessInputResult> {
  let bytesWritten = 0;
  try {
    const file = await open(join(directory, input === "eof" ? "stdin.eof" : "stdin"), constants.O_WRONLY | constants.O_NONBLOCK);
    try {
      if (input !== "eof") {
        while (bytesWritten < input.length) {
          // PIPE_BUF-sized writes are atomic, including on a nonblocking FIFO.
          const length = Math.min(4096, input.length - bytesWritten);
          const written = await file.write(input, bytesWritten, length);
          bytesWritten += written.bytesWritten;
          if (written.bytesWritten === 0) return { kind: "stdin-full", bytesWritten };
        }
      }
      // Opening and closing the EOF FIFO releases the keeper, even with no data.
      return { kind: "written", bytesWritten };
    } finally { await file.close(); }
  } catch (error) {
    if (hasCode(error, "EAGAIN") || hasCode(error, "EWOULDBLOCK")) return { kind: "stdin-full", bytesWritten };
    if (hasCode(error, "ENXIO") || hasCode(error, "EPIPE") || hasCode(error, "ENOENT")) return { kind: "stdin-closed", bytesWritten };
    throw error;
  }
}
