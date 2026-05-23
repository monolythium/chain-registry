# Chain TOML schema

Every file under [`../chains/`](../chains) follows this shape. Validators
that reject extra fields are encouraged but not required — additive
fields land in patch versions.

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `chain_id` | `u64` | yes | Numeric chain id used in `eth_chainId` and tx replay protection. |
| `network` | string | yes | Slug matching the file name (without `.toml`). Lowercase, ASCII letters / digits / hyphens, 3–32 chars. |
| `genesis_hash` | hex string (`0x...`) | yes | 32-byte keccak hash of the canonical genesis block. The only authoritative chain-identity pin. |
| `binary_sha` | git short SHA | yes | mono-core commit the active validator binary was built from. Lets a reader verify the chain is running known software. |
| `display_name` | string | no | Human-readable network name for UI ("Monolythium Testnet"). Falls back to `network` if absent. |
| `description` | string | no | One-line purpose statement. |
| `created` | RFC-3339 date | no | When the network first launched. |

## `[[rpc]]`

At least one `[[rpc]]` block per network. Order matters — clients try
them top-to-bottom for first-touch.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Full URL including scheme + port. HTTPS preferred for public networks. |
| `provider` | string | yes | Operator identifier. `monolythium-foundation` for foundation nodes; community operators use a self-chosen slug. |
| `region` | string | no | Hetzner region code (`fsn1`, `nbg1`, `hel1`, `ash`, `sin`) or human region (`us-east`, `eu-west`). Used for latency-aware client routing. |
| `tier` | enum | yes | `official` (foundation-operated, healthy), `degraded` (foundation-operated but currently unhealthy — e.g. resyncing, partial state), or `community` (third-party). Clients prefer `official` for first-touch and SHOULD skip `degraded` for routing unless explicitly asked. |
| `archive` | bool | no | `true` if the node serves full historical state. Default `false` (head-only). |
| `ws_url` | string | no | WebSocket endpoint if separate from `url`. |
| `notes` | string | no | Free-form. Document rate limits, SLA, contact. |

## `[[p2p]]`

P2P seed entries for nodes that want to join the gossip mesh directly.

| Field | Type | Required | Description |
|---|---|---|---|
| `multiaddr` | string | yes | libp2p multiaddr including protocol stack and `peer_id`. Example: `/ip4/178.105.12.9/tcp/30303/p2p/12D3KooW...`. |
| `region` | string | no | Same shape as `[[rpc]]::region`. |

## `[[explorer]]`

Block explorers / Monoscan instances. Optional but encouraged.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Base URL of the explorer. |
| `name` | string | yes | Display name. |
| `kind` | enum | no | `monoscan` (canonical), `etherscan-fork`, `custom`. Default `monoscan`. |

## Reserved fields

The following keys are reserved for future use and MUST NOT be set today:

- `cluster_id`, `cluster_name` — reserved for the cluster-name registry view (Law §5.9).
- `bridge_assets`, `bridges` — reserved for bridge / IBC integration metadata (will move into a sibling `bridges/` tree, not inline in chain files).

Setting a reserved field is a hard rejection at validation time once a
schema validator ships.

## Versioning

This schema is **v1**. Any breaking change (renaming, removing a field,
narrowing a type) requires a new schema document under
`schemas/chain.v2.schema.md` and a corresponding `schema_version`
field on each TOML — that field is **NOT** part of v1 (its absence
implies v1).
