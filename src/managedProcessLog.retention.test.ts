import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ManagedProcessLog } from "./managedProcessLog.js";

const directories: string[] = [];
let originalPath: string | undefined;
let tools: string;
beforeEach(async () => {
  originalPath = process.env["PATH"];
  tools = await mkdtemp(join(tmpdir(), "managed-log-tools-")); directories.push(tools);
  // A real fallocate wrapper that records each punch, then runs the system tool or fails on request.
  await writeFile(join(tools, "fallocate"), `#!/bin/sh
echo "$*" >> "${tools}/punches"
if [ -e "${tools}/fail" ]; then exit 1; fi
PATH="${originalPath ?? ""}" exec fallocate "$@"
`);
  await chmod(join(tools, "fallocate"), 0o700);
  process.env["PATH"] = `${tools}${delimiter}${originalPath ?? ""}`;
});
afterEach(async () => {
  process.env["PATH"] = originalPath;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "managed-log-retention-")); directories.push(directory);
  const file = join(directory, "output.log");
  await writeFile(file, "");
  const position = join(directory, "read-position.json");
  let lastIno: number | undefined;
  let saves = 0;
  /** atomicWrite renames a new file into place, so each save changes the inode. */
  const observeSaves = async () => {
    const ino = await stat(position).then(value => value.ino, () => undefined);
    if (ino !== undefined && ino !== lastIno) saves++;
    lastIno = ino;
    return saves;
  };
  const punches = async () => (await readFile(join(tools, "punches"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { directory, file, observeSaves, punches };
}

it.skipIf(process.platform !== "linux")("punches and saves once per retention advance, not on every unchanged read", async () => {
  const { directory, file, observeSaves, punches } = await fixture();
  await appendFile(file, "aaaa\nbbbb\ncccc\n");
  // Each panel tick constructs a new log, as the session owner does.
  const read = () => new ManagedProcessLog(directory, 8).read(false, { cursor: { offset: 0, line: 1 } });
  const first = await read();
  expect(first.lines.map(line => [line.number, line.text, line.truncatedStart])).toEqual([[2, "bb", true], [3, "cccc", false]]);
  expect([await punches(), await observeSaves()]).toEqual([1, 1]);
  // The first unchanged pass records the punch receipt; later unchanged passes do nothing.
  expect(await read()).toEqual(first);
  expect([await punches(), await observeSaves()]).toEqual([2, 2]);
  for (let tick = 0; tick < 5; tick++) expect(await read()).toEqual(first);
  expect([await punches(), await observeSaves()]).toEqual([2, 2]);
  expect((await readFile(file)).subarray(0, 7)).toEqual(Buffer.alloc(7));
  await appendFile(file, "dddd\n");
  const advanced = await read();
  expect(advanced.lines.map(line => line.number)).toEqual([3, 4]);
  expect(advanced.droppedLines).toBe(2);
  expect([await punches(), await observeSaves()]).toEqual([3, 3]);
  expect(JSON.parse(await readFile(join(directory, "read-position.json"), "utf8"))).toMatchObject({ base: { offset: 12, line: 3 }, reclaimed: 7 });
});

it.skipIf(process.platform !== "linux")("never records a receipt for a failed punch and retries it on the next read", async () => {
  const { directory, file, observeSaves, punches } = await fixture();
  await appendFile(file, "a\nb\nc\n");
  await writeFile(join(tools, "fail"), "");
  const read = () => new ManagedProcessLog(directory, 4).read(true);
  await expect(read()).rejects.toThrow();
  // The base was saved before the punch, as before; the receipt was not.
  expect(JSON.parse(await readFile(join(directory, "read-position.json"), "utf8"))).toEqual({ version: 1, base: { offset: 2, line: 2 }, partial: false, read: { offset: 0, line: 1 } });
  await expect(read()).rejects.toThrow();
  expect(await punches()).toBe(2);
  await rm(join(tools, "fail"));
  const batch = await read();
  expect(batch.lines.map(line => [line.number, line.text])).toEqual([[2, "b"], [3, "c"]]);
  expect(await punches()).toBe(3);
  await observeSaves();
  expect(JSON.parse(await readFile(join(directory, "read-position.json"), "utf8"))).toMatchObject({ base: { offset: 2, line: 2 }, reclaimed: 2 });
  await read();
  expect(await punches()).toBe(3);
});

it("keeps the receipt through acknowledgement and accepts a position file without one", async () => {
  const { directory, file } = await fixture();
  await appendFile(file, "one\n");
  await writeFile(join(directory, "read-position.json"), JSON.stringify({ version: 1, base: { offset: 0, line: 1 }, partial: false, read: { offset: 0, line: 1 } }));
  const log = new ManagedProcessLog(directory, 1024);
  const batch = await log.read(false);
  await log.acknowledge(batch.cursor);
  expect(JSON.parse(await readFile(join(directory, "read-position.json"), "utf8"))).toEqual({ version: 1, base: { offset: 0, line: 1 }, partial: false, read: { offset: 4, line: 2 } });
});
