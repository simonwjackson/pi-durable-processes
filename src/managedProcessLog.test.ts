import { appendFile, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedProcessLog } from "./managedProcessLog.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function setup(capBytes: number) {
  const directory = await mkdtemp(join(tmpdir(), "managed-log-")); directories.push(directory);
  const file = join(directory, "output.log"); await writeFile(file, "");
  return { directory, file, log: new ManagedProcessLog(directory, capBytes) };
}
describe("managed process log retention", () => {
  it.skipIf(process.platform !== "linux")("drains an 8 MiB log in bounded reads with unchanged offsets and line numbers", async () => {
    const size = 8 * 1024 * 1024;
    const { file, log } = await setup(size);
    await writeFile(file, "x\n".repeat(size / 2));
    const bytesRead = async () => {
      const io = await readFile("/proc/self/io", "utf8");
      const match = /^rchar: (\d+)$/m.exec(io);
      if (match?.[1] === undefined) throw new Error("Missing Linux read-byte counter");
      return Number(match[1]);
    };
    let cursor = { offset: 0, line: 1 };
    while (cursor.offset < size) {
      const maxLines = cursor.offset === 0 ? 1 : 10_000;
      const before = await bytesRead();
      const batch = await log.read(true, { cursor, maxLines });
      const read = await bytesRead() - before;
      // Include the /proc counter and metadata reads, but not the retained tail.
      expect(read).toBeLessThanOrEqual(64 * 1024 + 4096);
      const count = Math.min(maxLines, (size - cursor.offset) / 2);
      expect(batch.lines.length).toBe(count);
      expect(batch.lines.every((line, index) => line.number === cursor.line + index && line.text === "x" && line.terminated && !line.truncatedStart)).toBe(true);
      expect(batch.cursor).toEqual({ offset: cursor.offset + count * 2, line: cursor.line + count });
      expect(batch.droppedLines).toBe(0);
      cursor = batch.cursor;
    }
    expect((await log.read(true, { cursor })).lines).toEqual([]);
  });
  it("discards a truncated log at its end with the highest saved line, and leaves an intact log alone", async () => {
    const { file, directory, log } = await setup(1024);
    await writeFile(file, "one\ntwo\nthree\n");
    await log.acknowledge((await log.read(true)).cursor);
    expect(await log.discardTruncated()).toBe(false);
    expect(JSON.parse(await readFile(join(directory, "read-position.json"), "utf8"))).toMatchObject({ read: { offset: 14, line: 4 } });
    await writeFile(file, "one\n");
    await expect(log.maintain()).rejects.toThrow("externally truncated");
    expect(await log.discardTruncated()).toBe(true);
    expect(JSON.parse(await readFile(join(directory, "read-position.json"), "utf8")))
      .toEqual({ version: 1, base: { offset: 4, line: 4 }, partial: false, read: { offset: 4, line: 4 } });
    expect(await log.read(true, { cursor: { offset: 0, line: 1 } })).toEqual({ lines: [], cursor: { offset: 4, line: 4 }, droppedLines: 3 });
    await appendFile(file, "four\n");
    expect((await log.read(true)).lines).toEqual([{ number: 4, text: "four", terminated: true, truncatedStart: false }]);
  });
  it("joins long lines across chunks without splitting UTF-8 or advancing an unfinished line", async () => {
    const { file, log } = await setup(1024 * 1024);
    const first = "x".repeat(64 * 1024 - 1) + "😀" + "y".repeat(64 * 1024);
    const tail = "é".repeat(64 * 1024);
    await writeFile(file, first + "\n" + tail);
    const running = await log.read(false);
    expect(running.lines).toEqual([{ number: 1, text: first, terminated: true, truncatedStart: false }]);
    expect(running.cursor).toEqual({ offset: Buffer.byteLength(first) + 1, line: 2 });
    await log.acknowledge(running.cursor);
    expect((await log.read(false)).cursor).toEqual(running.cursor);
    const ended = await log.read(true);
    expect(ended.lines).toEqual([{ number: 2, text: tail, terminated: false, truncatedStart: false }]);
    expect(ended.cursor).toEqual({ offset: Buffer.byteLength(first + "\n" + tail), line: 3 });
    await log.acknowledge(ended.cursor);
    expect((await log.read(true)).lines).toEqual([]);
  });
  it("lets a panel browse output without changing the durable event-reader position", async () => {
    const { file, log } = await setup(100);
    await appendFile(file, "one\ntwo\n");
    const delivered = await log.read(false);
    await log.acknowledge(delivered.cursor);
    expect((await log.read(false)).lines).toEqual([]);
    const browsing = await log.read(false, { cursor: { offset: 0, line: 1 }, maxLines: 1 });
    expect(browsing.lines.map((line) => line.text)).toEqual(["one"]);
    expect((await log.read(false, { cursor: browsing.cursor })).lines.map((line) => line.text)).toEqual(["two"]);
    expect((await log.read(false)).lines).toEqual([]);
  });
  it("bounds batches without joining remaining lines into a fake final line", async () => {
    const { file, log } = await setup(100);
    await appendFile(file, "one\ntwo\nthree");
    const first = await log.read(true, { maxLines: 1 });
    expect(first.lines.map((line) => line.text)).toEqual(["one"]);
    await log.acknowledge(first.cursor);
    const second = await log.read(true, { maxLines: 1 });
    expect(second.lines.map((line) => line.text)).toEqual(["two"]);
    await log.acknowledge(second.cursor);
    expect((await log.read(true, { maxLines: 1 })).lines.map((line) => line.text)).toEqual(["three"]);
  });
  it("keeps line identity while a live append descriptor writes during retention", async () => {
    const { file, log } = await setup(1024);
    const writer = await open(file, "a");
    let finished = false;
    const writing = (async () => {
      try {
        for (let number = 1; number <= 3000; number++) await writer.write(`${String(number)}\n`);
      } finally { finished = true; await writer.close(); }
    })();
    let lastLine = 0;
    try {
      do {
        const batch = await log.read(finished);
        for (const line of batch.lines) {
          expect(line.number).toBeGreaterThan(lastLine);
          if (!line.truncatedStart) expect(line.text).toBe(String(line.number));
          else expect(String(line.number).endsWith(line.text)).toBe(true);
          lastLine = line.number;
        }
        await log.acknowledge(batch.cursor);
      } while (lastLine < 3000);
      expect(lastLine).toBe(3000);
    } finally { await writing; }
  });
  it("retries reclamation after metadata was committed but no holes were punched", async () => {
    const { directory, file } = await setup(4);
    await writeFile(file, "a\nb\nc\n");
    await writeFile(join(directory, "read-position.json"), JSON.stringify({ version: 1, base: { offset: 2, line: 2 }, partial: false, read: { offset: 0, line: 1 } }));
    const resumed = new ManagedProcessLog(directory, 4);
    const batch = await resumed.read(true);
    expect(batch.droppedLines).toBe(1);
    expect(batch.lines.map((line) => [line.number, line.text])).toEqual([[2, "b"], [3, "c"]]);
    expect((await readFile(file)).subarray(0, 2)).toEqual(Buffer.alloc(2));
  });
  it("keeps absolute line numbers when the cap cuts a line and a reader resumes", async () => {
    const { directory, file, log } = await setup(10);
    await appendFile(file, "one\ntwo\n0123456789\nlast");
    const first = await log.read(false);
    expect(first.lines).toEqual([{ number: 3, text: "56789", terminated: true, truncatedStart: true }]);
    expect(first.droppedLines).toBe(2);
    await log.acknowledge(first.cursor);
    const resumed = new ManagedProcessLog(directory, 10);
    await appendFile(file, "!\n");
    const next = await resumed.read(false);
    expect(next.lines).toEqual([{ number: 4, text: "last!", terminated: true, truncatedStart: false }]);
    await resumed.acknowledge(next.cursor);
    expect((await resumed.read(true)).lines).toEqual([]);
  });
  it("counts a huge unfinished line once, even across repeated caps and restart", async () => {
    const { directory, file, log } = await setup(8);
    await appendFile(file, "prefixabcdefghijk");
    expect((await log.read(false)).lines).toEqual([]);
    await appendFile(file, "lmnop");
    expect((await log.read(false)).lines).toEqual([]);
    await appendFile(file, "\nend");
    const resumed = new ManagedProcessLog(directory, 8);
    const batch = await resumed.read(true);
    expect(batch.lines).toEqual([
      { number: 1, text: "mnop", terminated: true, truncatedStart: true },
      { number: 2, text: "end", terminated: false, truncatedStart: false },
    ]);
    await resumed.acknowledge(batch.cursor);
    expect((await resumed.read(true)).lines).toEqual([]);
  });
  it("does not mark a line truncated when the cap falls just after a newline", async () => {
    const { file, log } = await setup(4);
    await appendFile(file, "a\nb\nc\n");
    expect((await log.read(true)).lines).toEqual([
      { number: 2, text: "b", terminated: true, truncatedStart: false },
      { number: 3, text: "c", terminated: true, truncatedStart: false },
    ]);
  });
  it("does not split UTF-8 at read boundaries and emits a final line only after exit", async () => {
    const { file, log } = await setup(100_000);
    await appendFile(file, "é😀\n尾");
    const running = await log.read(false);
    expect(running.lines.map((line) => line.text)).toEqual(["é😀"]);
    await log.acknowledge(running.cursor);
    expect((await log.read(false)).lines).toEqual([]);
    const ended = await log.read(true);
    expect(ended.lines.map((line) => line.text)).toEqual(["尾"]);
    await log.acknowledge(ended.cursor);
    expect((await log.read(true)).lines).toEqual([]);
  });
  it("preserves the writer's inode and append offsets while reclaiming old disk blocks", async () => {
    const { directory, file, log } = await setup(8192);
    const writer = await open(file, "a"); const before = await writer.stat();
    try {
      await writer.write("x\n".repeat(32_768));
      const first = await log.read(false, { maxLines: 10_000 }); await log.acknowledge(first.cursor);
      await writer.write("after\n");
      const resumed = new ManagedProcessLog(directory, 8192);
      expect((await resumed.read(true)).lines.map((line) => [line.number, line.text])).toEqual([[32_769, "after"]]);
      const after = await stat(file);
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(65_542);
      expect(after.blocks * 512).toBeLessThanOrEqual(8192 + 8192);
      expect((await readFile(file)).subarray(-6).toString()).toBe("after\n");
    } finally { await writer.close(); }
  });
});
