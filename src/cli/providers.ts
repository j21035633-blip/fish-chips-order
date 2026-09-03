import { existsSync } from "node:fs";

import { config, isPlaceholder } from "../config/env.js";
import { RevenueMonsterAdapter } from "../payments/revenueMonsterAdapter.js";
import { StripeAdapter } from "../payments/stripeAdapter.js";

/**
 * Reports what each payment adapter can see in the environment.
 *
 * The point is to answer "did my keys land?" without placing a test order — and
 * to say *which* variable is missing when an adapter is still simulating. Values
 * are never printed, only whether they are set.
 */

const SET = "set";
const MISSING = "missing";
const PLACEHOLDER = "placeholder (still xxx)";

function state(value: string | undefined): string {
  if (value === undefined) return MISSING;
  return isPlaceholder(value) ? PLACEHOLDER : SET;
}

function line(name: string, value: string | undefined): string {
  const status = state(value);
  const mark = status === SET ? "ok  " : "--  ";
  return `  ${mark}${name.padEnd(36)}${status}`;
}

const stripe = new StripeAdapter(config.stripe, config.publicBaseUrl);
const revenueMonster = new RevenueMonsterAdapter(config.revenueMonster, config.publicBaseUrl);

const out: string[] = [];

out.push(`Public base URL: ${config.publicBaseUrl}`);
out.push("");

out.push(`Stripe (card) — ${stripe.isConfigured() ? "LIVE" : "simulated"}`);
out.push(line("STRIPE_SECRET_KEY", config.stripe.secretKey));
out.push(line("STRIPE_WEBHOOK_SECRET", config.stripe.webhookSecret));
out.push("");

out.push(`Revenue Monster (e-wallet) — ${revenueMonster.isConfigured() ? "LIVE" : "simulated"}`);
out.push(line("REVENUE_MONSTER_CLIENT_ID", config.revenueMonster.clientId));
out.push(line("REVENUE_MONSTER_CLIENT_SECRET", config.revenueMonster.clientSecret));
out.push(line("REVENUE_MONSTER_STORE_ID", config.revenueMonster.storeId));
out.push(line("REVENUE_MONSTER_API_KEY", config.revenueMonster.apiKey));
out.push(line("REVENUE_MONSTER_WEBHOOK_SECRET", config.revenueMonster.webhookSecret));
out.push(line("REVENUE_MONSTER_PRIVATE_KEY_PATH", config.revenueMonster.privateKeyPath));
out.push(`      ${"API base".padEnd(36)}${config.revenueMonster.apiBase}`);

const keyPath = config.revenueMonster.privateKeyPath;
if (!isPlaceholder(keyPath) && keyPath !== undefined) {
  out.push(
    `      ${"key file".padEnd(36)}${existsSync(keyPath) ? "found — requests will be signed" : `NOT FOUND at ${keyPath}`}`,
  );
} else {
  out.push(`      ${"request signing".padEnd(36)}off (no key path set)`);
}

out.push("");
if (!stripe.isConfigured() || !revenueMonster.isConfigured()) {
  out.push("Simulated adapters take no real payment. Fill the missing values in .env to go live.");
} else {
  out.push("Both providers configured. Payments will hit the real (sandbox) APIs.");
}

console.log(out.join("\n"));
