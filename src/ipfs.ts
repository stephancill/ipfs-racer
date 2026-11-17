import { withHTTP } from "@helia/http";
import { createVerifiedFetchWithHelia, type VerifiedFetch } from "@helia/verified-fetch";
import { dns } from "@multiformats/dns";
import { dnsJsonOverHttps } from "@multiformats/dns/resolvers";
import * as dagPb from "@ipld/dag-pb";
import { createHeliaLight } from "helia";
import { UnixFS } from "ipfs-unixfs";

// Workers have no BroadcastChannel. Helia's block-storage lock (mortice) creates one, but in
// single-process mode (`holdGcLock: true` below) it only listens on it, so a no-op is safe.
if (!("BroadcastChannel" in globalThis)) {
  Object.assign(globalThis, {
    BroadcastChannel: class extends EventTarget {
      constructor(readonly name: string) {
        super();
      }
      postMessage(): void {}
      close(): void {}
    },
  });
}

// Free trustless gateways that still answer server-side requests (checked 2026-11-17).
// ipfs.io, dweb.link and trustless-gateway.link are rate limited or down for backend traffic.
export const TRUSTLESS_GATEWAYS = [
  "https://ipfs.orbitor.dev",
  "https://eu.orbitor.dev",
  "https://apac.orbitor.dev",
  "https://latam.orbitor.dev",
  "https://ipfs.greyh.at",
  "https://via0.com",
  "https://ipfs.filebase.io",
];

// Finds additional HTTP providers for a CID (e.g. the pinning service hosting it),
// resolves IPNS records, and backs DNSLink lookups.
const DELEGATED_ROUTERS = ["https://delegated-ipfs.dev"];

/**
 * Creates an HTTP-only verified-fetch instance: blocks are fetched from trustless
 * gateways and verified against their CIDs before UnixFS is decoded here.
 *
 * A fresh instance per request: Workers forbid sharing in-flight I/O between requests.
 */
export async function createVerifiedFetch(): Promise<VerifiedFetch> {
  const helia = await withHTTP(
    createHeliaLight({
      holdGcLock: true,
      dns: dns({
        resolvers: {
          ".": [
            dnsJsonOverHttps("https://cloudflare-dns.com/dns-query"),
            dnsJsonOverHttps("https://dns.google/resolve"),
          ],
        },
      }),
    }),
    { delegatedRouters: DELEGATED_ROUTERS, recursiveGateways: TRUSTLESS_GATEWAYS },
  ).start();
  return createVerifiedFetchWithHelia(helia);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

/**
 * verified-fetch returns the raw (already verified) dag-pb block for a directory without an
 * index.html. Render it as an HTML listing, as other gateways do. Returns null for anything
 * that is not a plain UnixFS directory (e.g. HAMT-sharded directories).
 */
export function directoryListingHtml(block: Uint8Array, title: string): string | null {
  const node = dagPb.decode(block);
  if (!node.Data || UnixFS.unmarshal(node.Data).type !== "directory") return null;

  const items = node.Links.map((link) => {
    const name = link.Name ?? "";
    return `<li><a href="./${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`;
  }).join("");
  const heading = `Index of ${escapeHtml(title)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${heading}</title></head><body><h1>${heading}</h1><ul><li><a href="../">..</a></li>${items}</ul></body></html>`;
}
