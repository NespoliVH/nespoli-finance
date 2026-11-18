import { describe, expect, it } from "vitest";
import { accountTypeFrom, brazilDate, connectionStatusFromItem, mapAccount, mapTransaction } from "../../src/pluggy/mapping.js";
import { pluggyTx } from "../fakes.js";

const now = new Date("2026-11-17T12:00:00Z");

describe("estado da conexão a partir do item", () => {
  it("converte os estados do Pluggy", () => {
    expect(connectionStatusFromItem({ status: "UPDATED" }, now)).toBe("active");
    expect(connectionStatusFromItem({ status: "OUTDATED" }, now)).toBe("active");
    expect(connectionStatusFromItem({ status: "UPDATING" }, now)).toBe("updating");
    expect(connectionStatusFromItem({ status: "LOGIN_ERROR" }, now)).toBe("login_error");
    expect(connectionStatusFromItem({ status: "WAITING_USER_ACTION" }, now)).toBe("login_error");
  });

  it("consentimento vencido vence qualquer outro estado", () => {
    expect(connectionStatusFromItem({ status: "UPDATED", consentExpiresAt: new Date("2026-11-01") }, now)).toBe("consent_expired");
    expect(connectionStatusFromItem({ status: "UPDATED", consentExpiresAt: new Date("2027-11-01") }, now)).toBe("active");
  });
});

describe("contas", () => {
  it("distingue corrente, poupança e cartão", () => {
    expect(accountTypeFrom({ type: "BANK", subtype: "CHECKING_ACCOUNT" })).toBe("checking");
    expect(accountTypeFrom({ type: "BANK", subtype: "SAVINGS_ACCOUNT" })).toBe("savings");
    expect(accountTypeFrom({ type: "CREDIT", subtype: "CREDIT_CARD" })).toBe("credit_card");
  });

  it("guarda o saldo em centavos e só os 4 últimos dígitos à mostra", () => {
    const a = mapAccount({ id: "a1", itemId: "i1", type: "BANK", subtype: "CHECKING_ACCOUNT", name: "Conta", number: "0001/12345-6", balance: 1520.1 });
    expect(a).toMatchObject({ balanceCents: 152_010, numberLast4: "3456", number: "0001/12345-6" });
  });
});

describe("transações", () => {
  it("valor sempre positivo, direção pelo sinal", () => {
    expect(mapTransaction(pluggyTx("t1", "a1"))).toMatchObject({ amountCents: 12_345, direction: "debit", status: "posted" });
    expect(mapTransaction(pluggyTx("t2", "a1", { amount: 50, type: "CREDIT", status: "PENDING" }))).toMatchObject({
      amountCents: 5_000,
      direction: "credit",
      status: "pending",
    });
    // como o sandbox manda uma compra no cartão: type CREDIT, valor negativo
    expect(mapTransaction(pluggyTx("t3", "a1", { amount: -55.9, type: "CREDIT", category: "Video streaming" }))?.direction).toBe("debit");
  });

  it("marca transferência entre contas próprias e pagamento de fatura (RF19)", () => {
    expect(mapTransaction(pluggyTx("t4", "a1", { category: "Same person transfer - PIX" }))?.isInternalTransfer).toBe(true);
    expect(mapTransaction(pluggyTx("t5", "a1", { category: "Credit card payment" }))?.isCardBillPayment).toBe(true);
  });

  it("descarta valor zero", () => {
    expect(mapTransaction(pluggyTx("t6", "a1", { amount: 0 }))).toBeNull();
  });

  it("usa a data do Brasil: 23h30 do dia 30 continua no dia 30", () => {
    expect(brazilDate(new Date("2026-12-01T02:30:00Z")).toISOString()).toBe("2026-11-30T00:00:00.000Z");
  });
});
