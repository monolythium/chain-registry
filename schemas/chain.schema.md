# Chain TOML schema

Every file under [`../chains/`](../chains) follows this shape. Validators
that reject extra fields are encouraged but not required — additive
fields land in patch versions.

Run `node scripts/validate-chain-registry.mjs` from the repository root
before publishing registry changes. The validator is the current
machine-readable acceptance gate for v1 chain files and receipt proof
trust metadata.

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `chain_id` | `u64` | yes | Numeric chain id used in `eth_chainId` and tx replay protection. |
| `network` | string | yes | Slug matching the file name (without `.toml`). Lowercase, ASCII letters / digits / hyphens, 3–32 chars. |
| `genesis_hash` | hex string (`0x...`) | yes | 32-byte keccak256 hash over the **raw on-disk bytes** of the canonical genesis file. The authoritative chain-identity pin and the on-chain genesis hash. |
| `genesis_url` | string (`https://`) | no | HTTPS URL of the full genesis content for dynamic resolution (see "Dynamic genesis resolution" below). When it points at this repo's `chains/genesis/<network>.genesis.toml`, the validator verifies the on-disk bytes against `genesis_hash` (and `genesis_sha256`) offline. |
| `genesis_sha256` | hex string (64 chars, no `0x`) | no | SHA-256 of the genesis bytes served at `genesis_url`. A cheap content pre-check; `sha256sum`-style lowercase hex. Requires `genesis_url`. NOT the chain-identity pin (`genesis_hash` is). |
| `milestones_url` | string (`https://`) | no | HTTPS URL of the canonical milestone config (`chains/milestones/<network>.milestones.toml`). Carries rolling-upgrade entries that activate protocol parameters / precompile gates at chosen heights without a re-genesis. A deploy-time reference (fetch + `cosign verify-blob`, not a runtime fetch); the chain loads the file as plain config and the genesis-pinned `milestone_digest` binds it. Mirrors `genesis_url`. See "Milestones" below. |
| `milestones_sha256` | hex string (64 chars, no `0x`) | no | SHA-256 of the milestone config served at `milestones_url`. A cheap content pre-check; `sha256sum`-style lowercase hex. Requires `milestones_url`. Authenticity is the cosign `.sig`/`.pem` beside the file, not this hash. |
| `binary_sha` | git short SHA | yes | mono-core commit the active validator binary was built from. Lets a reader verify the chain is running known software. |
| `display_name` | string | no | Human-readable network name for UI ("Monolythium Testnet"). Falls back to `network` if absent. |
| `description` | string | no | One-line purpose statement. |
| `created` | RFC-3339 date | no | When the network first launched. |
| `status` | string | no | `reserved` for a claimed chain id with no live network yet. Reserved entries intentionally omit `genesis_hash`, `binary_sha`, `[[rpc]]`, and `[[p2p]]` until launch. |

## Dynamic genesis resolution

`genesis_url` + `genesis_sha256` let a node resolve the **full** genesis at
boot instead of running a genesis baked into its OS image, so a re-genesis is
picked up on the next boot with no image rebuild. The image bakes *who* to
trust (this registry path), not *what* to run.

A node fetches the registry entry, fetches the genesis from `genesis_url`,
recomputes **keccak256 over the raw on-disk bytes**, and requires it to equal
`genesis_hash` **before** init. The same invariant is enforced offline at
PR/push time by `scripts/validate-chain-registry.mjs` for any genesis committed
to this repo (`chains/genesis/*.toml`): the file must exist, its sha256 must
equal `genesis_sha256` (when set), and `keccak256(raw bytes) == genesis_hash`.

**Testnet trust model.** On testnet, `genesis_hash` is the authoritative pin
and the only integrity check. The expected hash and the served content share a
single trust root (this repo / GitHub), so the keccak match is **circular** —
it proves the content matches a number the same writer chose. It is **not**
cryptographic integrity against a registry or GitHub compromise. This is
acceptable only because testnet is value-less and wiped without notice.

**Mainnet-only genesis hardening (groundwork — not used on testnet).** The
fields below break that circularity by adding factors the registry writer does
not control. They are documented placeholders only: they are commented out in
the chain files and are a **hard rejection** if set as active values today
(no verification path enforces them yet). A node MUST ignore them on testnet.

| Field | Type | Used by | Description |
|---|---|---|---|
| `genesis_sig_url` | string (`https://`) | mainnet | HTTPS URL of the detached cosign signature (`.sig`) over the genesis blob. Verified with `cosign verify-blob` **before** the keccak hash check. |
| `genesis_cert_identity` | string | mainnet | Expected cosign certificate identity (OIDC SAN regex). **Image-baked**, never trusted from the registry — the image pins *who* may sign genesis. |
| `genesis_cert_issuer` | string | mainnet | Expected cosign OIDC issuer URL (e.g. the GitHub Actions OIDC issuer). Image-baked, used with `genesis_cert_identity`. |
| `registry_rev` | string (40-char commit SHA) | mainnet | Commit-SHA pin for this registry, baked per signed image instead of the moving `master` ref, so a registry-account compromise or stale CDN edge cannot silently redirect `genesis_hash` / `genesis_url`. |

## Milestones

`milestones_url` + `milestones_sha256` point at the network's canonical,
**unsigned**, cosigned milestone config
(`chains/milestones/<network>.milestones.toml`). Milestones activate protocol
parameters and precompile gates at chosen block **heights** without cutting a
new genesis — the rolling-upgrade mechanism.

The config keeps a `[meta]` header (`chain_id` + a `config_id` string) and one
or more `[[entries]]`. It deliberately **drops** the old on-chain signature
apparatus (`[meta].signers` / `threshold` / `signer_set_id` and the
`[[signatures]]` blocks): the chain loads the file as plain config and does
**not** verify an in-file signature.

Authenticity comes from two anchors instead, exactly like `genesis_url`:

- **Supply-chain — the cosign blob.** CI
  (`.github/workflows/milestones-attestation.yml`) `cosign sign-blob`s the file
  (keyless OIDC) and commits the `.sig` / `.pem` / `.sha256` beside it.
  Operators `cosign verify-blob` against the workflow cert-identity / OIDC
  issuer **before** deploy.
- **On-chain — the genesis-pinned digest.** Genesis pins the config's canonical
  `milestone_digest`; a node recomputes it and requires a match before applying
  any entry, binding the milestones it enforces to the genesis it booted.

To roll an upgrade: edit `[[entries]]` with a future activation `height`, push
(CI re-cosigns), then operators verify, deploy, and roll the fleet **before**
the new height. See the repo README "Milestones".

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
- `genesis_sig_url`, `genesis_cert_identity`, `genesis_cert_issuer`, `registry_rev` — mainnet-only genesis hardening groundwork (see "Dynamic genesis resolution"). Documented as commented placeholders only; rejected as active values until the mainnet verification path exists to enforce them.

Setting a reserved field is a hard rejection at validation time
(`scripts/validate-chain-registry.mjs`).

## Versioning

This schema is **v1**. Any breaking change (renaming, removing a field,
narrowing a type) requires a new schema document under
`schemas/chain.v2.schema.md` and a corresponding `schema_version`
field on each TOML — that field is **NOT** part of v1 (its absence
implies v1).
