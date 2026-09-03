import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RevenueMonsterConfig } from "../src/config/env.js";
import { menuService } from "../src/menu/service.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import type { Order } from "../src/orders/types.js";
import { RevenueMonsterAdapter } from "../src/payments/revenueMonsterAdapter.js";
import {
  buildSignaturePlaintext,
  canonicalJson,
  clearPrivateKeyCache,
  loadPrivateKey,
  newNonce,
  signRequest,
} from "../src/payments/revenueMonsterSigning.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const keyDir = mkdtempSync(join(tmpdir(), "rm-signing-"));
const keyPath = join(keyDir, "private.pem");
writeFileSync(keyPath, privateKey, "utf8");

/** Confirms a signature really was produced by the matching private key. */
function verify(plaintext: string, signatureHeader: string): boolean {
  const signature = signatureHeader.replace(/^sha256 /, "");
  return createVerify("RSA-SHA256").update(plaintext, "utf8").verify(publicKey, signature, "base64");
}

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("is stable regardless of how the object was built", () => {
    const one = { storeId: "s", order: { amount: 100, currencyType: "MYR" } };
    const two = { order: { currencyType: "MYR", amount: 100 }, storeId: "s" };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it("preserves array order, since it is meaningful", () => {
    expect(canonicalJson({ items: [3, 1, 2] })).toBe('{"items":[3,1,2]}');
  });

  it("sorts keys inside array elements", () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("drops undefined members so signed bytes match sent bytes", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(JSON.stringify({ a: 1 }));
  });

  it("handles null and nested emptiness", () => {
    expect(canonicalJson({ a: null, b: {}, c: [] })).toBe('{"a":null,"b":{},"c":[]}');
  });
});

describe("buildSignaturePlaintext", () => {
  const base = {
    method: "POST",
    requestUrl: "https://rm.test/v3/payment/online",
    nonceStr: "abc123",
    timestamp: "1700000000",
  };

  it("assembles the documented field order with a base64 data segment", () => {
    const plaintext = buildSignaturePlaintext({ ...base, body: { b: 1, a: 2 } });
    const data = Buffer.from('{"a":2,"b":1}', "utf8").toString("base64");

    expect(plaintext).toBe(
      `data=${data}&method=post&nonceStr=abc123&requestUrl=https://rm.test/v3/payment/online` +
        "&signType=sha256&timestamp=1700000000",
    );
  });

  it("omits the data segment entirely when there is no body", () => {
    const plaintext = buildSignaturePlaintext(base);

    expect(plaintext.startsWith("method=post")).toBe(true);
    expect(plaintext).not.toContain("data=");
  });

  it("lowercases the verb", () => {
    expect(buildSignaturePlaintext({ ...base, method: "GET" })).toContain("method=get");
  });

  it("is identical for two bodies that differ only in key order", () => {
    const one = buildSignaturePlaintext({ ...base, body: { z: 1, a: { y: 2, b: 3 } } });
    const two = buildSignaturePlaintext({ ...base, body: { a: { b: 3, y: 2 }, z: 1 } });
    expect(one).toBe(two);
  });
});

describe("signRequest", () => {
  const input = {
    method: "POST",
    requestUrl: "https://rm.test/v3/payment/online",
    body: { storeId: "s1", amount: 2490 },
    nonceStr: "nonce-1",
    timestamp: "1700000000",
  };

  it("produces a signature the public key verifies", () => {
    const headers = signRequest(privateKey, input);
    expect(verify(buildSignaturePlaintext(input), headers["x-signature"])).toBe(true);
  });

  it("prefixes the signature with the algorithm", () => {
    expect(signRequest(privateKey, input)["x-signature"]).toMatch(/^sha256 [A-Za-z0-9+/=]+$/);
  });

  it("echoes back the nonce and timestamp that were signed", () => {
    const headers = signRequest(privateKey, input);
    expect(headers["x-nonce-str"]).toBe("nonce-1");
    expect(headers["x-timestamp"]).toBe("1700000000");
  });

  it("does not verify against a different body", () => {
    const headers = signRequest(privateKey, input);
    const tampered = buildSignaturePlaintext({ ...input, body: { storeId: "s1", amount: 1 } });
    expect(verify(tampered, headers["x-signature"])).toBe(false);
  });

  it("does not verify if the nonce is swapped after signing", () => {
    const headers = signRequest(privateKey, input);
    const other = buildSignaturePlaintext({ ...input, nonceStr: "nonce-2" });
    expect(verify(other, headers["x-signature"])).toBe(false);
  });

  it("issues a distinct nonce each time", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
  });
});

