#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";

const U64_MAX = (1n << 64n) - 1n;
const ML_DSA_65_PUBLIC_KEY_BYTES = 1952;
const BLS_PUBLIC_KEY_BYTES = 48;
const HASH_BYTES = 32;
const SIGNER_ID_BYTES = 20;
const RPC_TIERS = new Set(["official", "degraded", "community"]);

const ROOT_KEYS = new Set([
  "chain_id",
  "network",
  "genesis_hash",
  "genesis_url",
  "genesis_sha256",
  "binary_sha",
  "release_tag",
  "binary_release_sha256",
  "release_tarball_sha256",
  "display_name",
  "description",
  "created",
  "status",
]);
const RPC_KEYS = new Set(["url", "provider", "region", "tier", "archive", "ws_url", "notes"]);
const P2P_KEYS = new Set(["multiaddr", "region"]);
const EXPLORER_KEYS = new Set(["url", "name", "kind"]);
const ARCHIVE_KEYS = new Set(["signature_threshold", "valid_from_height", "valid_to_height"]);
const ARCHIVE_SIGNER_KEYS = new Set([
  "public_key",
  "signer_id",
  "valid_from_height",
  "valid_to_height",
  "notes",
]);
const FINALITY_KEYS = new Set([
  "mode",
  "chain_id",
  "threshold",
  "committee_size",
  "cluster_public_key",
  "valid_from_round",
  "valid_to_round",
]);
const FINALITY_SIGNER_KEYS = new Set([
  "authority_index",
  "public_key",
  "valid_from_round",
  "valid_to_round",
  "notes",
]);
const RESERVED_ROOT_KEYS = new Set([
  "cluster_id",
  "cluster_name",
  "bridge_assets",
  "bridges",
  // MAINNET-ONLY genesis hardening groundwork — documented as commented
  // placeholders only (see chains/*.toml and README "Dynamic genesis
  // resolution"). The mainnet trust model + signed-genesis pipeline are not
  // implemented yet, so setting an ACTIVE value here today is a hard
  // rejection until the verification path exists to enforce it.
  "genesis_sig_url",
  "genesis_cert_identity",
  "genesis_cert_issuer",
  "registry_rev",
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/validate-chain-registry.mjs [--self-test]");
    return;
  }
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const chainsDir = path.join(repoRoot, "chains");
  const files = readdirSync(chainsDir)
    .filter((file) => file.endsWith(".toml"))
    .sort();
  const errors = [];
  for (const file of files) {
    const fullPath = path.join(chainsDir, file);
    const parsed = parseChainToml(readFileSync(fullPath, "utf8"), file);
    errors.push(...parsed.errors);
    if (parsed.errors.length === 0) {
      errors.push(...validateChainInfo(parsed.info, file));
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${files.length} chain file${files.length === 1 ? "" : "s"}.`);
}

function runSelfTest() {
  const valid = parseChainToml(`
chain_id = 1
network = "selftest"
genesis_hash = "0x${"11".repeat(32)}"
binary_sha = "abcdef1"
release_tag = "v0.1.0-testnet"
binary_release_sha256 = "abababababababababababababababababababababababababababababababab"

[[rpc]]
url = "https://rpc.example"
provider = "self"
tier = "official"

[[p2p]]
multiaddr = "/ip4/127.0.0.1/tcp/29898/p2p/12D3KooWSelfTest"
`, "selftest.toml");
  const validErrors = valid.errors.concat(validateChainInfo(valid.info, "selftest.toml"));
  assertSelfTest(validErrors.length === 0, `valid fixture failed: ${validErrors.join("; ")}`);

  const invalid = parseChainToml(`
chain_id = 1
network = "selftest"
genesis_hash = "0x${"11".repeat(32)}"
binary_sha = "abcdef1"
release_tag = "v0.1.0-testnet"
binary_release_sha256 = "abababababababababababababababababababababababababababababababab"

[[rpc]]
url = "https://rpc.example"
provider = "self"
tier = "official"

[[p2p]]
multiaddr = "/ip4/127.0.0.1/tcp/29898/p2p/12D3KooWSelfTest"

[receipt_proof_trust.archive]
signature_threshold = 2

[[receipt_proof_trust.archive.signers]]
public_key = "0x${"11".repeat(ML_DSA_65_PUBLIC_KEY_BYTES)}"

[receipt_proof_trust.finality]
mode = "cluster"
threshold = 5
committee_size = 7
cluster_public_key = "0x12"
`, "selftest.toml");
  const invalidErrors = invalid.errors.concat(validateChainInfo(invalid.info, "selftest.toml"));
  assertSelfTest(
    invalidErrors.some((error) => error.includes("archive.signature_threshold exceeds signer count")) &&
      invalidErrors.some((error) => error.includes("finality.cluster_public_key must be 48 bytes")),
    `invalid fixture did not fail as expected: ${invalidErrors.join("; ")}`,
  );

  runGenesisResolutionSelfTest();
  console.log("Self-test passed.");
}

// Exercises the dynamic-genesis security gate against the real committed
// genesis content (chains/genesis/testnet-69420.genesis.toml). Both checks are
// derived from the on-disk bytes, so this stays correct across any future
// re-genesis (a wrong genesis_hash/genesis_sha256 still fails).
function runGenesisResolutionSelfTest() {
  const localRel = "chains/genesis/testnet-69420.genesis.toml";
  const fullPath = path.join(repoRoot, localRel);
  if (!existsSync(fullPath)) {
    console.error(`genesis self-test skipped: ${localRel} is missing`);
    process.exit(1);
  }
  const bytes = readFileSync(fullPath);
  const realHash = "0x" + Buffer.from(keccak_256(bytes)).toString("hex");
  const realSha = createHash("sha256").update(bytes).digest("hex");
  const url = `https://raw.githubusercontent.com/monolythium/chain-registry/master/${localRel}`;

  const okErrors = [];
  validateGenesisResolution(
    { genesis_url: url, genesis_sha256: realSha, genesis_hash: realHash },
    "genesis-selftest-ok.toml",
    okErrors,
  );
  assertSelfTest(okErrors.length === 0, `genesis-resolution valid case failed: ${okErrors.join("; ")}`);

  const badHash = "0x" + "00".repeat(HASH_BYTES);
  const badHashErrors = [];
  validateGenesisResolution(
    { genesis_url: url, genesis_sha256: realSha, genesis_hash: badHash },
    "genesis-selftest-badhash.toml",
    badHashErrors,
  );
  assertSelfTest(
    badHashErrors.some((error) => error.includes("does not match genesis_hash")),
    `genesis-resolution mismatched keccak did not fail as expected: ${badHashErrors.join("; ")}`,
  );

  const badShaErrors = [];
  validateGenesisResolution(
    { genesis_url: url, genesis_sha256: "0".repeat(64), genesis_hash: realHash },
    "genesis-selftest-badsha.toml",
    badShaErrors,
  );
  assertSelfTest(
    badShaErrors.some((error) => error.includes("genesis_sha256 mismatch")),
    `genesis-resolution mismatched sha256 did not fail as expected: ${badShaErrors.join("; ")}`,
  );

  const missingFileErrors = [];
  validateGenesisResolution(
    {
      genesis_url: "https://raw.githubusercontent.com/monolythium/chain-registry/master/chains/genesis/does-not-exist.toml",
      genesis_hash: realHash,
    },
    "genesis-selftest-missing.toml",
    missingFileErrors,
  );
  assertSelfTest(
    missingFileErrors.some((error) => error.includes("does not exist in this repo")),
    `genesis-resolution missing-file case did not fail as expected: ${missingFileErrors.join("; ")}`,
  );
}

function assertSelfTest(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

function parseChainToml(input, file) {
  const info = { rpc: [], p2p: [], explorer: [] };
  const errors = [];
  let section = "root";

  input.split(/\r?\n/u).forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) return;

    const arrayTable = /^\[\[([A-Za-z0-9_.-]+)\]\]$/u.exec(line);
    if (arrayTable) {
      section = arrayTable[1];
      if (section === "rpc") info.rpc.push({});
      else if (section === "p2p") info.p2p.push({});
      else if (section === "explorer") info.explorer.push({});
      else if (section === "receipt_proof_trust.archive.signers") {
        ensureTrust(info).archive ??= { signers: [] };
        ensureTrust(info).archive.signers ??= [];
        ensureTrust(info).archive.signers.push({});
      } else if (section === "receipt_proof_trust.finality.signers") {
        ensureTrust(info).finality ??= { signers: [] };
        ensureTrust(info).finality.signers ??= [];
        ensureTrust(info).finality.signers.push({});
      } else {
        errors.push(`${file}:${lineNo}: unknown array table [[${section}]]`);
      }
      return;
    }

    const table = /^\[([A-Za-z0-9_.-]+)\]$/u.exec(line);
    if (table) {
      section = table[1];
      if (section === "receipt_proof_trust") {
        ensureTrust(info);
      } else if (section === "receipt_proof_trust.archive") {
        ensureTrust(info).archive ??= { signers: [] };
      } else if (section === "receipt_proof_trust.finality") {
        ensureTrust(info).finality ??= { signers: [] };
      } else {
        errors.push(`${file}:${lineNo}: unknown table [${section}]`);
      }
      return;
    }

    const assignment = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/u.exec(line);
    if (!assignment) {
      errors.push(`${file}:${lineNo}: expected key = value`);
      return;
    }
    const [, key, rawValue] = assignment;
    const parsed = parseTomlScalar(rawValue);
    if (parsed.error) {
      errors.push(`${file}:${lineNo}: ${parsed.error}`);
      return;
    }
    const target = targetForSection(info, section, file, lineNo, errors);
    if (!target) return;
    const allowed = allowedKeysForSection(section);
    if (!allowed?.has(key)) {
      errors.push(`${file}:${lineNo}: key ${key} is not allowed in ${section}`);
      return;
    }
    target[key] = parsed.value;
  });

  return { info, errors };
}

