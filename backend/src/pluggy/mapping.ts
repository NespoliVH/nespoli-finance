import { reaisToCents, type Cents } from "../rules/money.js";
import type { PluggyAccount, PluggyItem, PluggyTransaction } from "./client.js";

// Conversão dos dados do Pluggy para o formato do banco do app.
// Fica separada da sincronização para ser testada sem banco nem rede.

export type ConnectionStatus = "updating" | "active" | "login_error" | "consent_expired" | "revoked";
export type AccountType = "checking" | "savings" | "credit_card";

/**
 * Estado da conexão a partir do item do Pluggy. Consentimento vencido vale
 * mais que qualquer outro estado, porque só o usuário resolve (renovando).
 */
export function connectionStatusFromItem(item: Pick<PluggyItem, "status" | "consentExpiresAt">, now: Date): ConnectionStatus {
  if (item.consentExpiresAt && item.consentExpiresAt.getTime() <= now.getTime()) return "consent_expired";
  switch (item.status) {
    case "UPDATING":
    case "MERGING":
      return "updating";
    case "LOGIN_ERROR":
    case "WAITING_USER_INPUT":
    case "WAITING_USER_ACTION":
      return "login_error"; // precisa de ação do usuário no app
    default:
      return "active"; // UPDATED, ou OUTDATED (erro passageiro que o Pluggy tenta de novo)
  }
}

export function accountTypeFrom(a: Pick<PluggyAccount, "type" | "subtype">): AccountType {
  if (a.type === "CREDIT" || a.subtype === "CREDIT_CARD") return "credit_card";
  if (a.subtype === "SAVINGS_ACCOUNT") return "savings";
  return "checking";
}

export interface AccountData {
  pluggyAccountId: string;
  type: AccountType;
  name: string;
  number: string | null; // vai criptografado para o banco
  numberLast4: string | null;
  balanceCents: Cents;
}

export function mapAccount(a: PluggyAccount): AccountData {
  const digits = a.number?.replace(/\D/g, "") ?? "";
  return {
    pluggyAccountId: a.id,
    type: accountTypeFrom(a),
    name: a.marketingName || a.name,
    number: a.number || null,
    numberLast4: digits.length >= 4 ? digits.slice(-4) : null,
    balanceCents: reaisToCents(a.balance),
  };
}

// Categorias do Pluggy que marcam o que não é gasto (RF19). Conferidas em
// GET /categories no sandbox em 18/11/2026: 04000000 "Same person transfer"
// (e as filhas CASH, PIX e TED) e 05100000 "Credit card payment".
const INTERNAL_TRANSFER = /^same person transfer/i;
const CARD_BILL_PAYMENT = /credit card payment/i;

export interface TransactionData {
  pluggyTransactionId: string;
  pluggyAccountId: string;
  date: Date; // só a data, no fuso do Brasil
  description: string;
  direction: "debit" | "credit";
  amountCents: Cents;
  status: "pending" | "posted";
  pluggyCategory: string | null;
  isInternalTransfer: boolean;
  isCardBillPayment: boolean;
}

/**
 * Data da transação no fuso de São Paulo. Uma compra às 23h30 do dia 30 é
 * 02h30 do dia 1º em UTC; sem esse ajuste ela cairia no mês seguinte e
 * bagunçaria o resumo mensal e os alertas.
 */
export function brazilDate(instant: Date): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return new Date(`${ymd}T00:00:00Z`);
}

/** Devolve null para transações de valor zero, que não interessam ao app. */
export function mapTransaction(t: PluggyTransaction): TransactionData | null {
  const amountCents = Math.abs(reaisToCents(t.amount));
  if (amountCents === 0) return null;
  const category = t.category ?? null;
  return {
    pluggyTransactionId: t.id,
    pluggyAccountId: t.accountId,
    date: brazilDate(t.date),
    description: t.description.trim(),
    // A direção vem do sinal do valor (negativo = saiu dinheiro). No sandbox,
    // o campo type do Pluggy marca as compras do cartão como CREDIT, com valor
    // negativo; o sinal é o que se mantém igual na conta e no cartão.
    // Conferido no sandbox em 18/11/2026; conferir de novo com dados reais.
    direction: t.amount < 0 ? "debit" : "credit",
    amountCents,
    status: t.status === "PENDING" ? "pending" : "posted",
    pluggyCategory: category,
    isInternalTransfer: category !== null && INTERNAL_TRANSFER.test(category),
    isCardBillPayment: category !== null && CARD_BILL_PAYMENT.test(category),
  };
}
