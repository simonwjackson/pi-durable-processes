import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ManagedProcessLog, type ManagedProcessLogBatch } from "./managedProcessLog.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture(text: string | Buffer, cap: number) {
  const directory = await mkdtemp(join(tmpdir(), "managed-log-last-")); directories.push(directory);
  await writeFile(join(directory, "output.log"), text);
  return { directory, log: new ManagedProcessLog(directory, cap) };
}

/** What a panel gets today: browse every retained line from the start, then keep the newest. */
async function browseTail(log: ManagedProcessLog, ended: boolean, count: number): Promise<ManagedProcessLogBatch> {
  let cursor = { offset: 0, line: 1 };
  const lines: ManagedProcessLogBatch["lines"] = [];
  let droppedLines: number | undefined;
  // Use read()'s ordinary batch size. The 20k/30k-line cases still cross many
  // pages and byte chunks, without thousands of filesystem opens per oracle.
  const pageSize = 1000;
  for (;;) {
    const batch = await log.read(ended, { cursor, maxLines: pageSize });
    droppedLines ??= batch.droppedLines;
    lines.push(...batch.lines);
    cursor = batch.cursor;
    if (batch.lines.length < pageSize) {
      const newest = lines.slice(-count);
      // Every earlier line is dropped from the panel's view: retained lines it omits and retention's.
      return { lines: newest, cursor, droppedLines: droppedLines + lines.length - newest.length };
    }
  }
}

const long = "x".repeat(70 * 1024);
const cases: [string, string | Buffer, number][] = [
  ["empty", "", 1024],
  ["one terminated line", "one\n", 1024],
  ["only an unterminated line", "unfinished", 1024],
  ["terminated and unterminated lines", "one\ntwo\nthree", 1024],
  ["blank lines", "\n\n\nlast\n", 1024],
  ["UTF-8 across chunk boundaries", `${"é".repeat(40_000)}\n😀\n${"尾".repeat(30_000)}\n尾`, 1024 * 1024],
  ["lines longer than a read chunk", `${long}\n${long}y\nz\n${long}`, 1024 * 1024],
  ["many short lines over several chunks", Array.from({ length: 30_000 }, (_, index) => `line ${String(index)}`).join("\n") + "\n", 1024 * 1024],
  ["retention cut mid-line", "one\ntwo\n0123456789\nlast", 10],
  ["retention cut just after a newline", "a\nb\nc\n", 4],
  ["retention inside an unterminated line", "prefixabcdefghijk", 8],
  ["retention across many lines", Array.from({ length: 20_000 }, (_, index) => `retained ${String(index)}`).join("\n") + "\npartial", 64 * 1024],
];

it.each(cases.flatMap(([name, text, cap]) => [true, false].flatMap(ended => [1, 3, 50, 10_000].map(count => [name, cap, ended, count, text] as const))))(
  "matches browse for %s (cap %i, ended %s, last %i)", async (_name, cap, ended, count, text) => {
    const browsed = await fixture(text, cap);
    const expected = await browseTail(browsed.log, ended, count);
    const tailed = await fixture(text, cap);
    expect(await tailed.log.readTail(ended, count)).toEqual(expected);
  });

it("counts from an acknowledged line start and from the base after an acknowledged final fragment", async () => {
  const text = Array.from({ length: 5000 }, (_, index) => `n${String(index)}`).join("\n") + "\nend";
  const { log } = await fixture(text, 1024 * 1024);
  const running = await log.read(false, { maxLines: 3000 });
  await log.acknowledge(running.cursor);
  expect(await log.readTail(false, 3)).toEqual(await browseTail(log, false, 3));
  expect(await log.readTail(true, 2500)).toEqual(await browseTail(log, true, 2500));
  let drained = await log.read(true, { maxLines: 10_000 });
  await log.acknowledge(drained.cursor);
  drained = await log.read(true);
  expect(drained.lines).toEqual([]);
  // The reader now sits after the unterminated "end"; that cursor is not a line start.
  expect(await log.readTail(true, 2)).toEqual(await browseTail(log, true, 2));
  expect((await log.readTail(true, 1)).lines).toEqual([{ number: 5001, text: "end", terminated: false, truncatedStart: false }]);
});

it("never acknowledges or moves the durable watch reader", async () => {
  const { directory, log } = await fixture("one\ntwo\nthree\n", 1024);
  const first = await log.read(false, { maxLines: 1 });
  await log.acknowledge(first.cursor);
  const position = await readFile(join(directory, "read-position.json"), "utf8");
  expect((await log.readTail(true, 2)).lines.map(line => line.text)).toEqual(["two", "three"]);
  expect(await readFile(join(directory, "read-position.json"), "utf8")).toBe(position);
  expect((await log.read(false)).lines.map(line => line.text)).toEqual(["two", "three"]);
});

it("rejects invalid counts and an externally truncated log", async () => {
  const { directory, log } = await fixture("one\ntwo\n", 1024);
  await expect(log.readTail(true, 0)).rejects.toThrow("batch size");
  await expect(log.readTail(true, 10_001)).rejects.toThrow("batch size");
  await log.acknowledge((await log.read(false)).cursor);
  await writeFile(join(directory, "output.log"), "o");
  await expect(log.readTail(true, 1)).rejects.toThrow("externally truncated");
});
