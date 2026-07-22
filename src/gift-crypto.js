import { PrivateKey, Bytes } from '@wharfkit/antelope';

// Small, standalone slice of WharfKit's crypto — deliberately NOT the full
// @wharfkit/session bundle (no SessionKit/wallet plugins/UI needed here).
// Used by inventory.html (generate a one-off keypair when creating a gift
// link) and gift-claim.html (sign the claimer's account name with the
// one-off key from the link's URL to produce claimer_signature). The actual
// transactions that USE these values still go through the normal connected
// wallet via WaxAuth.transact() — this module never signs a transaction
// itself, only ever a standalone message.

// Exported (not window-assigned) — same convention as src/wax-auth.js;
// vite's iife lib build exposes these as window.GiftCrypto.<fn> itself.
export function generateKeyPair() {
  const priv = PrivateKey.generate('K1');
  const pub = priv.toPublic();
  return {
    privateKey: priv.toWif(),
    publicKey: pub.toString(),
    // Raw chain RPC (get_table_rows) returns public keys in the legacy
    // EOS... format, not the modern PUB_K1_... one toString() gives — found
    // live (a real, always-reproducing mismatch, not a guess) when the post-
    // creation link-ID lookup in inventory.html kept failing because it was
    // comparing the two different string encodings of the same key.
    publicKeyLegacy: pub.toLegacyString(),
  };
}

export function signMessage(wif, message) {
  // Bytes.from() without an encoding hint assumes hex — plain text (e.g. a
  // claimer's account name) needs the explicit 'utf8' encoding or it throws
  // "Expected hex string" (found live, not guessed).
  return PrivateKey.from(wif).signMessage(Bytes.from(message, 'utf8')).toString();
}
