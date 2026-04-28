# ipfs-racer

Cloudflare Worker that races public IPFS and IPNS gateways and returns the first valid response.

## Usage

```
https://<cid>.ipfs.stupidtech.net/
https://<cid>.ipfs.stupidtech.net/path/to/resource
```

The path-based format redirects to the subdomain format:

```
https://ipfs.stupidtech.net/ipfs/<cid>/    →  https://<cid>.ipfs.stupidtech.net/
https://ipfs.stupidtech.net/ipns/<name>/   →  served directly
```

## Gateways

Requests race these public gateways. The fastest valid response wins.

- `dweb.link` (subdomain)
- `ipfs.io` (path)
- `gateway.pinata.cloud` (path)

## ENS freshness indicator

When visiting via a search engine like [stupid search](https://search.stupidtech.net), a dot appears in the bottom-right corner:

- **Green** — No contenthash changes in the last 24 hours.
- **Orange** — Recently updated (shows how long ago).

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
