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

## `[receipt_proof_trust]`

Optional trust metadata for SDK verification of native receipt proofs.
If absent, the registry advertises no native receipt proof trust policy
for the network; clients that require one MUST fail closed or obtain the
policy from another authenticated source.

When present, the table MUST include both
`[receipt_proof_trust.archive]` and
`[receipt_proof_trust.finality]`.

Registry data is not proof of live availability, receipt existence, or
finality by itself. Clients still have to verify the proof payload,
archive signatures, finality signatures/transcripts, thresholds, and
validity bounds.

### `[receipt_proof_trust.archive]`

Archive receipt attestations use ML-DSA-65 signer public keys and a
signature threshold over the active signer set after height validity
bounds are applied.

| Field | Type | Required | Description |
|---|---|---|---|
| `signature_threshold` | `u32` | yes | Minimum number of valid archive ML-DSA-65 signatures required. Must be at least 1 and no greater than the active signer count. |
| `valid_from_height` | `u64` | no | First block height for which the archive policy is valid, inclusive. Missing means unbounded from genesis. |
| `valid_to_height` | `u64` | no | Last block height for which the archive policy is valid, inclusive. Missing means no height upper bound. |

#### `[[receipt_proof_trust.archive.signers]]`

At least one signer is required when the archive policy is present.

| Field | Type | Required | Description |
|---|---|---|---|
| `public_key` | hex string (`0x...`) | yes | 1952-byte ML-DSA-65 public key. |
| `signer_id` | hex string (`0x...`) | no | 20-byte canonical signer id for diagnostics and key rotation. |
| `valid_from_height` | `u64` | no | First block height for which the signer is valid, inclusive. Missing means unbounded from genesis. |
| `valid_to_height` | `u64` | no | Last block height for which the signer is valid, inclusive. Missing means no height upper bound. |
| `notes` | string | no | Free-form operator notes. Do not put secrets here. |

Duplicate signer `public_key` values are invalid. Duplicate non-empty
`signer_id` values are invalid.

### `[receipt_proof_trust.finality]`

Finality verification uses one of two mutually exclusive BLS policy
modes:

| Field | Type | Required | Description |
|---|---|---|---|
| `mode` | enum | yes | `cluster` or `multisig`. |
| `chain_id` | `u64` | no | Chain id override for finality verification. SDK helpers default this to the top-level `chain_id`. |
| `threshold` | `u32` | yes | Minimum number of finality signatures required. Must be at least 1 and no greater than `committee_size` in cluster mode or the active signer count in multisig mode. |
| `committee_size` | `u32` | mode-dependent | Required only when `mode = "cluster"`. Total cluster committee size. |
| `cluster_public_key` | hex string (`0x...`) | mode-dependent | Required only when `mode = "cluster"`. 48-byte BLS cluster public key. |
| `valid_from_round` | `u64` | no | First consensus round for which the finality policy is valid, inclusive. Missing means unbounded from round 0. |
| `valid_to_round` | `u64` | no | Last consensus round for which the finality policy is valid, inclusive. Missing means no round upper bound. |

For `cluster`, `committee_size` and `cluster_public_key` are required
and the multisig signer roster MUST be absent. For `multisig`, at least
one signer is required and `committee_size` and `cluster_public_key`
MUST be absent.

#### `[[receipt_proof_trust.finality.signers]]`

Only valid when `mode = "multisig"`.

| Field | Type | Required | Description |
|---|---|---|---|
| `authority_index` | `u32` | yes | Authority index used by the finality transcript in multisig mode. Unique within the finality roster. |
| `public_key` | hex string (`0x...`) | yes | 48-byte BLS public key. |
| `valid_from_round` | `u64` | no | First consensus round for which the signer is valid, inclusive. Missing means unbounded from round 0. |
| `valid_to_round` | `u64` | no | Last consensus round for which the signer is valid, inclusive. Missing means no round upper bound. |
| `notes` | string | no | Free-form operator notes. Do not put secrets here. |

Duplicate `authority_index` or `public_key` values are invalid.

If a configured validity bound cannot be checked against a proof, the
client MUST reject the proof. Validators SHOULD reject entries where a
`valid_to_*` value is less than the matching `valid_from_*` value.

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
