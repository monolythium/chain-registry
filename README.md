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

For now, only foundation-operated nodes are listed (`tier = "official"`). Once mainnet ships and community-run RPCs come online we'll accept PRs adding `tier = "community"` entries — see [CONTRIBUTING.md](./CONTRIBUTING.md) when it's published.

## Schema

Every chain TOML file has the same shape. See [`schemas/chain.schema.md`](./schemas/chain.schema.md) for the full reference.

Mandatory top-level fields: `chain_id`, `network`, `genesis_hash`, `binary_sha`. At least one `[[rpc]]` and one `[[p2p]]` block. Explorers are optional but encouraged.

Chain files may also publish an optional `[receipt_proof_trust]`
policy. When present, it describes SDK-side trust metadata for native
receipt proof verification: archive ML-DSA signer public keys and
signature threshold, plus a finality BLS policy using either cluster or
multisig mode. Height and round validity bounds are optional.

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
