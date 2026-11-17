import { base32 } from "multiformats/bases/base32";
import { bases } from "multiformats/basics";
import { CID } from "multiformats/cid";

/** Parses a CID in any common multibase (or legacy base58 CIDv0). */
export function parseCid(input: string): CID | null {
  try {
    if (input.startsWith("Qm")) return CID.parse(input);
    const base = Object.values(bases).find((candidate) => candidate.prefix === input[0]);
    return base ? CID.parse(input, base.decoder) : null;
  } catch {
    return null;
  }
}

/** CIDv1 in lowercase base32: safe to use as a DNS label. */
export function cidToV1Base32(cid: CID): string {
  return cid.toV1().toString(base32);
}

/** True for strings that look like a CIDv0 mangled by DNS lowercasing (e.g. `qmabc...`). */
export function isLowercasedCidV0(input: string): boolean {
  return input.length === 46 && input.startsWith("qm") && parseCid(input) === null;
}
