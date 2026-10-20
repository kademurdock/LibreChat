export interface TransactionData {
  user: string;
  conversationId: string;
  tokenType: string;
  model?: string;
  context?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  inputTokenCount?: number;
  rateDetail?: Record<string, number>;
  /** KADE Oct 20 2026: the price factor the row was charged at (see schema/transaction.ts). */
  kadeFactor?: number;
  /** KADE Oct 20 2026: why the row was not charged. */
  kadeUncharged?: string;
}
