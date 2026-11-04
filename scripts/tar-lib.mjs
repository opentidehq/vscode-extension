// A streaming reader of POSIX tar (ustar, with pax and GNU long names) that keeps the entries a
// predicate wants. For scripts/runtime-licenses.mjs: the full python-build-standalone archives are
// hundreds of MB, and only a few small files of them are needed.
import { Writable } from "node:stream";

const BLOCK = 512;

const text = (buffer, start, length) => {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end >= 0 && end < start + length ? end : start + length);
};
const octal = (buffer, start, length) => Number.parseInt(text(buffer, start, length).trim() || "0", 8);

/** `path=…` from a pax extended header. */
function paxPath(body) {
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number.parseInt(body.toString("utf8", at, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.toString("utf8", space + 1, at + length - 1);
    if (record.startsWith("path=")) return record.slice(5);
    at += length;
  }
  return undefined;
}

export class TarReader extends Writable {
  /** @param {(path: string) => boolean} wanted */
  constructor(wanted) {
    super();
    this.wanted = wanted;
    /** @type {Map<string, Buffer>} */
    this.files = new Map();
    this.buffer = Buffer.alloc(0);
    this.entry = undefined; // { path, size, keep, chunks, remaining, kind }
    this.nextPath = undefined;
    this.pendingPadding = 0;
    this.ended = false;
  }

  _write(chunk, _encoding, done) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      this.drain();
      done();
    } catch (error) {
      done(error);
    }
  }

  drain() {
    for (;;) {
      if (this.ended) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.entry) {
        const take = Math.min(this.entry.remaining, this.buffer.length);
        if (this.entry.keep && take > 0) this.entry.chunks.push(this.buffer.subarray(0, take));
        this.entry.remaining -= take;
        this.buffer = this.buffer.subarray(take);
        if (this.entry.remaining > 0) return;
        this.pendingPadding = (BLOCK - (this.entry.size % BLOCK)) % BLOCK;
        this.finish(this.entry);
        this.entry = undefined;
        continue;
      }
      if (this.pendingPadding) {
        const skip = Math.min(this.pendingPadding, this.buffer.length);
        this.pendingPadding -= skip;
        this.buffer = this.buffer.subarray(skip);
        if (this.pendingPadding > 0) return;
      }
      if (this.buffer.length < BLOCK) return;
      const header = this.buffer.subarray(0, BLOCK);
      this.buffer = this.buffer.subarray(BLOCK);
      if (header.every((byte) => byte === 0)) {
        this.ended = true;
        continue;
      }
      const type = String.fromCharCode(header[156] || 0x30);
      const prefix = text(header, 345, 155);
      const name = text(header, 0, 100);
      const size = octal(header, 124, 12);
      const path = this.nextPath ?? (prefix ? `${prefix}/${name}` : name);
      if (type !== "x" && type !== "L" && type !== "g") this.nextPath = undefined;
      const kind = type === "x" ? "pax" : type === "L" ? "longname" : type === "g" ? "global" : "file";
      const keep =
        kind === "pax" || kind === "longname" || ((type === "0" || type === "\0") && this.wanted(path));
      this.entry = { path, size, keep, chunks: [], remaining: size, kind };
    }
  }

  finish(entry) {
    if (!entry.keep) return;
    const body = Buffer.concat(entry.chunks);
    if (entry.kind === "pax") this.nextPath = paxPath(body) ?? this.nextPath;
    else if (entry.kind === "longname") this.nextPath = body.toString("utf8").replace(/\0+$/, "");
    else this.files.set(entry.path, body);
  }
}
