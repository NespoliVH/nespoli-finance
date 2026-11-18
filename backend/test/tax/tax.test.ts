import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { syncConnection } from "../../src/connections/sync.js";
import { BlindIndexContext, blindIndex, encryptField } from "../../src/lib/crypto.js";
import { TAX_DISCLAIMER } from "../../src/tax/routes.js";
import { FakePluggy, pluggyTx, testAuth } from "../fakes.js";
import { testKey, testPrisma } from "../helpers.js";

const prisma = testPrisma();
const fieldKey = testKey();
const now = new Date("2026-11-18T12:00:00Z");
const app = buildApp({ prisma, logger: false, authenticate: testAuth, now: () => now });

type Tx = {
  description: string;
  cents: number;
  direction: "debit" | "credit";
  date?: string;
  pluggyCategory?: string;
  taxableIncome?: "no" | "suggested" | "confirmed";
  deductibleType?: "health" | "education" | "pension";
};

async function setup(txs: Tx[] = []) {
  const user = await prisma.user.create({ data: { appleUserId: `apple-${Math.random()}` } });
  const conn = await prisma.connection.create({
    data: {
      userId: user.id,
      pluggyItemIdEnc: encryptField("item", fieldKey),
      pluggyItemIdHash: blindIndex(`item-${Math.random()}`, fieldKey, BlindIndexContext.pluggyItem),
      institutionName: "Banco",
      status: "active",
    },
  });
  const account = await prisma.account.create({
    data: { connectionId: conn.id, userId: user.id, pluggyAccountId: `acc-${Math.random()}`, type: "checking", name: "Conta", balanceCents: 0n },
  });
  const ids: string[] = [];
  for (const t of txs) {
    const row = await prisma.transaction.create({
      data: {
        userId: user.id,
        accountId: account.id,
        pluggyTransactionId: `tx-${Math.random()}`,
        date: new Date(`${t.date ?? "2026-11-05"}T00:00:00Z`),
        description: t.description,
        direction: t.direction,
        amountCents: BigInt(t.cents),
        pluggyCategory: t.pluggyCategory ?? null,
        categoryId: t.direction === "debit" ? "imprevistos" : null,
        taxableIncome: t.taxableIncome ?? "no",
        deductibleType: t.deductibleType ?? null,
      },
    });
    ids.push(row.id);
  }
  return { user, conn, ids, h: { "x-test-user": user.id } };
}

const putProfile = (h: Record<string, string>, payload: object) => app.inject({ method: "PUT", url: "/tax/profile", headers: h, payload });
const estimate = async (h: Record<string, string>) => (await app.inject({ method: "GET", url: "/tax/estimate", headers: h })).json();

beforeEach(async () => {
  await prisma.consent.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await app.close();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
});

describe("perfil fiscal", () => {
  it("grava, lê e troca o perfil", async () => {
    const { h } = await setup();
    expect((await app.inject({ method: "GET", url: "/tax/profile", headers: h })).statusCode).toBe(404);
    expect((await putProfile(h, { grossMonthlySalaryCents: 1_000_000 })).statusCode).toBe(200);
    await putProfile(h, { grossMonthlySalaryCents: 700_000, withheldMonthlyCents: 50_000, dependentsCount: 1 });
    expect((await app.inject({ method: "GET", url: "/tax/profile", headers: h })).json()).toEqual({
      grossMonthlySalaryCents: 700_000,
      withheldMonthlyCents: 50_000,
      dependentsCount: 1,
    });
  });

  it("recusa valor quebrado ou negativo", async () => {
    const { h } = await setup();
    expect((await putProfile(h, { grossMonthlySalaryCents: 10.5 })).statusCode).toBe(400);
    expect((await putProfile(h, { grossMonthlySalaryCents: -1 })).statusCode).toBe(400);
  });
});

