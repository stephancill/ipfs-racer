// Verified IPFS retrieval over the HTTP trustless gateway protocol
// (https://specs.ipfs.tech/http-gateways/trustless-gateway/).
//
// Public "deserializing" gateways (ipfs.io, dweb.link, ...) have been sunset, but
// trustless gateways still serve raw blocks / CARs. We fetch a CAR for the
// requested path, verify every block against its CID, and decode UnixFS here.

import {
  CODEC_DAG_PB,
  CODEC_RAW,
  type CID,
  cidToV1Base32,
  decodeCidBytes,
  multihashKey,
  parseCid,
  readVarint,
} from "./cid";

/** Gateways known to serve trustless CAR responses. */
export const TRUSTLESS_GATEWAYS = ["https://ipfs.orbitor.dev"];

const DELEGATED_ROUTING = "https://delegated-ipfs.dev/routing/v1";
const MAX_CAR_BYTES = 64 * 1024 * 1024;
const MAX_ROUTED_PROVIDERS = 4;

const MH_IDENTITY = 0x00;
const MH_SHA2_256 = 0x12;
const MH_SHA2_512 = 0x13;

const UNIXFS_RAW = 0;
const UNIXFS_DIRECTORY = 1;
const UNIXFS_FILE = 2;
const UNIXFS_HAMT = 5;

/** Thrown only when verified data proves the path does not exist. */
export class NotFoundError extends Error {}

type Blocks = Map<string, Uint8Array>;

type PBLink = { cid: CID; name: string };
type UnixFSNode =
  | { kind: "raw"; bytes: Uint8Array }
  | { kind: "pb"; links: PBLink[]; type: number; data?: Uint8Array; fanout?: number };

export type VerifiedResult =
  | { kind: "file"; bytes: Uint8Array; contentType: string }
  | { kind: "directory-redirect" };

// ---------------------------------------------------------------------------
// Provider discovery

/** Finds HTTPS trustless-gateway providers for a CID via delegated routing. */
export async function findHttpProviders(cid: CID, signal?: AbortSignal): Promise<string[]> {
  const url = `${DELEGATED_ROUTING}/providers/${cidToV1Base32(cid)}?filter-protocols=transport-ipfs-gateway-http`;
  const response = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!response.ok) return [];

  const body = (await response.json()) as { Providers?: { Addrs?: string[] }[] | null };
  const origins = new Set<string>();
  for (const provider of body.Providers ?? []) {
    for (const addr of provider.Addrs ?? []) {
      const origin = multiaddrToOrigin(addr);
      if (origin && !TRUSTLESS_GATEWAYS.includes(origin)) origins.add(origin);
    }
  }
  return [...origins].slice(0, MAX_ROUTED_PROVIDERS);
}

function multiaddrToOrigin(addr: string): string | null {
  const match = /^\/dns[46]?\/([^/]+)\/tcp\/(\d+)\/(?:https|tls\/http)(?:\/|$)/.exec(addr);
  if (!match) return null;
  const [, host, port] = match;
  return port === "443" ? `https://${host}` : `https://${host}:${port}`;
}

// ---------------------------------------------------------------------------
// Retrieval

/**
 * Fetches `/ipfs/<root>/<path...>` from a trustless gateway and returns verified
 * file bytes. Directories resolve to their `index.html`, or a generated listing.
 */