function stripTomlComment(line) {
  let inString = false;
  let escaped = false;
  let out = "";
  for (const char of line) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      out += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      out += char;
      continue;
    }
    if (char === "#" && !inString) break;
    out += char;
  }
  return out;
}

function parseTomlScalar(raw) {
  const value = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/u.test(value)) {
    return { value: value.slice(1, -1).replace(/\\"/gu, "\"").replace(/\\\\/gu, "\\") };
  }
  if (value === "true") return { value: true };
  if (value === "false") return { value: false };
  if (/^[0-9]+$/u.test(value)) return { value: BigInt(value) };
  return { error: `unsupported TOML scalar ${value}` };
}

function ensureTrust(info) {
  info.receipt_proof_trust ??= {};
  return info.receipt_proof_trust;
}

function targetForSection(info, section, file, lineNo, errors) {
  if (section === "root") return info;
  if (section === "rpc" || section === "p2p" || section === "explorer") {
    const list = info[section];
    if (list.length === 0) {
      errors.push(`${file}:${lineNo}: key appears before [[${section}]]`);
      return null;
    }
    return list[list.length - 1];
  }
  if (section === "receipt_proof_trust") return ensureTrust(info);
  if (section === "receipt_proof_trust.archive") {
    return (ensureTrust(info).archive ??= { signers: [] });
  }
  if (section === "receipt_proof_trust.archive.signers") {
    const archive = ensureTrust(info).archive ??= { signers: [] };
    if (!archive.signers || archive.signers.length === 0) {
      errors.push(`${file}:${lineNo}: key appears before [[receipt_proof_trust.archive.signers]]`);
      return null;
    }
    return archive.signers[archive.signers.length - 1];
  }
  if (section === "receipt_proof_trust.finality") {
    return (ensureTrust(info).finality ??= { signers: [] });
  }
  if (section === "receipt_proof_trust.finality.signers") {
    const finality = ensureTrust(info).finality ??= { signers: [] };
    if (!finality.signers || finality.signers.length === 0) {
      errors.push(`${file}:${lineNo}: key appears before [[receipt_proof_trust.finality.signers]]`);
      return null;
    }
    return finality.signers[finality.signers.length - 1];
  }
  errors.push(`${file}:${lineNo}: unknown section ${section}`);
  return null;
}

