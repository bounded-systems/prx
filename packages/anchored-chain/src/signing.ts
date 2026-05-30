// Phase 1 of the in-toto alignment plan — a dev/offline DSSE signer.
//
// ed25519 over the DSSE pre-authentication encoding, using only `node:crypto`
// so it stays inside the extractable core (the module import allowlist). This
// is the reference `Signer`/`Verifier` implementation and the one tests +
// offline runs use. The Sigstore keyless signer (Fulcio/Rekor, needs network +
// OIDC) is a drop-in `Signer` that lives OUTSIDE this module; see
// docs/anchored-chain/in-toto-alignment-plan.md.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

import type { Signer, Verifier } from './in-toto.ts';

export interface Ed25519Keypair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** sha256 hex over the SPKI DER of the public key. */
  readonly keyid: string;
}

export function ed25519Keyid(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export function generateEd25519Keypair(): Ed25519Keypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, keyid: ed25519Keyid(publicKey) };
}

/** A `Signer` that signs the DSSE PAE with an ed25519 private key. */
export function ed25519Signer(privateKey: KeyObject, keyid: string): Signer {
  return {
    async sign(pae: Uint8Array) {
      const signature = cryptoSign(null, Buffer.from(pae), privateKey);
      return { sig: signature.toString('base64'), keyid };
    },
  };
}

/** A `Verifier` trusting a single ed25519 public key. Verification is
 *  intrinsic to the signature over the PAE — no external table is consulted,
 *  preserving the "authority lives in artifacts" property. */
export function ed25519Verifier(publicKey: KeyObject): Verifier {
  return {
    async verify(pae: Uint8Array, sig) {
      try {
        return cryptoVerify(
          null,
          Buffer.from(pae),
          publicKey,
          Buffer.from(sig.sig, 'base64'),
        );
      } catch {
        return false;
      }
    },
  };
}

// --- Stable-key import (GH-2249) ---------------------------------------------
//
// Cross-process enforcement (`requireSigned`) needs a key that survives between
// the signing run and the verifying run, so a surface must be able to import key
// material from its environment into a `KeyObject`. Importing stays in the core
// (it's pure `node:crypto`, no env reads); the *choice* of material is the
// machine-side concern of `resolveProvenanceSigner` / `resolveProvenanceVerifier`.
//
// Two encodings are accepted, distinguished by decoded length:
//   - a raw 32-byte ed25519 seed (private) or point (public), DER-wrapped here;
//   - full PKCS8 (private) / SPKI (public) DER, passed through to `node:crypto`.
// Both are base64-encoded strings. The raw form is the natural one to mint and
// carry in an env var; the DER form lets a caller paste an existing key.

/** Bytes of a raw (unwrapped) ed25519 seed or public point. */
const RAW_ED25519_KEY_LEN = 32;

/** PKCS8 DER prefix for an ed25519 private key (precedes the 32-byte seed). */
const ED25519_PKCS8_DER_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

/** SPKI DER prefix for an ed25519 public key (precedes the 32-byte point). */
const ED25519_SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Import an ed25519 private key from base64 material: either a raw 32-byte seed
 * (DER-wrapped here) or full PKCS8 DER. Pure `node:crypto`; no env reads.
 */
export function importEd25519PrivateKey(material: string): KeyObject {
  const bytes = Buffer.from(material, 'base64');
  const der =
    bytes.length === RAW_ED25519_KEY_LEN
      ? Buffer.concat([ED25519_PKCS8_DER_PREFIX, bytes])
      : bytes;
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * Import an ed25519 public key from base64 material: either a raw 32-byte point
 * (DER-wrapped here) or full SPKI DER. Pure `node:crypto`; no env reads.
 */
export function importEd25519PublicKey(material: string): KeyObject {
  const bytes = Buffer.from(material, 'base64');
  const der =
    bytes.length === RAW_ED25519_KEY_LEN
      ? Buffer.concat([ED25519_SPKI_DER_PREFIX, bytes])
      : bytes;
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}