describe("estimativa do IR (RF27, RN05)", () => {
  it("sem perfil, pede o perfil", async () => {
    const { h } = await setup();
    const res = await app.inject({ method: "GET", url: "/tax/estimate", headers: h });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "profile_required" });
  });

  it("salário de R$ 10 mil: simplificado, reserva por mês e aviso de não oficial", async () => {
    const { h } = await setup();
    await putProfile(h, { grossMonthlySalaryCents: 1_000_000 });
    const r = await estimate(h);
    expect(r).toMatchObject({
      year: 2026,
      disclaimer: TAX_DISCLAIMER,
      tableVerifiedOfficial: true, // tabelas de 2026 conferidas na Receita Federal e no INSS em 18/11/2026 (RN06)
      estimate: { regime: "simplified", taxDueCents: 1_724_434, differenceCents: 1_724_434 },
      monthsUntilDeadline: 7, // novembro a maio
      monthlyReserveCents: 246_348, // 17.487,80 ÷ 7, arredondado para cima
    });
    expect(r.estimate.steps.at(-1)).toEqual({ label: "(=) Diferença", amountCents: 1_724_434 });
  });

  it("usa as despesas dedutíveis marcadas e os dependentes (completo)", async () => {
    const { h } = await setup([{ description: "HOSPITAL", cents: 1_000_000, direction: "debit", deductibleType: "health" }]);
    await putProfile(h, { grossMonthlySalaryCents: 1_000_000, dependentsCount: 2 });
    const r = await estimate(h);
    expect(r.estimate).toMatchObject({ regime: "complete", taxDueCents: 1_483_332 });
    expect(r.inputs.healthCents).toBe(1_000_000);
  });

  it("projeta os rendimentos extras confirmados e não soma o salário de novo", async () => {
    const { h } = await setup([
      { description: "PIX HONORARIOS", cents: 300_000, direction: "credit", taxableIncome: "confirmed" },
      { description: "CRED SALARIO", cents: 800_000, direction: "credit", taxableIncome: "confirmed", pluggyCategory: "Salary" },
      { description: "PIX FREELA", cents: 999_999, direction: "credit", taxableIncome: "suggested" }, // ainda não confirmado
      { description: "HONORARIOS 2025", cents: 999_999, direction: "credit", taxableIncome: "confirmed", date: "2025-12-10" }, // outro ano
    ]);
    await putProfile(h, { grossMonthlySalaryCents: 1_000_000 });
    const r = await estimate(h);
    // 3.000 em 11 meses, projetado para 12: 3.272,73
    expect(r.inputs).toMatchObject({ otherIncomeSoFarCents: 300_000, monthsElapsed: 11, otherIncomeProjectedCents: 327_273 });
    expect(r.estimate.taxableIncomeCents).toBe(12_000_000 + 327_273);
  });

  it("IR retido maior que o devido vira restituição, sem reserva", async () => {
    const { h } = await setup();
    await putProfile(h, { grossMonthlySalaryCents: 1_000_000, withheldMonthlyCents: 200_000 });
    const r = await estimate(h);
    expect(r.estimate.differenceCents).toBeLessThan(0);
    expect(r.monthlyReserveCents).toBe(0);
  });

  it("sem a tabela do ano, avisa em vez de calcular errado", async () => {
    const semTabela = buildApp({ prisma, logger: false, authenticate: testAuth, now: () => new Date("2031-03-01T12:00:00Z") });
    const { h } = await setup();
    await putProfile(h, { grossMonthlySalaryCents: 1_000_000 });
    const res = await semTabela.inject({ method: "GET", url: "/tax/estimate", headers: h });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "tax_table_missing", year: 2031 });
    await semTabela.close();
  });
});

describe("marcações fiscais (RF25, RF26)", () => {
  it("a sincronização sugere o salário como rendimento, e o usuário confirma", async () => {
    const { user, conn, h } = await setup();
    const pluggy = new FakePluggy();
    pluggy.addItem("item", user.id);
    pluggy.accounts.set("item", [{ id: "acc-novo", itemId: "item", type: "BANK", subtype: "CHECKING_ACCOUNT", name: "Conta 2", balance: 0 }]);
    pluggy.transactions.set("acc-novo", [
      pluggyTx("salario", "acc-novo", { description: "TED EMPRESA X", amount: 7_500, type: "CREDIT", category: "Salary" }),
      pluggyTx("mercado", "acc-novo"),
    ]);
    await syncConnection({ prisma, pluggy, fieldKey, now: () => now }, conn.id);

    const list = (await app.inject({ method: "GET", url: "/tax/suggestions", headers: h })).json();
    expect(list.items).toEqual([expect.objectContaining({ description: "TED EMPRESA X", amountCents: 750_000, looksLikeSalary: true })]);
    const mercado = await prisma.transaction.findFirstOrThrow({ where: { pluggyTransactionId: "mercado" } });
    expect(mercado.taxableIncome).toBe("no");

    const res = await app.inject({ method: "PATCH", url: `/transactions/${list.items[0].id}/tax`, headers: h, payload: { taxableIncome: "confirmed" } });
    expect(res.json()).toMatchObject({ taxableIncome: "confirmed" });
    expect((await app.inject({ method: "GET", url: "/tax/suggestions", headers: h })).json().items).toEqual([]);
  });

  it("marca e desmarca despesa dedutível", async () => {
    const { ids, h } = await setup([{ description: "ESCOLA", cents: 150_000, direction: "debit" }]);
    const url = `/transactions/${ids[0]}/tax`;
    expect((await app.inject({ method: "PATCH", url, headers: h, payload: { deductibleType: "education" } })).json()).toMatchObject({ deductibleType: "education" });
    expect((await app.inject({ method: "PATCH", url, headers: h, payload: { deductibleType: null } })).json()).toMatchObject({ deductibleType: null });
  });

  it("recusa rendimento em gasto, dedutível em entrada, corpo vazio e transação alheia", async () => {
    const { ids, h } = await setup([
      { description: "ESCOLA", cents: 150_000, direction: "debit" },
      { description: "SALARIO", cents: 500_000, direction: "credit" },
    ]);
    const [gasto, entrada] = ids;
    expect((await app.inject({ method: "PATCH", url: `/transactions/${gasto}/tax`, headers: h, payload: { taxableIncome: "confirmed" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PATCH", url: `/transactions/${entrada}/tax`, headers: h, payload: { deductibleType: "health" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PATCH", url: `/transactions/${gasto}/tax`, headers: h, payload: {} })).statusCode).toBe(400);
    const outro = await setup();
    expect((await app.inject({ method: "PATCH", url: `/transactions/${gasto}/tax`, headers: outro.h, payload: { deductibleType: "health" } })).statusCode).toBe(404);
  });
});
