# Monolythium Chain Registry

Public peer / RPC / explorer index for every Monolythium network. One TOML file per network. Version-controlled so that wallets, dApps, infrastructure operators, and the official SDK can pin a known-good list and update on a clear cadence.

> Part of the [Monolythium](https://monolythium.com) ecosystem — a sovereign Layer-1 for finality-first apps.

---

## What this is

A small, structured catalog of Monolythium networks: chain id, genesis hash, public RPC endpoints, P2P seed multiaddrs, and explorers. Each network is a single TOML file under [`chains/`](./chains). The schema is [`schemas/chain.schema.md`](./schemas/chain.schema.md).

## Who this is for

- **Wallet authors** wiring "Add Monolythium network" buttons.
- **Infrastructure operators** scripting node bootstraps (`monolythium node start --network testnet-69420`).
- **dApp developers** picking an RPC URL without spelunking through Discord pins.
- **The official SDK** ([`monolythium-core-sdk`](https://github.com/monolythium/mono-core-sdk)) which vendors a snapshot at release time + offers an opt-in runtime fetch from this repo.

If you're a power user with a single private node, you don't need this — pass your URL directly to the SDK.

## Quickstart

### Curl + jq

```bash
curl -s https://raw.githubusercontent.com/monolythium/chain-registry/master/chains/testnet-69420.toml | head
```

### Programmatic (Rust)

```rust
use monolythium_core_sdk::{ProtocoreClient, Network};

// Bootstrap RPCs are baked in at SDK release time from this repo.
let client = ProtocoreClient::for_network(Network::Testnet69420).await?;

// Or, opt in to a runtime fetch of the latest registry state.
let registry = monolythium_core_sdk::ChainRegistry::fetch_latest().await?;
let client = ProtocoreClient::for_network_from(&registry, "testnet-69420").await?;
```

### Programmatic (TypeScript)

```typescript
import { Network, ProtocoreClient } from "@monolythium/core-sdk";

const client = await ProtocoreClient.forNetwork(Network.Testnet69420);
```

After connection the client uses the on-chain `node-registry` precompile (`0x1005`) for live peer selection — this registry is just the rendezvous point.

## Networks

| Network | Chain ID | Status | File |
|---|---|---|---|
| `testnet-69420` | 69420 | LIVE | [`chains/testnet-69420.toml`](./chains/testnet-69420.toml) |
| `mainnet` | TBD | NOT YET LIVE | reserved |

## Adding or updating a network

For now, only foundation-operated nodes are listed (`tier = "official"` or `tier = "degraded"` while an endpoint is unhealthy/resyncing). Once mainnet ships and community-run RPCs come online we'll accept PRs adding `tier = "community"` entries — see [CONTRIBUTING.md](./CONTRIBUTING.md) when it's published.

Before opening a PR, run the local validator:

```bash
npm ci                                    # installs the pinned @noble/hashes keccak256
node scripts/validate-chain-registry.mjs  # or: npm run validate
```

The validator checks every `chains/*.toml` file: native receipt proof trust
policy completeness, key lengths, thresholds, duplicate signer rows, validity
bounds, and — for any entry with a `genesis_url` pointing at committed
`chains/genesis/*.toml` content — that the genesis file exists and its
`keccak256(raw bytes) == genesis_hash` (and `sha256 == genesis_sha256` when
set). Its only dependency is the audited `@noble/hashes` keccak256, pinned via
`package-lock.json`. The same check runs in CI
(`.github/workflows/verify-registry.yml`) on every push and PR and is required
to pass before merge — a human must not be able to merge a genesis whose
content does not match the pinned hash.

## Schema

Every chain TOML file has the same shape. See [`schemas/chain.schema.md`](./schemas/chain.schema.md) for the full reference.

Mandatory top-level fields for live networks: `chain_id`, `network`, `genesis_hash`, `binary_sha`. At least one `[[rpc]]` and one `[[p2p]]` block. Reserved chain-id entries set `status = "reserved"` and intentionally omit live-network pins until launch. Explorers are optional but encouraged.

Chain files may also publish an optional `[receipt_proof_trust]`
policy. When present, it describes SDK-side trust metadata for native
receipt proof verification: archive ML-DSA signer public keys and
signature threshold, plus a finality BLS policy using either cluster or
multisig mode. Height and round validity bounds are optional.

## Dynamic genesis resolution

The registry can serve the **full** genesis content, not just the hash. Each
live network may publish `genesis_url` (the committed
`chains/genesis/<network>.genesis.toml`) and `genesis_sha256` alongside its
`genesis_hash`.

A node uses these to resolve genesis at first boot instead of running a genesis
baked into its OS image:

1. Fetch the network's registry entry (this repo, over HTTPS).
2. Fetch the full genesis from `genesis_url` (over HTTPS).
3. Recompute **keccak256 over the raw on-disk bytes** of the fetched genesis.
4. Require it to equal the entry's `genesis_hash` **before** init. On mismatch,
   fail closed.

The OS image therefore bakes **who to trust** (the registry path), not **what
to run** (no baked genesis hash). A Foundation re-genesis flips `genesis_hash`
+ `genesis_url` in this repo and is picked up on the next boot — the image
survives re-genesis with no rebuild.

### Milestones

Protocol parameters and precompile gates that activate at chosen block
**heights** without cutting a new genesis (inflation ceiling, fee splits,
delegation caps, precompile on/off gates, and the like) are carried in a
**canonical, cosigned milestone config** committed here:
[`chains/milestones/testnet-69420.milestones.toml`](./chains/milestones/testnet-69420.milestones.toml).
A live network references it from its chain file as `milestones_url` /
`milestones_sha256`, alongside `genesis_url`.

**This is the rolling-upgrade mechanism.** To change a parameter without a
re-genesis:

1. Append or edit an `[[entries]]` block with a future activation `height` and
   push to `master`.
2. CI (`.github/workflows/milestones-attestation.yml`) recomputes the file's
   sha256 and **cosigns** it (keyless OIDC `cosign sign-blob`), committing the
   `.sha256`, `.sig`, and `.pem` beside the file.
3. Operators `cosign verify-blob` the file against the workflow's certificate
   identity / OIDC issuer, deploy the new config, and **roll the fleet before
   the new activation height**.

**The config is plain, unsigned config — the chain does not verify an in-file
milestone signature.** The old on-chain signature apparatus (`[meta].signers` /
`threshold` / `signer_set_id` and the `[[signatures]]` blocks) is intentionally
dropped. Authenticity comes from two anchors instead:

- **Supply-chain anchor — the cosign blob.** The `.sig`/`.pem` beside the file,
  verified with `cosign verify-blob` before deploy. This is exactly the
  GitHub-authenticity model the registry already uses for the committed genesis
  content (`genesis_url`) and for the cosigned protocore release the operator
  binary is built from.
- **On-chain anchor — the genesis-pinned digest.** The genesis bundle pins the
  config's canonical `milestone_digest`. A node recomputes it and requires a
  match before applying any entry, so the milestones a running node enforces are
  bound to the genesis it booted.

The chain therefore trusts **the config + the genesis-pinned digest**, not an
in-file signature.

## Trust model — be honest about what the hash-match proves

**Testnet (live now).** `genesis_hash` is the authoritative pin, and the gate
is: HTTPS fetch of the registry entry + HTTPS fetch of the full genesis, with
`keccak256(raw bytes) == genesis_hash`. This is **not** cryptographic integrity
against a registry or GitHub compromise. The expected hash and the served
content come from the **same trust root** (this repo / a single GitHub write),
so the hash-match is **circular** — it only proves the content matches a number
the same writer chose. A compromised Foundation account, a malicious
maintainer, a leaked token, or a GitHub-side incident could swap the genesis
and its hash together and the check would still pass. This is acceptable
**only** because testnet is value-less and wiped without notice (see the
testnet description in `chains/testnet-69420.toml`). Do not mistake the testnet
hash-match for integrity.

**Mainnet hardening (required before mainnet — tracked groundwork).** Before
any value-bearing launch, the trust order becomes
**image-baked cert-identity > cosign-signed genesis > registry `genesis_hash`
pin > HTTPS transport**, breaking the circularity with factors the
registry-writer does not control:

- **Cosign-signed genesis.** Genesis is published as a cosign-signed asset and
  `cosign verify-blob`'d **before** the keccak check, against an **image-baked**
  cert-identity / OIDC issuer (`genesis_sig_url`, `genesis_cert_identity`,
  `genesis_cert_issuer`).
- **Commit-SHA-pinned registry.** The registry is pinned to a specific commit
  SHA baked **per image** (`registry_rev`), not the moving `master` ref, so a
  registry-account compromise or a stale/poisoned CDN edge cannot silently
  redirect `genesis_hash`.
- **Baked into the signed image.** `genesis_hash` / `registry_rev` are baked
  into the signed dm-verity-measured image, restoring "the image pins what it
  runs". Mainnet re-genesis = a new signed image (acceptable cadence); dynamic
  master-ref auto-pickup stays testnet-only.
- **Multi-origin fetch.** Genesis is fetched from more than one origin (signed
  release asset + raw URL + a Foundation mirror) so GitHub is not a
  chain-restart single point of failure.

Those mainnet-only fields (`genesis_sig_url`, `genesis_cert_identity`,
`genesis_cert_issuer`, `registry_rev`) are present today **only** as commented
placeholders in the chain files and are documented in
[`schemas/chain.schema.md`](./schemas/chain.schema.md). They are rejected as
active values until the mainnet verification path exists to enforce them.

## Trust model

This repo is **not** a substitute for cryptographic verification. The on-chain genesis hash and the binary `binary_sha` are the only authoritative pins; an RPC URL listed here can be MITM'd, censored, or rate-limited at any time. Treat the registry as a starting list, not a trust anchor.

Native receipt proof trust metadata, if present, is only input material
for SDK verification. It is not proof that archive nodes are live, that a
receipt exists, or that a chain state is final by itself. Clients must
verify the receipt proof, signatures, thresholds, key validity bounds,
and finality transcript, and must fail closed when required trust
metadata is missing, malformed, expired, or outside its configured
height/round bounds.

If a listed endpoint is misbehaving, open an issue — we'll mark it stale or remove it.

## Security

Vulnerabilities in the underlying chain or SDK go to security@monolythium.com (do not open a public issue). The registry repo itself contains no executable code; configuration disclosures (e.g. an RPC URL revealing private infrastructure) can be filed as ordinary issues.

## License

Apache-2.0. See [LICENSE](./LICENSE).