function allowedKeysForSection(section) {
  if (section === "root") return ROOT_KEYS;
  if (section === "rpc") return RPC_KEYS;
  if (section === "p2p") return P2P_KEYS;
  if (section === "explorer") return EXPLORER_KEYS;
  if (section === "receipt_proof_trust") return new Set();
  if (section === "receipt_proof_trust.archive") return ARCHIVE_KEYS;
  if (section === "receipt_proof_trust.archive.signers") return ARCHIVE_SIGNER_KEYS;
  if (section === "receipt_proof_trust.finality") return FINALITY_KEYS;
  if (section === "receipt_proof_trust.finality.signers") return FINALITY_SIGNER_KEYS;
  return null;
}

function validateChainInfo(info, file) {
  const errors = [];
  const network = file.replace(/\.toml$/u, "");
  for (const key of Object.keys(info)) {
    if (RESERVED_ROOT_KEYS.has(key)) errors.push(`${file}: reserved root key ${key} is not allowed`);
  }
  requireU64(info.chain_id, `${file}: chain_id`, errors);
  requireString(info.network, `${file}: network`, errors);
  if (typeof info.network === "string" && info.network !== network) {
    errors.push(`${file}: network must match filename ${network}`);
  }
  if (typeof info.network === "string" && !/^[a-z0-9-]{3,32}$/u.test(info.network)) {
    errors.push(`${file}: network must be 3-32 lowercase ASCII letters/digits/hyphens`);
  }
  if (info.status !== undefined && info.status !== "reserved") {
    errors.push(`${file}: status must be reserved when present`);
  }
  const reserved = info.status === "reserved";
  if (!reserved) {
    requireHexBytes(info.genesis_hash, HASH_BYTES, `${file}: genesis_hash`, errors);
    if (typeof info.binary_sha !== "string" || !/^[0-9a-f]{7,40}$/u.test(info.binary_sha)) {
      errors.push(`${file}: binary_sha must be a 7-40 character lowercase git SHA`);
    }
    // First-class binary provenance for the Monarch OS release-drift guard.
    // release_tag: the signed protocore release the fleet runs (vX.Y.Z-channel).
    // binary_release_sha256: sha256 of the EXTRACTED protocore binary from that
    // release (NOT the mono-core commit). Both required so a release artifact
    // can be byte-checked against the registry and never silently drift.
    if (typeof info.release_tag !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+-[a-z]+$/u.test(info.release_tag)) {
      errors.push(`${file}: release_tag must be a protocore release tag (vX.Y.Z-channel)`);
    }
    if (typeof info.binary_release_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(info.binary_release_sha256)) {
      errors.push(`${file}: binary_release_sha256 must be a 64-char lowercase sha256`);
    }
    if (
      info.release_tarball_sha256 !== undefined &&
      (typeof info.release_tarball_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(info.release_tarball_sha256))
    ) {
      errors.push(`${file}: release_tarball_sha256 must be a 64-char lowercase sha256 when present`);
    }
    if (info.rpc.length === 0) errors.push(`${file}: at least one [[rpc]] entry is required`);
    if (info.p2p.length === 0) errors.push(`${file}: at least one [[p2p]] entry is required`);
  }
  validateGenesisResolution(info, file, errors);
  info.rpc.forEach((rpc, index) => validateRpc(rpc, `${file}: rpc[${index}]`, errors));
  info.p2p.forEach((p2p, index) => validateP2p(p2p, `${file}: p2p[${index}]`, errors));
  info.explorer.forEach((explorer, index) => validateExplorer(explorer, `${file}: explorer[${index}]`, errors));
  if (info.receipt_proof_trust) {
    validateReceiptProofTrust(info.receipt_proof_trust, `${file}: receipt_proof_trust`, errors);
  }
  return errors;
}

