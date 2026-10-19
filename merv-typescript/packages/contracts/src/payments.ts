import type {} from 'cordis';

/** One Stripe Checkout, as the plugin that sells something asks Payments for it. */
export interface CheckoutInput {
  /** The seller's product, `merv-…`: the fulfiller its paid checkout reaches. */
  product: string;
  /** The seller's record the payment is for: Stripe's client reference. */
  reference: string;
  amountUsd: number;
  /** The one line item's name on the Checkout page. */
  description: string;
  metadata: Record<string, string>;
  /** Absolute, or a path on the public origin. */
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  /** The buyer's address where the seller knows it; Checkout asks for it otherwise. */
  email?: string | null;
  /** The session an earlier checkout opened: given back while open, refused once paid. */
  previousId?: string;
}
/** A paid Checkout, as only a signed webhook event tells it. */
export interface Paid {
  product: string;
  reference: string;
  metadata: Record<string, string>;
  paymentId: string;
  amountUsd: number;
  eventId: string;
  sessionId: string;
  /** When the Checkout Session was created: the same for every event of one payment. */
  createdAt: string;
  /** The address the buyer gave Checkout. */
  email?: string;
}
/** Stripe, for every plugin that sells: checkout, and the one webhook that fulfils. */
export interface Payments {
  readonly live: boolean;
  checkout(input: CheckoutInput): Promise<{ url: string; sessionId: string; expiresAt: number }>;
  /** Null for anything but a paid completed checkout of a Merv product; throws on a bad signature. */
  verify(raw: Buffer, signature: string): Promise<Paid | null>;
  /** The handler of `product`'s paid checkouts, which must be idempotent on `paymentId`. */
  fulfil(product: string, handler: (paid: Paid) => Promise<void>): () => void;
  /** The webhook: verified, once per event, to its product's fulfiller. */
  receive(raw: Buffer, signature: unknown): Promise<{ received: true }>;
}

declare module 'cordis' {
  interface Context {
    payments: Payments;
  }
}
