// Minimal CID / multibase helpers (no dependencies).

export const CODEC_RAW = 0x55;
export const CODEC_DAG_PB = 0x70;
export const CODEC_LIBP2P_KEY = 0x72;

export type CID = {
  version: 0 | 1;
  codec: number;
  /** Full multihash bytes: <code varint><length varint><digest> */
  multihash: Uint8Array;
};

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function readVarint(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0;
  let multiplier = 1;
  let i = offset;
  for (;;) {
    if (i >= bytes.length) throw new Error("varint out of range");
    const byte = bytes[i++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) break;
    multiplier *= 128;
    if (multiplier > 2 ** 56) throw new Error("varint too long");
  }
  return [value, i];
}

export function encodeVarint(value: number): number[] {
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
}

function base32Decode(input: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("invalid base32");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function baseXDecode(input: string, alphabet: string): Uint8Array {
  const base = BigInt(alphabet.length);
  let value = 0n;
  for (const char of input) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error("invalid base-x character");
    value = value * base + BigInt(index);
  }
  const out: number[] = [];
  while (value > 0n) {
    out.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of input) {
    if (char !== alphabet[0]) break;
    out.unshift(0);
  }
  return new Uint8Array(out);
}

function hexDecode(input: string): Uint8Array {
  if (input.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(input)) throw new Error("invalid hex");
  const out = new Uint8Array(input.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(input.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function decodeCidBytes(bytes: Uint8Array, offset = 0): [cid: CID, next: number] {
  // CIDv0 is a bare sha2-256 multihash.
  if (bytes[offset] === 0x12 && bytes[offset + 1] === 0x20) {
    const end = offset + 34;
    if (end > bytes.length) throw new Error("truncated CIDv0");
    return [{ version: 0, codec: CODEC_DAG_PB, multihash: bytes.slice(offset, end) }, end];
  }

  let [version, i] = readVarint(bytes, offset);
  if (version !== 1) throw new Error(`unsupported CID version ${version}`);
  let codec: number;
  [codec, i] = readVarint(bytes, i);
  const mhStart = i;
  let digestLength: number;
  [, i] = readVarint(bytes, i);
  [digestLength, i] = readVarint(bytes, i);
  const end = i + digestLength;
  if (end > bytes.length) throw new Error("truncated CID");
  return [{ version: 1, codec, multihash: bytes.slice(mhStart, end) }, end];
}

/** Parses a CID string (CIDv0 base58, or CIDv1 in base32/base58btc/base36/base16). */
export function parseCid(input: string): CID | null {
  try {
    if (input.length === 46 && input.startsWith("Qm")) {
      const [cid] = decodeCidBytes(baseXDecode(input, BASE58_ALPHABET));
      return cid;
    }

    const prefix = input[0];
    const rest = input.slice(1);
    let bytes: Uint8Array;
    switch (prefix) {
      case "b":
        bytes = base32Decode(rest);
        break;
      case "B":
        bytes = base32Decode(rest.toLowerCase());
        break;
      case "z":
        bytes = baseXDecode(rest, BASE58_ALPHABET);
        break;
      case "k":
        bytes = baseXDecode(rest, BASE36_ALPHABET);
        break;
      case "K":
        bytes = baseXDecode(rest.toLowerCase(), BASE36_ALPHABET);
        break;
      case "f":
      case "F":
        bytes = hexDecode(rest);
        break;
      default:
        return null;
    }
    const [cid, end] = decodeCidBytes(bytes);
    if (end !== bytes.length) return null;
    return cid;
  } catch {
    return null;
  }
}

export function cidToBytes(cid: CID): Uint8Array {
  if (cid.version === 0) return cid.multihash;
  return new Uint8Array([...encodeVarint(1), ...encodeVarint(cid.codec), ...cid.multihash]);
}

/** CIDv1, lowercase base32: safe to use as a DNS label. */
export function cidToV1Base32(cid: CID): string {
  return `b${base32Encode(cidToBytes({ ...cid, version: 1 }))}`;
}

export function multihashKey(multihash: Uint8Array): string {
  let out = "";
  for (const byte of multihash) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** True for strings that look like a CIDv0 mangled by DNS lowercasing (e.g. `qmabc...`). */
export function isLowercasedCidV0(input: string): boolean {
  return input.length === 46 && input.startsWith("qm") && parseCid(input) === null;
}
