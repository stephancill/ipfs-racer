import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  hexToBytes,
  http,
  namehash,
  parseAbi,
  parseAbiItem,
  toHex,
} from "viem";
import { normalize } from "viem/ens";
import { mainnet } from "viem/chains";
import { decodeCidBytes, readVarint } from "./cid";
import type { IpfsPath } from "./trustless";

const RPC_URL = "https://evm.stupidtech.net/v1/1";
const ENS_RESOLVER = "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63";
const CONTENTHASH_EVENT = parseAbiItem(
  "event ContenthashChanged(bytes32 indexed node, bytes hash)",
);
const DAY_SECONDS = 86_400;
const BLOCKS_PER_DAY = 7200;

let client: ReturnType<typeof createPublicClient> | undefined;

function getClient() {
  client ??= createPublicClient({ chain: mainnet, transport: http(RPC_URL) });
  return client;
}

export async function lookupContenthashAge(name: string): Promise<number | null> {
  const node = namehash(name);

  try {
    const latestBlock = await getClient().getBlock();
    const fromBlock = BigInt(Math.max(0, Number(latestBlock.number) - BLOCKS_PER_DAY));

    const logs = await getClient().getLogs({
      address: ENS_RESOLVER,
      event: CONTENTHASH_EVENT,
      args: { node },
      fromBlock,
      toBlock: latestBlock.number,
    });

    if (logs.length === 0) {
      return Infinity;
    }

    const latestEvent = logs[logs.length - 1];
    if (!latestEvent.blockNumber) {
      return Infinity;
    }

    const txBlock = await getClient().getBlock({ blockNumber: latestEvent.blockNumber });
    if (!txBlock) {
      return Infinity;
    }

    return Number(latestBlock.timestamp) - Number(txBlock.timestamp);
  } catch {
    return null;
  }
}

const CONTENTHASH_ABI = parseAbi(["function contenthash(bytes32 node) view returns (bytes)"]);
const UNIVERSAL_RESOLVER_ABI = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
]);
const IPFS_NS = 0xe3;

function dnsEncode(name: string): Hex {
  const bytes: number[] = [];
  for (const label of name.split(".")) {
    const encoded = new TextEncoder().encode(label);
    bytes.push(encoded.length, ...encoded);
  }
  bytes.push(0);
  return toHex(new Uint8Array(bytes));
}

/** Resolves an ENS name's contenthash to an IPFS path (ipfs-ns only). */
export async function resolveEnsContenthash(name: string): Promise<IpfsPath | null> {
  const normalized = normalize(name);
  const [result] = await getClient().readContract({
    address: mainnet.contracts.ensUniversalResolver.address,
    abi: UNIVERSAL_RESOLVER_ABI,
    functionName: "resolve",
    args: [
      dnsEncode(normalized),
      encodeFunctionData({
        abi: CONTENTHASH_ABI,
        functionName: "contenthash",
        args: [namehash(normalized)],
      }),
    ],
  });
  const contenthash = decodeFunctionResult({
    abi: CONTENTHASH_ABI,
    functionName: "contenthash",
    data: result,
  });

  const bytes = hexToBytes(contenthash);
  if (bytes.length === 0) return null;
  const [namespace, offset] = readVarint(bytes, 0);
  if (namespace !== IPFS_NS) return null;
  const [root] = decodeCidBytes(bytes, offset);
  return { root, path: [] };
}

export function freshnessHtml(name: string, age: number | null): string {
  if (age === null) {
    return "";
  }

  const recent = age < DAY_SECONDS;
  const color = recent ? "#f97316" : "#22c55e";
  const label = recent ? `updated ${formatAge(age)} ago` : `No changes to ${name} in the last day`;

  return `
<style>
#_sref-badge {
  position: fixed !important;
  top: 50% !important;
  bottom: auto !important;
  transform: translateY(-50%) !important;
  right: 0 !important;
  width: 32px !important;
  height: 32px !important;
  min-width: 32px !important;
  min-height: 32px !important;
  max-width: 32px !important;
  max-height: 32px !important;
  border-radius: 0 !important;
  background: transparent !important;
  padding: 6px 4px !important;
  margin: 0 !important;
  border: 0 !important;
  cursor: default;
  z-index: 2147483647;
  box-shadow: none !important;
  display: flex !important;
  align-items: center;
  justify-content: center;
  box-sizing: content-box !important;
  overflow: visible !important;
}
#_sref-badge img {
  width: 28px !important;
  height: 28px !important;
  min-width: 28px !important;
  min-height: 28px !important;
  max-width: 28px !important;
  max-height: 28px !important;
  object-fit: contain !important;
  display: block !important;
  border: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  box-sizing: content-box !important;
  opacity: 1 !important;
  filter: none !important;
  transform: none !important;
}
#_sref-dot {
  position: absolute;
  bottom: 5px;
  left: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${color};
}
#_sref-tooltip {
  position: fixed;
  top: 50%;
  transform: translateY(calc(-50% - 32px));
  right: 0;
  background: #111;
  color: #ccc;
  font-family: system-ui, sans-serif;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
  z-index: 2147483647;
}
#_sref-badge:hover + #_sref-tooltip,
#_sref-dot:hover + #_sref-tooltip {
  opacity: 1;
}
</style>
<div id="_sref-badge">
  <img src="https://ipfs.stupidtech.net/badge.png" />
  <div id="_sref-dot"></div>
</div>
<div id="_sref-tooltip">${label}</div>
`;
}

function formatAge(seconds: number): string {
  const days = Math.floor(seconds / DAY_SECONDS);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m`;
}