// Security gate for dynamic genesis resolution.
//
// A node bakes WHO to trust (this registry path) rather than WHAT to run, then
// fetches the full genesis from genesis_url and requires
// keccak256(raw on-disk bytes) == genesis_hash BEFORE init. This validator
// enforces the same invariant at PR/push time for any genesis content
// committed to this repo, so a human cannot merge a registry entry whose
// pinned genesis_hash (and optional genesis_sha256) does not match the bytes
// actually served from chains/genesis/. The keccak primitive here MUST match
// the node's: standard keccak256 over the RAW file bytes (not a reserialized
// or UTF-8-text variant), via the audited @noble/hashes implementation.
function validateGenesisResolution(info, file, errors) {
  const hasUrl = info.genesis_url !== undefined;
  const hasSha = info.genesis_sha256 !== undefined;

  if (hasSha) {
    if (typeof info.genesis_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(info.genesis_sha256)) {
      errors.push(`${file}: genesis_sha256 must be a 64-character lowercase hex string (no 0x prefix)`);
    }
  }

  if (!hasUrl) {
    // genesis_url is optional; genesis_sha256 alone is not meaningful.
    if (hasSha) {
      errors.push(`${file}: genesis_sha256 is set but genesis_url is missing`);
    }
    return;
  }

  if (typeof info.genesis_url !== "string") {
    errors.push(`${file}: genesis_url must be a string`);
    return;
  }
  let url;
  try {
    url = new URL(info.genesis_url);
  } catch {
    errors.push(`${file}: genesis_url must be a valid URL`);
    return;
  }
  if (url.protocol !== "https:") {
    errors.push(`${file}: genesis_url must use https`);
    return;
  }

  // Map the canonical raw.githubusercontent.com URL for THIS repo back to a
  // local path so the committed content can be verified offline in CI. Only a
  // genesis_url that points at chains/genesis/*.toml in this registry is
  // checked against on-disk bytes; any other host is left to a network-time
  // check (out of scope for the offline validator).
  const localRel = localGenesisPath(url);
  if (!localRel) {
    return;
  }
  if (!/^chains\/genesis\/[A-Za-z0-9._-]+\.toml$/u.test(localRel)) {
    errors.push(`${file}: genesis_url must reference chains/genesis/*.toml, got ${localRel}`);
    return;
  }

  const fullPath = path.join(repoRoot, localRel);
  if (!existsSync(fullPath)) {
    errors.push(`${file}: genesis_url references ${localRel} which does not exist in this repo`);
    return;
  }

  const bytes = readFileSync(fullPath);

  if (hasSha) {
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== info.genesis_sha256) {
      errors.push(
        `${file}: genesis_sha256 mismatch for ${localRel}: declared ${info.genesis_sha256}, computed ${sha}`,
      );
    }
  }

  if (typeof info.genesis_hash === "string" && /^0x[0-9a-fA-F]{64}$/u.test(info.genesis_hash)) {
    const computed = "0x" + Buffer.from(keccak_256(bytes)).toString("hex");
    if (computed.toLowerCase() !== info.genesis_hash.toLowerCase()) {
      errors.push(
        `${file}: keccak256 of ${localRel} does not match genesis_hash: ` +
          `declared ${info.genesis_hash}, computed ${computed}`,
      );
    }
  } else {
    errors.push(`${file}: genesis_url is set but genesis_hash is missing or malformed`);
  }
}

