import "dotenv/config";

/**
 * Environment configuration.
 *
 * Names are SCREAMING_SNAKE_CASE with no spaces around `=` (see .env.example).
 *
 * Provider credentials are deliberately *optional*. A missing key does not crash
 * the app — it puts that adapter in `simulated` mode, so the menu, cart and
 * checkout flow stay runnable and testable without sandbox accounts. Every
 * simulated payment is labelled as such in its response, and `POST` to a live
 * provider is never attempted without a key.
 */

function str(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  // Tolerate `KEY = value` in a hand-edited .env without silently keeping the padding.
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function int(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  return parsed;
}

export interface StripeConfig {
  secretKey: string | undefined;
  webhookSecret: string | undefined;
  apiBase: string;
}

export interface RevenueMonsterConfig {
  apiKey: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  webhookSecret: string | undefined;
  storeId: string | undefined;
  apiBase: string;
  /**
   * Path to the PEM private key RM issues for request signing. When set, every
   * v3 call is signed; when absent, calls go out unsigned (fine for local work,
   * rejected by RM in production).
   */
  privateKeyPath: string | undefined;
}

export interface MongoConfig {
  /** Undefined falls back to in-memory storage, which does not survive a restart. */
  uri: string | undefined;
  dbName: string;
}

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  mongo: MongoConfig;
  stripe: StripeConfig;
  revenueMonster: RevenueMonsterConfig;
}

export function loadConfig(): AppConfig {
  return {
    port: int("PORT", 3000),
    publicBaseUrl: str("PUBLIC_BASE_URL") ?? `http://localhost:${int("PORT", 3000)}`,
    mongo: {
      // Railway's own MongoDB service publishes MONGO_URL; accept it so the
      // variable that is already there works without being renamed.
      uri: str("MONGODB_URI") ?? str("MONGO_URL"),
      dbName: str("MONGODB_DB") ?? "fish_chips_order",
    },
    stripe: {
      secretKey: str("STRIPE_SECRET_KEY"),
      webhookSecret: str("STRIPE_WEBHOOK_SECRET"),
      apiBase: str("STRIPE_API_BASE") ?? "https://api.stripe.com",
    },
    revenueMonster: {
      apiKey: str("REVENUE_MONSTER_API_KEY"),
      clientId: str("REVENUE_MONSTER_CLIENT_ID"),
      clientSecret: str("REVENUE_MONSTER_CLIENT_SECRET"),
      webhookSecret: str("REVENUE_MONSTER_WEBHOOK_SECRET"),
      storeId: str("REVENUE_MONSTER_STORE_ID"),
      apiBase: str("REVENUE_MONSTER_API_BASE") ?? "https://sb-open.revenuemonster.my",
      privateKeyPath: str("REVENUE_MONSTER_PRIVATE_KEY_PATH"),
    },
  };
}

/**
 * A placeholder value copied straight out of .env.example is worse than nothing —
 * it makes the adapter think it is live and then fail against the provider.
 */
export function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value === "xxx" || value.endsWith("_xxx");
}

export const config = loadConfig();