describe("loadPrivateKey", () => {
  beforeEach(clearPrivateKeyCache);

  it("reads a PEM key", () => {
    expect(loadPrivateKey(keyPath)).toContain("PRIVATE KEY");
  });

  it("caches by path so signing does not hit the disk per request", () => {
    expect(loadPrivateKey(keyPath)).toBe(loadPrivateKey(keyPath));
  });

  it("names the env var when the file is missing", () => {
    expect(() => loadPrivateKey(join(keyDir, "absent.pem"))).toThrow(
      /REVENUE_MONSTER_PRIVATE_KEY_PATH/,
    );
  });

  it("rejects a file that is not a PEM key", () => {
    const notAKey = join(keyDir, "notakey.txt");
    writeFileSync(notAKey, "hello", "utf8");
    expect(() => loadPrivateKey(notAKey)).toThrow(/does not look like a PEM private key/);
  });
});

// ------------------------------------------------------- adapter integration

const signedConfig: RevenueMonsterConfig = {
  apiKey: "rm_api_key",
  clientId: "rm_client",
  clientSecret: "rm_secret",
  webhookSecret: "rm_webhook",
  storeId: "store_1",
  apiBase: "https://rm.test",
  privateKeyPath: keyPath,
};

function anOrder(): Order {
  const carts = new CartService(new InMemoryCartRepository(), menuService);
  const orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
  const cart = carts.create();
  carts.addLine(cart.id, { itemId: "fish-dory-classic" });
  return orders.confirm({ cartId: cart.id });
}

function paymentRequest(order: Order) {
  return {
    order,
    method: "ewallet" as const,
    returnUrl: "http://localhost:3000/order/x",
    cancelUrl: "http://localhost:3000/order/x?cancelled=1",
    idempotencyKey: "idem-1",
  };
}

function fetchStub() {
  return vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: "tok_1", expiresIn: 3600 }), {
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ item: { checkoutId: "chk_1", url: "https://rm.pay/x" } }), {
        headers: { "content-type": "application/json" },
      }),
    );
}

describe("RevenueMonsterAdapter request signing", () => {
  beforeEach(clearPrivateKeyCache);

  it("signs the v3 call, and the signature verifies against the body actually sent", async () => {
    const fetchImpl = fetchStub();
    const adapter = new RevenueMonsterAdapter(signedConfig, "http://localhost:3000", fetchImpl as never);

    await adapter.createPayment(paymentRequest(anOrder()));

    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers["x-signature"]).toMatch(/^sha256 /);
    expect(headers["x-nonce-str"]).toBeTruthy();
    expect(headers["x-timestamp"]).toBeTruthy();

    // Rebuild the plaintext from what went over the wire and verify it.
    const plaintext = buildSignaturePlaintext({
      method: "POST",
      requestUrl: url,
      body: JSON.parse(init.body as string),
      nonceStr: headers["x-nonce-str"]!,
      timestamp: headers["x-timestamp"]!,
    });

    expect(verify(plaintext, headers["x-signature"]!)).toBe(true);
  });

  it("still sends the bearer token and api key alongside the signature", async () => {
    const fetchImpl = fetchStub();
    const adapter = new RevenueMonsterAdapter(signedConfig, "http://localhost:3000", fetchImpl as never);

    await adapter.createPayment(paymentRequest(anOrder()));

    const headers = (fetchImpl.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok_1");
    expect(headers["x-api-key"]).toBe("rm_api_key");
  });

  it("sends no signature headers when no key path is configured", async () => {
    const fetchImpl = fetchStub();
    const adapter = new RevenueMonsterAdapter(
      { ...signedConfig, privateKeyPath: undefined },
      "http://localhost:3000",
      fetchImpl as never,
    );

    await adapter.createPayment(paymentRequest(anOrder()));

    const headers = (fetchImpl.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["x-signature"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer tok_1");
  });

  it("treats a placeholder key path as unset rather than trying to read it", async () => {
    const fetchImpl = fetchStub();
    const adapter = new RevenueMonsterAdapter(
      { ...signedConfig, privateKeyPath: "xxx" },
      "http://localhost:3000",
      fetchImpl as never,
    );

    await adapter.createPayment(paymentRequest(anOrder()));

    const headers = (fetchImpl.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["x-signature"]).toBeUndefined();
  });

  it("fails loudly when a key path is configured but unreadable", async () => {
    const fetchImpl = fetchStub();
    const adapter = new RevenueMonsterAdapter(
      { ...signedConfig, privateKeyPath: join(keyDir, "gone.pem") },
      "http://localhost:3000",
      fetchImpl as never,
    );

    // Better to fail here than to send RM a request it will reject unsigned.
    await expect(adapter.createPayment(paymentRequest(anOrder()))).rejects.toThrow(
      /REVENUE_MONSTER_PRIVATE_KEY_PATH/,
    );
  });
});
