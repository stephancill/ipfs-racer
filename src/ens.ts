import { createPublicClient, http, namehash, parseAbiItem } from "viem";
import { mainnet } from "viem/chains";

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

export function freshnessHtml(name: string, age: number | null): string {
  if (age === null) {
    return "";
  }

  const recent = age < DAY_SECONDS;
  const color = recent ? "#f97316" : "#22c55e";
  const label = recent ? `updated ${formatAge(age)} ago` : "stable";

  return `
<style>
#_sref-dot {
  position: fixed;
  bottom: 12px;
  right: 12px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: ${color};
  box-shadow: 0 0 6px ${color};
  z-index: 2147483647;
  cursor: default;
}
#_sref-tooltip {
  position: fixed;
  bottom: 30px;
  right: 8px;
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
#_sref-dot:hover + #_sref-tooltip {
  opacity: 1;
}
</style>
<div id="_sref-dot" title="${name}"></div>
<div id="_sref-tooltip">${name} ${label}</div>
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
