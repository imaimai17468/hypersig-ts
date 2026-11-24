import { isJsonValue } from "./protocol.js";
import type { JsonValue } from "./protocol.js";

/** What a page token holds: everything needed to rebuild the page's top-level views. */
export interface PageClaims {
  format: 1;
  sessionId: string;
  /** Milliseconds since the UNIX epoch. */
  expiresAt: number;
  views: { name: string; params: JsonValue }[];
  /** What each leaf view showed at SSR, by key. */
  snapshots?: Record<string, PageSnapshot>;
}

/** A view's snapshot revision and the digest of the HTML rendered from it. */
export interface PageSnapshot {
  revision: string | number;
  /** From `digestHtml`. */
  digest: string;
}

export type PageTokenResult =
  | { status: "valid"; claims: PageClaims }
  /** Not sealed by any of the keys, or not a page token at all. */
  | { status: "invalid" }
  | { status: "expired" };

/** Longer tokens would approach URL length limits in browsers and proxies. */
export const maxTokenLength = 6144;

const keyLength = 32;
const ivLength = 12;
const tagLength = 16;
const tokenPattern = /^[A-Za-z0-9_-]+$/;

/**
 * Seals page claims with the first key and opens them with any key, so a key
 * can be rotated in at the front while tokens sealed with the old one stay
 * valid. Without keys, the sealer makes a random key that only this process
 * holds. Throws a `RangeError` for a key that is not 32 bytes of base64 or
 * base64url, or for an empty list.
 */
export function createPageSealer(keys: readonly string[] | undefined) {
  if (keys?.length === 0)
    throw new RangeError("Expected at least one page key");
  const secrets = keys?.map(decodeKey) ?? [
    crypto.getRandomValues(new Uint8Array(keyLength)),
  ];
  const imported = Promise.all(
    secrets.map((secret) =>
      crypto.subtle.importKey("raw", secret, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ])
    )
  );

  return {
    async seal(claims: PageClaims): Promise<string> {
      const [key] = await imported;
      if (!key) throw new Error("Expected a page key");
      const iv = crypto.getRandomValues(new Uint8Array(ivLength));
      const plaintext = new TextEncoder().encode(JSON.stringify(claims));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
      );
      const sealed = new Uint8Array(ivLength + ciphertext.length);
      sealed.set(iv);
      sealed.set(ciphertext, ivLength);
      return encodeBase64Url(sealed);
    },
    async open(token: string, now: number): Promise<PageTokenResult> {
      const plaintext = await decrypt(await imported, token);
      if (plaintext === undefined) return { status: "invalid" };
      const claims = parseClaims(plaintext);
      if (!claims) return { status: "invalid" };
      if (claims.expiresAt <= now) return { status: "expired" };
      return { status: "valid", claims };
    },
  };
}

async function decrypt(keys: readonly CryptoKey[], token: string) {
  if (token.length > maxTokenLength || !tokenPattern.test(token)) return;
  const sealed = decodeBase64(token);
  // Unused trailing bits would let several strings name one token, and one
  // connection is kept per token string.
  if (
    !sealed ||
    sealed.length < ivLength + tagLength ||
    encodeBase64Url(sealed) !== token
  )
    return;
  const iv = sealed.subarray(0, ivLength);
  const ciphertext = sealed.subarray(ivLength);
  for (const key of keys) {
    try {
      return new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)
      );
    } catch {
      // Sealed with another key, or altered. Try the next key.
    }
  }
}

function parseClaims(plaintext: string): PageClaims | undefined {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return;
  }
  return isPageClaims(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPageClaims(value: unknown): value is PageClaims {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    typeof value.sessionId !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Array.isArray(value.views)
  )
    return false;
  const views: unknown[] = value.views;
  const isView = (view: unknown) =>
    isRecord(view) && typeof view.name === "string" && isJsonValue(view.params);
  const isSnapshot = (snapshot: unknown) =>
    isRecord(snapshot) &&
    (typeof snapshot.revision === "string" ||
      typeof snapshot.revision === "number") &&
    typeof snapshot.digest === "string";
  return (
    views.every(isView) &&
    (value.snapshots === undefined ||
      (isRecord(value.snapshots) &&
        Object.values(value.snapshots).every(isSnapshot)))
  );
}

/** The SHA-256 of HTML in base64url, to compare HTML without keeping it. */
export async function digestHtml(html: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(html)
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function decodeKey(key: string) {
  const secret = decodeBase64(key);
  if (secret?.length !== keyLength)
    throw new RangeError("Expected a page key of 32 bytes in base64");
  return secret;
}

/** Decodes base64 or base64url, with or without padding. */
function decodeBase64(text: string) {
  const standard = text.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  } catch {
    return;
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