// Returns the repo-relative path encoded by a raw.githubusercontent.com URL for
// the monolythium/chain-registry repo, or null if the URL is not such a URL.
// Form: https://raw.githubusercontent.com/monolythium/chain-registry/<ref>/<path>
function localGenesisPath(url) {
  if (url.hostname !== "raw.githubusercontent.com") return null;
  const parts = url.pathname.replace(/^\/+/u, "").split("/");
  // [org, repo, ref, ...path]
  if (parts.length < 4) return null;
  const [org, repo] = parts;
  if (org !== "monolythium" || repo !== "chain-registry") return null;
  return parts.slice(3).join("/");
}

function validateRpc(rpc, label, errors) {
  if (typeof rpc.url !== "string") errors.push(`${label}.url is required`);
  else {
    try {
      const url = new URL(rpc.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.push(`${label}.url must use http or https`);
      }
    } catch {
      errors.push(`${label}.url must be a valid URL`);
    }
  }
  requireString(rpc.provider, `${label}.provider`, errors);
  if (!RPC_TIERS.has(rpc.tier)) {
    errors.push(`${label}.tier must be official, degraded, or community`);
  }
  if (rpc.archive !== undefined && typeof rpc.archive !== "boolean") {
    errors.push(`${label}.archive must be boolean when present`);
  }
}

