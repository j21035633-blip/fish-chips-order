import { randomUUID } from "node:crypto";

import type { ChanceTrigger } from "../orders/types.js";

/**
 * Screenshots customers submit as proof of a review or a share, and the queue
 * staff work through.
 *
 * Staff approval rather than an API check, deliberately: verifying against
 * Google's or Instagram's APIs means credentials, review-scraping rules and a
 * per-platform integration for each of four platforms, to decide something a
 * human settles in a second by looking at a picture.
 *
 * The record holds the *session* it belongs to, which is what makes an approval
 * land on one customer's chance count and nobody else's.
 */

export const PROOF_TYPES = ["review", "share"] as const;
export type ProofType = (typeof PROOF_TYPES)[number];

export const PROOF_STATUSES = ["pending", "approved", "rejected"] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export interface Proof {
  id: string;
  /** The cart — the session — that earns the chance. */
  cartId: string;
  type: ProofType;
  /** The served `/uploads/proofs/<file>` path, never the disk path. */
  imageUrl: string;
  status: ProofStatus;
  /** Shown on the approvals queue so staff know whose it is. */
  tableNumber?: string;
  submittedAt: string;
  decidedAt?: string;
}

/** A proof type is also the chance trigger it claims. */
export function triggerFor(type: ProofType): ChanceTrigger {
  return type;
}

export interface ProofRepository {
  get(id: string): Promise<Proof | undefined>;
  save(proof: Proof): Promise<void>;
  /** Newest last, so the queue reads top-down in the order they arrived. */
  byStatus(status: ProofStatus): Promise<Proof[]>;
  forCart(cartId: string): Promise<Proof[]>;
}

export class InMemoryProofRepository implements ProofRepository {
  private readonly proofs = new Map<string, Proof>();

  async get(id: string): Promise<Proof | undefined> {
    const proof = this.proofs.get(id);
    return proof === undefined ? undefined : structuredClone(proof);
  }

  async save(proof: Proof): Promise<void> {
    this.proofs.set(proof.id, structuredClone(proof));
  }

  async byStatus(status: ProofStatus): Promise<Proof[]> {
    return [...this.proofs.values()]
      .filter((proof) => proof.status === status)
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
      .map((proof) => structuredClone(proof));
  }

  async forCart(cartId: string): Promise<Proof[]> {
    return [...this.proofs.values()]
      .filter((proof) => proof.cartId === cartId)
      .map((proof) => structuredClone(proof));
  }
}

export function newProof(input: {
  cartId: string;
  type: ProofType;
  imageUrl: string;
  tableNumber?: string | undefined;
}): Proof {
  const proof: Proof = {
    id: randomUUID(),
    cartId: input.cartId,
    type: input.type,
    imageUrl: input.imageUrl,
    status: "pending",
    submittedAt: new Date().toISOString(),
  };
  if (input.tableNumber !== undefined) proof.tableNumber = input.tableNumber;
  return proof;
}
