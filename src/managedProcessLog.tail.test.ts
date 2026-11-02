import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ManagedProcessLog } from "./managedProcessLog.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(text: string, cap = 64 * 1024 * 1024) {
  const directory = await mkdtemp(join(tmpdir(), "process-tail-"));
  directories.push(directory);
  const file = join(directory, "output.log");
  await writeFile(file, text);
  return { directory, file, log: new ManagedProcessLog(directory, cap) };
}
it.each([
  ["", null],
  ["one\ntwo\n", { text: "two", truncatedStart: false }],
  ["one\nunfinished", { text: "unfinished", truncatedStart: false }],
  ["one\n\n", { text: "", truncatedStart: false }],
  ["\n", { text: "", truncatedStart: false }],
  ["é😀\n尾", { text: "尾", truncatedStart: false }],
])("previews the newest merged line in %j", async (text, expected) => {
  const { log } = await fixture(text);
  expect(await log.tail()).toEqual(expected);
});
it("bounds huge lines and preserves UTF-8 in a truncated suffix", async () => {
  const { log } = await fixture("prefix" + "😀".repeat(2000) + "\n");
  const tail = await log.tail();
  expect(tail?.truncatedStart).toBe(true);
  expect(Buffer.byteLength(tail?.text ?? "")).toBeLessThanOrEqual(4096);
  expect(tail?.text).not.toContain("�");
  expect(tail?.text).toBe("😀".repeat(1024));
});
it("does not mark a complete 4 KiB line as a truncated suffix", async () => {
  const { log } = await fixture("older\n" + "x".repeat(4096) + "\n");
  expect(await log.tail()).toEqual({ text: "x".repeat(4096), truncatedStart: false });
});
it("leaves the durable acknowledgement and retention metadata untouched", async () => {
  const { directory, file, log } = await fixture("one\ntwo\n");
  const batch = await log.read(false, { maxLines: 1 });
  await log.acknowledge(batch.cursor);
  const path = join(directory, "read-position.json");
  const before = await readFile(path, "utf8");
  await writeFile(file, "one\ntwo\nthree\n");
  expect(await log.tail()).toEqual({ text: "three", truncatedStart: false });
  expect(await readFile(path, "utf8")).toBe(before);
  expect((await log.read(false)).lines.map(line => line.text)).toEqual(["two", "three"]);
});
it("honors the retained boundary after sparse-prefix reclamation", async () => {
  const { log } = await fixture("old\nlongtail", 4);
  await log.maintain();
  expect(await log.tail()).toEqual({ text: "tail", truncatedStart: true });
});
it("keeps a complete line complete before and after retention at its boundary", async () => {
  const { log } = await fixture("old\nnew\n", 4);
  expect(await log.tail()).toEqual({ text: "new", truncatedStart: false });
  await log.maintain();
  expect(await log.tail()).toEqual({ text: "new", truncatedStart: false });
});
it("does not return bytes before an unmaintained cap boundary", async () => {
  const { log } = await fixture("old\nlongtail", 4);
  expect(await log.tail()).toEqual({ text: "tail", truncatedStart: true });
});
it("does not claim an incomplete UTF-8 code point is valid output", async () => {
  const { file, log } = await fixture("");
  await writeFile(file, Buffer.from([0x6f, 0x6b, 0xf0, 0x9f]));
  expect(await log.tail()).toEqual({ text: "ok", truncatedStart: false });
});