export async function fetchVerified({
  gateway,
  root,
  path,
  trailingSlash,
  signal,
}: {
  gateway: string;
  root: CID;
  path: string[];
  trailingSlash: boolean;
  signal?: AbortSignal;
}): Promise<VerifiedResult> {
  const blocks = await fetchCar({ gateway, root, path, signal });
  const target = await resolvePath(root, path, blocks);
  const node = await getNode(target, blocks);

  if (!isDirectory(node)) {
    const bytes = await readFile(target, blocks);
    return { kind: "file", bytes, contentType: contentTypeFor(path.at(-1) ?? "", bytes) };
  }

  // Directories must be served with a trailing slash so relative links resolve.
  if (!trailingSlash) {
    return { kind: "directory-redirect" };
  }

  const entries = await listDirectory(node, blocks);
  if (entries.some((entry) => entry.name === "index.html")) {
    const indexPath = [...path, "index.html"];
    const indexBlocks = await fetchCar({ gateway, root, path: indexPath, signal });
    const indexCid = await resolvePath(root, indexPath, indexBlocks);
    const bytes = await readFile(indexCid, indexBlocks);
    return { kind: "file", bytes, contentType: "text/html; charset=utf-8" };
  }

  const html = directoryListingHtml(path, entries);
  return {
    kind: "file",
    bytes: new TextEncoder().encode(html),
    contentType: "text/html; charset=utf-8",
  };
}

