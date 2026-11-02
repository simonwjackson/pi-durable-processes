import { execFile } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { atomicWrite, hasCode } from "./managedProcessFiles.js";

const execute = promisify(execFile);
const positionSchema = z.object({ offset: z.number().int().nonnegative(), line: z.number().int().positive() });
export type ManagedProcessLogCursor = z.infer<typeof positionSchema>;
const stateSchema = z.object({
  version: z.literal(1), base: positionSchema, partial: z.boolean(), read: positionSchema,
  /** Prefix already punched. Written only after a successful punch; absent means unknown. */
  reclaimed: z.number().int().nonnegative().optional(),
});
type LogState = z.infer<typeof stateSchema>;
/** The log is shorter than its saved positions. Only outside damage does this, such as writes lost in a power cut. */
export class ManagedProcessLogTruncatedError extends Error {
  constructor() { super("Managed process log was externally truncated"); this.name = "ManagedProcessLogTruncatedError"; }
}
export interface ManagedProcessLogReadOptions {
  maxLines?: number;
  /** Omit for the durable read position; use {offset: 0, line: 1} to browse retained output. */
  cursor?: ManagedProcessLogCursor;
}
export interface ManagedProcessLogTail {
  text: string;
  truncatedStart: boolean;
}
export interface ManagedProcessLogBatch {
  lines: { number: number; text: string; terminated: boolean; truncatedStart: boolean }[];
  cursor: ManagedProcessLogCursor;
  droppedLines: number;
}

