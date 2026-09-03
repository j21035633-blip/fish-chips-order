import { createSign, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Request signing for Revenue Monster's Open API v3.
 *
 * RM authenticates each call twice: an OAuth2 bearer token *and* an RSA
 * signature over a canonical representation of the request. The canonical form
 * is what makes this fiddly — both sides must derive byte-identical plaintext,
 * so key ordering and separators are load-bearing.
 *
 * The documented scheme:
 *   1. `data` = base64 of the compact, deep-key-sorted JSON body (omitted for
 *      bodyless requests such as GET).
 *   2. plaintext = `data=<data>&method=<lowercase verb>&nonceStr=<nonce>` +
 *      `&requestUrl=<absolute url>&signType=sha256&timestamp=<unix seconds>`
 *      — the fields in that exact alphabetical order, `data` dropped entirely
 *      when there is no body.
 *   3. signature = base64(RSA-SHA256(plaintext, privateKey)).
 *   4. Sent as `X-Signature: sha256 <signature>`, alongside `X-Nonce-Str` and
 *      `X-Timestamp`, which must match the values signed.
 *
 * NOTE: implemented from RM's published signing description and verified here
 * against a locally generated keypair — the mechanics (canonicalisation,
 * plaintext assembly, RSA-SHA256, base64) are tested. It has not been checked
 * against a live RM sandbox, so if RM rejects a signature the thing to compare
 * first is `buildSignaturePlaintext` output against their debugger.
 */

export interface SignatureInput {
  method: string;
  /** Absolute URL, exactly as requested. */
  requestUrl: string;
  /** Parsed body, or undefined for a bodyless request. */
  body?: unknown;
  nonceStr: string;
  /** Unix seconds, as a string. */
  timestamp: string;
}

export interface SignedHeaders {
  "x-signature": string;
  "x-nonce-str": string;
  "x-timestamp": string;
}

/**
 * Deep key-sorted, compact JSON.
 *
 * Object keys sort alphabetically at every depth; array order is preserved
 * because it is meaningful. `undefined` members are dropped the way
 * `JSON.stringify` drops them, so the signed bytes match the sent bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    sorted[key] = sortDeep(source[key]);
  }
  return sorted;
}

/** The exact bytes that get signed. Kept separate so it can be diffed against RM's debugger. */
export function buildSignaturePlaintext(input: SignatureInput): string {
  const parts: string[] = [];

  if (input.body !== undefined) {
    parts.push(`data=${Buffer.from(canonicalJson(input.body), "utf8").toString("base64")}`);
  }

  parts.push(
    `method=${input.method.toLowerCase()}`,
    `nonceStr=${input.nonceStr}`,
    `requestUrl=${input.requestUrl}`,
    "signType=sha256",
    `timestamp=${input.timestamp}`,
  );

  return parts.join("&");
}

/** Signs and returns the three headers RM expects. */
export function signRequest(privateKeyPem: string, input: SignatureInput): SignedHeaders {
  const plaintext = buildSignaturePlaintext(input);
  const signature = createSign("RSA-SHA256").update(plaintext, "utf8").sign(privateKeyPem, "base64");

  return {
    "x-signature": `sha256 ${signature}`,
    "x-nonce-str": input.nonceStr,
    "x-timestamp": input.timestamp,
  };
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function nowTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

/**
 * Reads the PEM private key, cached by path.
 *
 * Cached because signing happens per request and the key never changes while
 * the process lives. A missing or unreadable key is a configuration error and
 * is thrown as one rather than silently skipping the signature.
 */
const keyCache = new Map<string, string>();

export function loadPrivateKey(path: string): string {
  const cached = keyCache.get(path);
  if (cached !== undefined) return cached;

  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read REVENUE_MONSTER_PRIVATE_KEY_PATH ("${path}"): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!pem.includes("PRIVATE KEY")) {
    throw new Error(`"${path}" does not look like a PEM private key.`);
  }

  keyCache.set(path, pem);
  return pem;
}

/** Test seam — the key is cached for the process lifetime otherwise. */
export function clearPrivateKeyCache(): void {
  keyCache.clear();
}
