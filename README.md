# ipfs-racer

Cloudflare Worker that races public IPFS and IPNS gateways and returns the first valid response.

## Usage

```
ipfs.stupidtech.net/ipfs/<cid>
ipfs.stupidtech.net/ipfs/<cid>/path/to/resource
ipfs.stupidtech.net/ipns/<name>
ipfs.stupidtech.net/ipns/<name>/path/to/resource
```

## Development

```bash
bun install
bun run dev
```

## Checks

```bash
bun run format
bun run lint
```

## Deploy

```bash
bun run deploy
```