/** The session owner serializes read, maintenance and acknowledgement calls. */
export class ManagedProcessLog {
  constructor(private readonly directory: string, private readonly capBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(capBytes) || capBytes < 1) throw new Error("Invalid managed process log cap");
  }
  async read(ended: boolean, options: ManagedProcessLogReadOptions = {}): Promise<ManagedProcessLogBatch> {
    const maxLines = options.maxLines ?? 1000;
    if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 10_000) throw new Error("Invalid managed process log batch size");
    const state = await this.maintain();
    const position = options.cursor === undefined ? state.read : positionSchema.parse(options.cursor);
    const file = await open(join(this.directory, "output.log"), "r");
    try {
      const size = Math.min((await file.stat()).size, state.base.offset + this.capBytes);
      if (position.offset > size) throw new Error("Managed process log cursor is beyond output");
      let offset = Math.max(position.offset, state.base.offset);
      // At the base offset the base line wins. They differ only after discardTruncated() moved the base.
      let line = position.offset <= state.base.offset ? state.base.line : position.line;
      let truncatedStart = offset === state.base.offset && state.partial;
      // One snapshot per call. Appends after this size belong to the next call.
      const buffer = Buffer.alloc(Math.min(64 * 1024, size - offset));
      const lines: ManagedProcessLogBatch["lines"] = [];
      let readOffset = offset;
      let fragments: Buffer[] = [];
      let fragmentBytes = 0;
      while (readOffset < size && lines.length < maxLines) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - readOffset), readOffset);
        if (bytesRead === 0) throw new Error("Managed process log shrank while reading");
        let start = 0;
        for (let index = 0; index < bytesRead; index++) {
          if (buffer[index] !== 10) continue;
          const tail = buffer.subarray(start, index);
          // Decode only complete lines: a chunk can split a UTF-8 code point.
          const text = fragments.length === 0 ? tail.toString("utf8") : Buffer.concat([...fragments, tail], fragmentBytes + tail.length).toString("utf8");
          lines.push({ number: line++, text, terminated: true, truncatedStart });
          fragments = []; fragmentBytes = 0;
          truncatedStart = false; start = index + 1;
          offset = readOffset + start;
          if (lines.length === maxLines) break;
        }
        if (lines.length < maxLines && start < bytesRead) {
          // The read buffer is reused. Retain only the unfinished line, not
          // the rest of the log; concatenate once, rather than on each chunk.
          const fragment = Buffer.from(buffer.subarray(start, bytesRead));
          fragments.push(fragment); fragmentBytes += fragment.length;
        }
        readOffset += bytesRead;
      }
      if (ended && lines.length < maxLines && fragmentBytes > 0) {
        lines.push({ number: line++, text: Buffer.concat(fragments, fragmentBytes).toString("utf8"), terminated: false, truncatedStart });
        offset = readOffset;
      }
      return { lines, cursor: { offset, line }, droppedLines: Math.max(0, state.base.line - position.line) };
    } finally { await file.close(); }
  }
  /**
   * The newest `maxLines` lines exactly as read(ended, {cursor: {offset: 0, line: 1}}) would number
   * and mark them, with the cursor that browse reaches at the end. droppedLines counts every earlier
   * line, including those before the retention base. Retention runs as it does for read(); the
   * durable watch reader is never acknowledged or moved. Only bytes after the newest known line
   * start are counted, and only the returned lines are decoded.
   */
  async readTail(ended: boolean, maxLines: number): Promise<ManagedProcessLogBatch> {
    if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 10_000) throw new Error("Invalid managed process log batch size");
    const state = await this.maintain();
    const file = await open(join(this.directory, "output.log"), "r");
    try {
      const size = Math.min((await file.stat()).size, state.base.offset + this.capBytes);
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size - state.base.offset)));
      const readAt = async (offset: number, length: number) => {
        const { bytesRead } = await file.read(chunk, 0, length, offset);
        if (bytesRead !== length) throw new Error("Managed process log shrank while reading");
        return chunk.subarray(0, length);
      };
      // An acknowledged cursor after a newline is an absolute line start from read(). A cursor after a
      // final unterminated line is not, so counting then starts at the base, which always is.
      const anchor = state.read.offset > state.base.offset && state.read.offset <= size
        && (await readAt(state.read.offset - 1, 1))[0] === 10 ? state.read : state.base;
      // Next line number and offset after the last newline, counted forward from the anchor.
      let line = anchor.line, lineEnd = anchor.offset;
      for (let offset = anchor.offset; offset < size;) {
        const bytes = await readAt(offset, Math.min(chunk.length, size - offset));
        for (let index = bytes.indexOf(10); index >= 0; index = bytes.indexOf(10, index + 1)) { line++; lineEnd = offset + index + 1; }
        offset += bytes.length;
      }
      const fragment = ended && size > lineEnd;
      const cursor = fragment ? { offset: size, line: line + 1 } : { offset: lineEnd, line };
      // Find the start of the newest terminated lines by searching backwards from the final newline.
      let wanted = maxLines - (fragment ? 1 : 0), start = lineEnd;
      if (wanted > 0 && lineEnd > state.base.offset) {
        start = state.base.offset;
        let searchEnd = lineEnd - 1; // Exclude the newline that terminates the newest line.
        while (searchEnd > state.base.offset && wanted > 0) {
          const from = Math.max(state.base.offset, searchEnd - chunk.length);
          const bytes = await readAt(from, searchEnd - from);
          let index = bytes.length;
          while (wanted > 0 && (index = index === 0 ? -1 : bytes.lastIndexOf(10, index - 1)) >= 0) {
            if (--wanted === 0) start = from + index + 1;
          }
          searchEnd = from;
        }
      }
      const content = Buffer.alloc(cursor.offset - start);
      if (content.length > 0) {
        const { bytesRead } = await file.read(content, 0, content.length, start);
        if (bytesRead !== content.length) throw new Error("Managed process log shrank while reading");
      }
      const texts = content.subarray(0, lineEnd - start).toString("utf8").split("\n").slice(0, -1);
      let number = line - texts.length;
      const lines: ManagedProcessLogBatch["lines"] = texts.map((text, index) => ({ number: number++, text, terminated: true,
        truncatedStart: index === 0 && start === state.base.offset && state.partial }));
      if (fragment) lines.push({ number, text: content.subarray(lineEnd - start).toString("utf8"), terminated: false,
        truncatedStart: lineEnd === state.base.offset && state.partial });
      return { lines, cursor, droppedLines: (lines[0]?.number ?? cursor.line) - 1 };
    } finally { await file.close(); }
  }
  /** A bounded live preview, including unfinished output. Never retains or acknowledges logs. */
  async tail(): Promise<ManagedProcessLogTail | null> {
    const state = await this.load();
    const file = await open(join(this.directory, "output.log"), "r");
    try {
      const size = (await file.stat()).size;
      if (size < state.base.offset || size < state.read.offset) throw new ManagedProcessLogTruncatedError();
      const base = Math.max(state.base.offset, size - this.capBytes);
      if (size === base) return null;
      // Allow a trailing newline and the preceding byte to identify a complete 4 KiB line.
      const start = Math.max(state.base.offset, base - 1, size - 4098);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      if (bytesRead !== buffer.length) throw new Error("Managed process log shrank while reading");
      const end = buffer[buffer.length - 1] === 10 ? buffer.length - 1 : buffer.length;
      const newline = end === 0 ? -1 : buffer.lastIndexOf(10, end - 1);
      let from = Math.max(newline + 1, end - 4096, base - start);
      const truncatedStart = from > 0 ? buffer[from - 1] !== 10 : start > state.base.offset || state.partial;
      // A suffix can start inside a code point. Skip its continuation bytes.
      if (truncatedStart) {
        while (from < end) {
          const byte = buffer[from];
          if (byte === undefined || (byte & 0xc0) !== 0x80) break;
          from++;
        }
      }
      return { text: new TextDecoder().decode(buffer.subarray(from, end), { stream: true }), truncatedStart };
    } finally { await file.close(); }
  }
  async acknowledge(cursor: ManagedProcessLogCursor): Promise<void> {
    positionSchema.parse(cursor);
    const state = await this.load();
    const file = await open(join(this.directory, "output.log"), "r");
    try {
      const size = (await file.stat()).size;
      // A cursor beyond the output was read from bytes that are gone: the log shrank, like a saved position would.
      if (size < state.base.offset || size < state.read.offset || cursor.offset > size) throw new ManagedProcessLogTruncatedError();
      if (cursor.offset < state.read.offset || cursor.line < state.read.line) throw new Error("Invalid managed process log acknowledgement");
    } finally { await file.close(); }
    state.read = cursor;
    await this.save(state);
  }
  async maintain(): Promise<LogState> {
    const state = await this.load();
    const path = join(this.directory, "output.log");
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size;
      if (size < state.base.offset || size < state.read.offset) throw new ManagedProcessLogTruncatedError();
      const cutoff = Math.max(state.base.offset, size - this.capBytes);
      const loadedBase = state.base.offset;
      const buffer = Buffer.alloc(64 * 1024);
      while (state.base.offset < cutoff) {
        const length = Math.min(buffer.length, cutoff - state.base.offset);
        const { bytesRead } = await file.read(buffer, 0, length, state.base.offset);
        if (bytesRead === 0) throw new Error("Managed process log shrank during retention");
        for (let index = 0; index < bytesRead; index++) {
          if (buffer[index] === 10) state.base.line++;
        }
        state.partial = buffer[bytesRead - 1] !== 10;
        state.base.offset += bytesRead;
      }
      if (state.base.offset > loadedBase) {
        // NEVER rename, copy-truncate or shift this file: systemd holds O_APPEND
        // descriptors on its inode and can write while retention runs. Instead
        // keep absolute byte offsets and punch a sparse prefix with KEEP_SIZE.
        // Count its newlines BEFORE punching; persist the new base first. A crash
        // between publish and punch only leaves extra disk blocks, and the next
        // pass retries the punch. Writers append beyond the sampled EOF, so no
        // byte they append can move, be overwritten, or disappear in this step.
        // A cut mid-line retains that line's number and marks its surviving tail
        // truncated. Unterminated lines are emitted only after the process ends.
        // Logical size grows; allocated storage is cap + up to two FS blocks.
        await this.save(state);
        await this.punch(path, state.base.offset);
      } else if (state.base.offset > (state.reclaimed ?? 0)) {
        // The base is already durable; a crash may have skipped its punch. Retry it,
        // then record the receipt so later unchanged passes neither save nor punch.
        await this.punch(path, state.base.offset);
        state.reclaimed = state.base.offset;
        await this.save(state);
      }
      return state;
    } finally { await file.close(); }
  }
  /**
   * Only for a process that can no longer write. If the log is shorter than its saved positions,
   * drop what is left: those bytes no longer match the saved line numbers. Base and reader move
   * to the end of the file with the highest saved line number, so line numbers never go back and
   * every earlier line reads as dropped. Returns false and changes nothing when the log is intact.
   */
  async discardTruncated(): Promise<boolean> {
    const state = await this.load();
    const size = (await stat(join(this.directory, "output.log"))).size;
    if (size >= state.base.offset && size >= state.read.offset) return false;
    const end = { offset: size, line: Math.max(state.base.line, state.read.line) };
    // Omit reclaimed: the next maintenance pass punches the dropped prefix again, which is harmless.
    await this.save({ version: 1, base: end, partial: false, read: { ...end } });
    return true;
  }
  private async punch(path: string, length: number): Promise<void> {
    await execute("fallocate", ["--punch-hole", "--keep-size", "--offset", "0", "--length", String(length), path], { timeout: 30_000 });
  }
  private async load(): Promise<LogState> {
    try { return stateSchema.parse(JSON.parse(await readFile(join(this.directory, "read-position.json"), "utf8"))); }
    catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      return { version: 1, base: { offset: 0, line: 1 }, partial: false, read: { offset: 0, line: 1 } };
    }
  }
  private save(state: LogState): Promise<void> { return atomicWrite(join(this.directory, "read-position.json"), JSON.stringify(state)); }
}