function validateP2p(p2p, label, errors) {
  if (typeof p2p.multiaddr !== "string" || !p2p.multiaddr.startsWith("/") || !p2p.multiaddr.includes("/p2p/")) {
    errors.push(`${label}.multiaddr must be a libp2p multiaddr containing /p2p/`);
  }
}

function validateExplorer(explorer, label, errors) {
  requireString(explorer.url, `${label}.url`, errors);
  requireString(explorer.name, `${label}.name`, errors);
  if (explorer.kind !== undefined && !["monoscan", "etherscan-fork", "custom"].includes(explorer.kind)) {
    errors.push(`${label}.kind must be monoscan, etherscan-fork, or custom`);
  }
}

function validateReceiptProofTrust(trust, label, errors) {
  if (!trust.archive || !trust.finality) {
    errors.push(`${label} must include both archive and finality policies`);
    return;
  }
  validateArchiveTrust(trust.archive, `${label}.archive`, errors);
  validateFinalityTrust(trust.finality, `${label}.finality`, errors);
}

function validateArchiveTrust(archive, label, errors) {
  const threshold = requirePositiveU32(archive.signature_threshold, `${label}.signature_threshold`, errors);
  validateBounds(archive.valid_from_height, archive.valid_to_height, `${label}.height`, errors);
  if (!Array.isArray(archive.signers) || archive.signers.length === 0) {
    errors.push(`${label}.signers must contain at least one signer`);
    return;
  }
  if (threshold !== null && threshold > archive.signers.length) {
    errors.push(`${label}.signature_threshold exceeds signer count`);
  }
  const publicKeys = new Set();
  const signerIds = new Set();
  archive.signers.forEach((signer, index) => {
    const signerLabel = `${label}.signers[${index}]`;
    requireHexBytes(signer.public_key, ML_DSA_65_PUBLIC_KEY_BYTES, `${signerLabel}.public_key`, errors);
    addUniqueHex(publicKeys, signer.public_key, `${signerLabel}.public_key`, errors);
    if (signer.signer_id !== undefined) {
      requireHexBytes(signer.signer_id, SIGNER_ID_BYTES, `${signerLabel}.signer_id`, errors);
      addUniqueHex(signerIds, signer.signer_id, `${signerLabel}.signer_id`, errors);
    }
    validateBounds(signer.valid_from_height, signer.valid_to_height, `${signerLabel}.height`, errors);
  });
}

