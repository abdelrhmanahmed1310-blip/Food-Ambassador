/**
 * Minimal DER (ASN.1) encoding and decoding — enough for a PKCS#10 request
 * with ZATCA's extensions and for reading certificates (ADR-064). Node has
 * no CSR builder, and WebCrypto does not support secp256k1.
 */

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

export const tlv = (tag: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), len(content.length), content]);

export const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
export const printable = (s: string) => tlv(0x13, Buffer.from(s, "ascii"));
export const octets = (b: Buffer) => tlv(0x04, b);
export const bits = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
export const explicit = (n: number, content: Buffer) => tlv(0xa0 | n, content);
/** [n] IMPLICIT constructed (e.g. CSR attributes). */
export const implicitSet = (n: number, ...items: Buffer[]) => tlv(0xa0 | n, Buffer.concat(items));

export function integer(n: number | bigint): Buffer {
  let hex = BigInt(n).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let b = Buffer.from(hex, "hex");
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map((p) => BigInt(p));
  const out: number[] = [Number(parts[0] * 40n + parts[1])];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    let v = p;
    do {
      chunk.unshift(Number(v & 0x7fn));
      v >>= 7n;
    } while (v > 0n);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

export interface Node {
  tag: number;
  /** Content bytes. */
  value: Buffer;
  /** The whole element (tag, length and content). */
  raw: Buffer;
}

/** Read one element at `offset`. */
export function read(buf: Buffer, offset = 0): Node & { end: number } {
  const tag = buf[offset];
  let length = buf[offset + 1];
  let head = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | buf[offset + 2 + i];
    head += count;
  }
  const start = offset + head;
  const end = start + length;
  return { tag, value: buf.subarray(start, end), raw: buf.subarray(offset, end), end };
}

/** The elements inside a constructed element. */
export function children(node: { value: Buffer }): Node[] {
  const out: Node[] = [];
  for (let at = 0; at < node.value.length;) {
    const n = read(node.value, at);
    out.push(n);
    at = n.end;
  }
  return out;
}
