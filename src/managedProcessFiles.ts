import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ManagedProcessResult } from "./managedProcessTypes.js";

export function hasCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }

/** Publish metadata before reclaiming bytes. fsync also makes rename survive a host crash. */
export async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
export async function readResult(directory: string): Promise<ManagedProcessResult | undefined> {
  let content: string;
  try { content = await readFile(join(directory, "result"), "utf8"); }
  catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  const [result, code, status, end, ...extra] = content.split("\n");
  if (result === undefined || result === "" || code === undefined || status === undefined || end !== "" || extra.length !== 0) throw new Error(`Invalid managed process result: ${directory}`);
  return { result, code, status };
}