function validateFinalityTrust(finality, label, errors) {
  if (finality.mode !== "cluster" && finality.mode !== "multisig") {
    errors.push(`${label}.mode must be cluster or multisig`);
    return;
  }
  const threshold = requirePositiveU32(finality.threshold, `${label}.threshold`, errors);
  if (finality.chain_id !== undefined) requireU64(finality.chain_id, `${label}.chain_id`, errors);
  validateBounds(finality.valid_from_round, finality.valid_to_round, `${label}.round`, errors);

  if (finality.mode === "cluster") {
    const committeeSize = requirePositiveU32(finality.committee_size, `${label}.committee_size`, errors);
    requireHexBytes(finality.cluster_public_key, BLS_PUBLIC_KEY_BYTES, `${label}.cluster_public_key`, errors);
    if (Array.isArray(finality.signers) && finality.signers.length > 0) {
      errors.push(`${label}.signers must be absent in cluster mode`);
    }
    if (threshold !== null && committeeSize !== null && threshold > committeeSize) {
      errors.push(`${label}.threshold exceeds committee_size`);
    }
    return;
  }

  if (finality.committee_size !== undefined) errors.push(`${label}.committee_size must be absent in multisig mode`);
  if (finality.cluster_public_key !== undefined) errors.push(`${label}.cluster_public_key must be absent in multisig mode`);
  if (!Array.isArray(finality.signers) || finality.signers.length === 0) {
    errors.push(`${label}.signers must contain at least one signer in multisig mode`);
    return;
  }
  if (threshold !== null && threshold > finality.signers.length) {
    errors.push(`${label}.threshold exceeds signer count`);
  }
  const authorityIndexes = new Set();
  const publicKeys = new Set();
  finality.signers.forEach((signer, index) => {
    const signerLabel = `${label}.signers[${index}]`;
    const authorityIndex = requireU32(signer.authority_index, `${signerLabel}.authority_index`, errors);
    if (authorityIndex !== null) addUniqueValue(authorityIndexes, authorityIndex.toString(), `${signerLabel}.authority_index`, errors);
    requireHexBytes(signer.public_key, BLS_PUBLIC_KEY_BYTES, `${signerLabel}.public_key`, errors);
    addUniqueHex(publicKeys, signer.public_key, `${signerLabel}.public_key`, errors);
    validateBounds(signer.valid_from_round, signer.valid_to_round, `${signerLabel}.round`, errors);
  });
}

function validateBounds(from, to, label, errors) {
  const parsedFrom = from === undefined ? null : requireU64(from, `${label}.valid_from`, errors);
  const parsedTo = to === undefined ? null : requireU64(to, `${label}.valid_to`, errors);
  if (parsedFrom !== null && parsedTo !== null && parsedTo < parsedFrom) {
    errors.push(`${label}.valid_to must be >= valid_from`);
  }
}

function requireString(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) errors.push(`${label} is required`);
}

function requirePositiveU32(value, label, errors) {
  const parsed = requireU32(value, label, errors);
  if (parsed !== null && parsed < 1n) {
    errors.push(`${label} must be at least 1`);
    return null;
  }
  return parsed === null ? null : Number(parsed);
}

function requireU32(value, label, errors) {
  const parsed = requireU64(value, label, errors);
  if (parsed !== null && parsed > 0xffff_ffffn) {
    errors.push(`${label} must fit u32`);
    return null;
  }
  return parsed;
}

function requireU64(value, label, errors) {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    errors.push(`${label} must be a u64 integer`);
    return null;
  }
  return value;
}

function requireHexBytes(value, byteLength, label, errors) {
  if (typeof value !== "string" || !hexBytesPattern(byteLength).test(value)) {
    errors.push(`${label} must be ${byteLength} bytes`);
    return false;
  }
  return true;
}

function hexBytesPattern(byteLength) {
  return new RegExp(`^0x[0-9a-fA-F]{${byteLength * 2}}$`, "u");
}

function addUniqueHex(seen, value, label, errors) {
  if (typeof value !== "string") return;
  addUniqueValue(seen, value.toLowerCase(), label, errors);
}

function addUniqueValue(seen, value, label, errors) {
  if (seen.has(value)) errors.push(`${label} must be unique`);
  seen.add(value);
}

main();