async function fetchCar({
  gateway,
  root,
  path,
  signal,
}: {
  gateway: string;
  root: CID;
  path: string[];
  signal?: AbortSignal;
}): Promise<Blocks> {
  const encodedPath = path.map(encodeURIComponent).join("/");
  const url = `${gateway}/ipfs/${cidToV1Base32(root)}${encodedPath ? `/${encodedPath}` : ""}?format=car&dag-scope=entity`;
  const response = await fetch(url, {
    headers: { accept: "application/vnd.ipld.car;version=1;order=dfs;dups=n" },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`bad status ${response.status}`);
  if (!(response.headers.get("content-type") ?? "").includes("application/vnd.ipld.car")) {
    throw new Error("gateway did not return a CAR");
  }

  const bytes = await readLimited(response.body, MAX_CAR_BYTES);
  return parseAndVerifyCar(bytes);
}

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("CAR too large");
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

async function parseAndVerifyCar(bytes: Uint8Array): Promise<Blocks> {
  const blocks: Blocks = new Map();
  let [headerLength, offset] = readVarint(bytes, 0);
  offset += headerLength;

  while (offset < bytes.length) {
    let sectionLength: number;
    [sectionLength, offset] = readVarint(bytes, offset);
    const sectionEnd = offset + sectionLength;
    if (sectionEnd > bytes.length) throw new Error("truncated CAR");

    const [cid, dataStart] = decodeCidBytes(bytes, offset);
    const data = bytes.subarray(dataStart, sectionEnd);
    if (!(await verifyBlock(cid, data))) throw new Error("block hash mismatch");
    blocks.set(multihashKey(cid.multihash), data);
    offset = sectionEnd;
  }

  return blocks;
}

async function verifyBlock(cid: CID, data: Uint8Array): Promise<boolean> {
  const [code, afterCode] = readVarint(cid.multihash, 0);
  const [length, digestStart] = readVarint(cid.multihash, afterCode);
  const expected = cid.multihash.subarray(digestStart);
  if (expected.length !== length) return false;

  let actual: Uint8Array;
  if (code === MH_IDENTITY) {
    actual = data;
  } else if (code === MH_SHA2_256 || code === MH_SHA2_512) {
    const algorithm = code === MH_SHA2_256 ? "SHA-256" : "SHA-512";
    actual = new Uint8Array(await crypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>));
  } else {
    return false; // unsupported hash function: cannot verify, so reject
  }

  if (actual.length < length) return false;
  for (let i = 0; i < length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

async function getBlock(cid: CID, blocks: Blocks): Promise<Uint8Array> {
  const [code, afterCode] = readVarint(cid.multihash, 0);
  if (code === MH_IDENTITY) {
    const [, digestStart] = readVarint(cid.multihash, afterCode);
    return cid.multihash.subarray(digestStart);
  }
  const block = blocks.get(multihashKey(cid.multihash));
  if (!block) throw new Error("missing block");
  return block;
}

// ---------------------------------------------------------------------------
// UnixFS

async function getNode(cid: CID, blocks: Blocks): Promise<UnixFSNode> {
  const bytes = await getBlock(cid, blocks);
  if (cid.codec === CODEC_RAW) return { kind: "raw", bytes };
  if (cid.codec !== CODEC_DAG_PB) throw new Error(`unsupported codec 0x${cid.codec.toString(16)}`);

  const pb = decodePBNode(bytes);
  if (!pb.data) return { kind: "pb", links: pb.links, type: UNIXFS_FILE };
  const unixfs = decodeUnixFSData(pb.data);
  return { kind: "pb", links: pb.links, ...unixfs };
}

function isDirectory(node: UnixFSNode): node is Extract<UnixFSNode, { kind: "pb" }> {
  return node.kind === "pb" && (node.type === UNIXFS_DIRECTORY || node.type === UNIXFS_HAMT);
}

async function resolvePath(root: CID, path: string[], blocks: Blocks): Promise<CID> {
  let current = root;
  for (const segment of path) {
    const node = await getNode(current, blocks);
    if (!isDirectory(node)) throw new NotFoundError("path traverses a non-directory");

    const next =
      node.type === UNIXFS_HAMT
        ? await hamtFind(node, segment, blocks)
        : (node.links.find((link) => link.name === segment)?.cid ?? null);
    if (!next) throw new NotFoundError(`no link named ${segment}`);
    current = next;
  }
  return current;
}

function hamtPadLength(fanout = 256): number {
  return (fanout - 1).toString(16).length;
}

// HAMT link names are "<hex bucket><entry name>" (entries) or "<hex bucket>" (sub-shards).
// The gateway only sends the shards on the path, so search the ones we have.
async function hamtFind(
  node: Extract<UnixFSNode, { kind: "pb" }>,
  name: string,
  blocks: Blocks,
): Promise<CID | null> {
  const pad = hamtPadLength(node.fanout);
  for (const link of node.links) {
    if (link.name.length > pad && link.name.slice(pad) === name) return link.cid;
  }
  for (const link of node.links) {
    if (link.name.length !== pad || !blocks.has(multihashKey(link.cid.multihash))) continue;
    const child = await getNode(link.cid, blocks);
    if (child.kind === "pb" && child.type === UNIXFS_HAMT) {
      const found = await hamtFind(child, name, blocks);
      if (found) return found;
    }
  }
  return null;
}

async function listDirectory(
  node: Extract<UnixFSNode, { kind: "pb" }>,
  blocks: Blocks,
): Promise<PBLink[]> {
  if (node.type !== UNIXFS_HAMT) return node.links;

  const pad = hamtPadLength(node.fanout);
  const entries: PBLink[] = [];
  for (const link of node.links) {
    if (link.name.length > pad) {
      entries.push({ cid: link.cid, name: link.name.slice(pad) });
    } else if (blocks.has(multihashKey(link.cid.multihash))) {
      const child = await getNode(link.cid, blocks);
      if (child.kind === "pb" && child.type === UNIXFS_HAMT) {
        entries.push(...(await listDirectory(child, blocks)));
      }
    }
  }
  return entries;
}

async function readFile(cid: CID, blocks: Blocks): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const visit = async (current: CID) => {
    const node = await getNode(current, blocks);
    if (node.kind === "raw") {
      chunks.push(node.bytes);
      return;
    }
    if (node.type !== UNIXFS_FILE && node.type !== UNIXFS_RAW) {
      throw new Error(`unsupported UnixFS type ${node.type}`);
    }
    if (node.data) chunks.push(node.data);
    for (const link of node.links) await visit(link.cid);
  };
  await visit(cid);
  return concat(chunks);
}

// ---------------------------------------------------------------------------
// Protobuf decoding (dag-pb + UnixFS Data)

type Field = { field: number; wire: number; value: number | Uint8Array };

function* protoFields(bytes: Uint8Array): Generator<Field> {
  let offset = 0;
  while (offset < bytes.length) {
    let tag: number;
    [tag, offset] = readVarint(bytes, offset);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      let value: number;
      [value, offset] = readVarint(bytes, offset);
      yield { field, wire, value };
    } else if (wire === 2) {
      let length: number;
      [length, offset] = readVarint(bytes, offset);
      if (offset + length > bytes.length) throw new Error("truncated protobuf");
      yield { field, wire, value: bytes.subarray(offset, offset + length) };
      offset += length;
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

const textDecoder = new TextDecoder();

function decodePBNode(bytes: Uint8Array): { links: PBLink[]; data?: Uint8Array } {
  const links: PBLink[] = [];
  let data: Uint8Array | undefined;
  for (const { field, value } of protoFields(bytes)) {
    if (field === 1 && value instanceof Uint8Array) data = value;
    if (field === 2 && value instanceof Uint8Array) {
      let cid: CID | undefined;
      let name = "";
      for (const linkField of protoFields(value)) {
        if (linkField.field === 1 && linkField.value instanceof Uint8Array) {
          [cid] = decodeCidBytes(linkField.value);
        }
        if (linkField.field === 2 && linkField.value instanceof Uint8Array) {
          name = textDecoder.decode(linkField.value);
        }
      }
      if (!cid) throw new Error("dag-pb link without hash");
      links.push({ cid, name });
    }
  }
  return { links, data };
}

function decodeUnixFSData(bytes: Uint8Array): { type: number; data?: Uint8Array; fanout?: number } {
  let type = UNIXFS_RAW;
  let data: Uint8Array | undefined;
  let fanout: number | undefined;
  for (const { field, value } of protoFields(bytes)) {
    if (field === 1 && typeof value === "number") type = value;
    if (field === 2 && value instanceof Uint8Array) data = value;
    if (field === 6 && typeof value === "number") fanout = value;
  }
  return { type, data, fanout };
}

// ---------------------------------------------------------------------------
// IPNS name resolution (DNSLink). ENS is handled by the caller.

export type IpfsPath = { root: CID; path: string[] };

export function parseIpfsPath(value: string): IpfsPath | null {
  const match = /^\/ipfs\/([^/]+)(\/.*)?$/.exec(value.trim());
  if (!match) return null;
  const root = parseCid(match[1]);
  if (!root) return null;
  const path = (match[2] ?? "")
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  return { root, path };
}

export async function resolveDnslink(
  name: string,
  signal?: AbortSignal,
  depth = 0,
): Promise<IpfsPath | null> {
  if (depth > 3) return null;
  const url = `https://cloudflare-dns.com/dns-query?name=_dnslink.${encodeURIComponent(name)}&type=TXT`;
  const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal });
  if (!response.ok) return null;

  const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
  for (const answer of body.Answer ?? []) {
    if (answer.type !== 16) continue;
    const text = answer.data.replace(/"\s*"/g, "").replace(/^"|"$/g, "");
    if (!text.startsWith("dnslink=")) continue;
    const value = text.slice("dnslink=".length);
    const ipfs = parseIpfsPath(value);
    if (ipfs) return ipfs;
    const ipns = /^\/ipns\/([^/]+)(\/.*)?$/.exec(value);
    if (ipns) {
      const inner = await resolveDnslink(ipns[1], signal, depth + 1);
      if (!inner) return null;
      const rest = (ipns[2] ?? "").split("/").filter(Boolean).map(decodeURIComponent);
      return { root: inner.root, path: [...inner.path, ...rest] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers

function concat(chunks: Uint8Array[], total?: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml",
  rss: "application/rss+xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
};

function contentTypeFor(filename: string, bytes: Uint8Array): string {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (extension && MIME_TYPES[extension]) return MIME_TYPES[extension];

  const head = textDecoder.decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return "text/html; charset=utf-8";
  }
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

function directoryListingHtml(path: string[], entries: PBLink[]): string {
  const title = `/${path.join("/")}`;
  const items = entries
    .map((entry) => {
      const href = encodeURIComponent(entry.name);
      return `<li><a href="./${href}">${escapeHtml(entry.name)}</a></li>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Index of ${escapeHtml(title)}</title></head><body><h1>Index of ${escapeHtml(title)}</h1><ul>${path.length ? '<li><a href="../">..</a></li>' : ""}${items}</ul></body></html>`;
}
