import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { syncConnection } from "../../src/connections/sync.js";
import { BlindIndexContext, blindIndex, encryptField } from "../../src/lib/crypto.js";
import { currentMonth, monthRange } from "../../src/transactions/period.js";
import { FakePluggy, pluggyTx, testAuth } from "../fakes.js";
import { testKey, testPrisma } from "../helpers.js";

const prisma = testPrisma();
const fieldKey = testKey();
const now = new Date("2026-11-18T12:00:00Z");
const app = buildApp({ prisma, logger: false, authenticate: testAuth, now: () => now });

type Tx = {
  id: string;
  date: string;
  amountCents: number;
  direction?: "debit" | "credit";
  categoryId?: string | null;
  merchantKey?: string;
  internal?: boolean;
  bill?: boolean;
};

async function scenario(txs: Tx[]) {
  const user = await prisma.user.create({ data: { appleUserId: `apple-${Math.random()}` } });
  const conn = await prisma.connection.create({
    data: {
      userId: user.id,
      pluggyItemIdEnc: encryptField("item", fieldKey),
      pluggyItemIdHash: blindIndex(`item-${Math.random()}`, fieldKey, BlindIndexContext.pluggyItem),
      institutionName: "Banco",
      status: "active",
      lastSyncedAt: new Date("2026-11-18T10:00:00Z"),
    },
  });
  const account = await prisma.account.create({
    data: { connectionId: conn.id, userId: user.id, pluggyAccountId: `acc-${Math.random()}`, type: "checking", name: "Conta", numberLast4: "1234", balanceCents: 0n },
  });
  for (const t of txs) {
    const direction = t.direction ?? "debit";
    const spending = direction === "debit" && !t.internal && !t.bill;
    await prisma.transaction.create({
      data: {
        userId: user.id,
        accountId: account.id,
        pluggyTransactionId: `${t.id}-${Math.random()}`,
        date: new Date(`${t.date}T00:00:00Z`),
        description: t.id.toUpperCase(),
        merchantKey: t.merchantKey ?? t.id,
        direction,
        amountCents: BigInt(t.amountCents),
        categoryId: spending ? (t.categoryId === undefined ? "outros" : t.categoryId) : null,
        categorySource: spending ? "pluggy" : null,
        isInternalTransfer: t.internal ?? false,
        isCardBillPayment: t.bill ?? false,
      },
    });
  }
  return { user, conn, account, h: { "x-test-user": user.id } };
}

beforeEach(async () => {
  await prisma.consent.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await app.close();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
});

describe("período", () => {
  it("mês de calendário com fim exclusivo (RN07)", () => {
    const r = monthRange("2026-12");
    expect(r.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("o mês corrente é o do Brasil: 22h do dia 30 de novembro ainda é novembro", () => {
    expect(currentMonth(new Date("2026-12-01T01:00:00Z"))).toBe("2026-11");
  });
});

describe("GET /summary", () => {
  it("sem usuário, 401", async () => {
    expect((await app.inject({ method: "GET", url: "/summary" })).statusCode).toBe(401);
  });

  it("soma só os gastos do mês, por categoria, com percentual (RF19, RF20)", async () => {
    const { h } = await scenario([
      { id: "mercado", date: "2026-11-03", amountCents: 30_000, categoryId: "comida" },
      { id: "padaria", date: "2026-11-10", amountCents: 10_000, categoryId: "comida" },
      { id: "luz", date: "2026-11-05", amountCents: 60_000, categoryId: "contas_fixas" },
      { id: "salario", date: "2026-11-05", amountCents: 500_000, direction: "credit" },
      { id: "fatura", date: "2026-11-10", amountCents: 80_000, bill: true },
      { id: "poupanca", date: "2026-11-11", amountCents: 20_000, internal: true },
      { id: "outubro", date: "2026-10-31", amountCents: 99_000, categoryId: "comida" },
    ]);
    const res = await app.inject({ method: "GET", url: "/summary", headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.month).toBe("2026-11");
    expect(body.totalCents).toBe(100_000);
    expect(body.categories.map((c: { id: string }) => c.id)).toEqual(["contas_fixas", "comida", "imprevistos", "outros"]);
    expect(body.categories[0]).toMatchObject({ totalCents: 60_000, count: 1, percentBasisPoints: 6_000, name: "Contas fixas" });
    expect(body.categories[1]).toMatchObject({ totalCents: 40_000, count: 2, percentBasisPoints: 4_000 });
    expect(body.categories[2]).toMatchObject({ totalCents: 0, count: 0, percentBasisPoints: 0 });
    expect(body.connections).toEqual({ count: 1, importing: false, oldestSyncAt: "2026-11-18T10:00:00.000Z" });
  });

  it("troca para meses anteriores (RF21) e recusa mês inválido", async () => {
    const { h } = await scenario([{ id: "outubro", date: "2026-10-31", amountCents: 99_000, categoryId: "comida" }]);
    const res = await app.inject({ method: "GET", url: "/summary?month=2026-10", headers: h });
    expect(res.json().totalCents).toBe(99_000);
    expect((await app.inject({ method: "GET", url: "/summary?month=2026-13", headers: h })).statusCode).toBe(400);
  });

  it("não mistura dados de outro usuário", async () => {
    await scenario([{ id: "alheio", date: "2026-11-03", amountCents: 70_000 }]);
    const { h } = await scenario([]);
    const body = (await app.inject({ method: "GET", url: "/summary", headers: h })).json();
    expect(body.totalCents).toBe(0);
  });
});

describe("GET /transactions", () => {
  it("lista as transações de uma categoria no mês (RF22)", async () => {
    const { h } = await scenario([
      { id: "mercado", date: "2026-11-03", amountCents: 30_000, categoryId: "comida" },
      { id: "luz", date: "2026-11-05", amountCents: 60_000, categoryId: "contas_fixas" },
      { id: "padaria", date: "2026-11-10", amountCents: 10_000, categoryId: "comida" },
    ]);
    const body = (await app.inject({ method: "GET", url: "/transactions?categoryId=comida", headers: h })).json();
    expect(body.items.map((t: { description: string }) => t.description)).toEqual(["PADARIA", "MERCADO"]);
    expect(body.items[0]).toMatchObject({ date: "2026-11-10", amountCents: 10_000, isSpending: true, account: { name: "Conta", numberLast4: "1234" } });
    expect(body.nextCursor).toBeNull();
  });

  it("filtra entradas e gastos", async () => {
    const { h } = await scenario([
      { id: "mercado", date: "2026-11-03", amountCents: 30_000 },
      { id: "salario", date: "2026-11-05", amountCents: 500_000, direction: "credit" },
      { id: "fatura", date: "2026-11-10", amountCents: 80_000, bill: true },
    ]);
    const get = async (kind: string) =>
      (await app.inject({ method: "GET", url: `/transactions?kind=${kind}`, headers: h })).json().items.map((t: { description: string }) => t.description);
    expect(await get("all")).toEqual(["FATURA", "SALARIO", "MERCADO"]);
    expect(await get("spending")).toEqual(["MERCADO"]);
    expect(await get("income")).toEqual(["SALARIO"]);
  });

  it("pagina por cursor sem repetir nem pular transações", async () => {
    const txs = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, date: `2026-11-0${(i % 3) + 1}`, amountCents: 1_000 + i }));
    const { h } = await scenario(txs);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/transactions?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await app.inject({ method: "GET", url, headers: h })).json();
      seen.push(...body.items.map((t: { id: string }) => t.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect((await app.inject({ method: "GET", url: "/transactions?cursor=lixo", headers: h })).statusCode).toBe(400);
  });
});

describe("PATCH /transactions/:id/category", () => {
  async function firstId(h: Record<string, string>) {
    return (await app.inject({ method: "GET", url: "/transactions", headers: h })).json().items[0].id as string;
  }

  it("corrige a categoria e marca como manual (RF16)", async () => {
    const { h, user } = await scenario([{ id: "drogasil", date: "2026-11-03", amountCents: 5_000, categoryId: "outros" }]);
    const id = await firstId(h);
    const res = await app.inject({ method: "PATCH", url: `/transactions/${id}/category`, headers: h, payload: { categoryId: "imprevistos" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ transaction: { categoryId: "imprevistos", categorySource: "manual" }, ruleCreated: false });
    expect(await prisma.categoryRule.count({ where: { userId: user.id } })).toBe(0);
  });

  it("com applyToFuture, cria a regra e a próxima compra do mesmo lugar já chega certa (RF18)", async () => {
    const { h, user, conn } = await scenario([{ id: "drogasil", date: "2026-11-03", amountCents: 5_000, merchantKey: "drogasil centro" }]);
    const id = await firstId(h);
    await app.inject({ method: "PATCH", url: `/transactions/${id}/category`, headers: h, payload: { categoryId: "imprevistos", applyToFuture: true } });
    expect(await prisma.categoryRule.findFirst({ where: { userId: user.id } })).toMatchObject({ merchantKey: "drogasil centro", categoryId: "imprevistos" });

    // trocar de ideia atualiza a mesma regra
    await app.inject({ method: "PATCH", url: `/transactions/${id}/category`, headers: h, payload: { categoryId: "contas_fixas", applyToFuture: true } });
    expect(await prisma.categoryRule.count({ where: { userId: user.id } })).toBe(1);

    // próxima sincronização: a compra nova do mesmo estabelecimento usa a regra
    const pluggy = new FakePluggy();
    pluggy.addItem("item", user.id);
    pluggy.accounts.set("item", [{ id: "acc-novo", itemId: "item", type: "BANK", subtype: "CHECKING_ACCOUNT", name: "Conta 2", balance: 0 }]);
    pluggy.transactions.set("acc-novo", [pluggyTx("nova", "acc-novo", { description: "DROGASIL CENTRO 12/11", category: "Pharmacy" })]);
    await syncConnection({ prisma, pluggy, fieldKey, now: () => now }, conn.id);
    const nova = await prisma.transaction.findFirstOrThrow({ where: { pluggyTransactionId: "nova" } });
    expect(nova).toMatchObject({ categoryId: "contas_fixas", categorySource: "user_rule" });
  });

  it("recusa entrada de dinheiro e transação de outra pessoa", async () => {
    const { h } = await scenario([{ id: "salario", date: "2026-11-05", amountCents: 500_000, direction: "credit" }]);
    const id = await firstId(h);
    const res = await app.inject({ method: "PATCH", url: `/transactions/${id}/category`, headers: h, payload: { categoryId: "comida" } });
    expect(res.statusCode).toBe(422);

    const outro = await scenario([]);
    const alheia = await app.inject({ method: "PATCH", url: `/transactions/${id}/category`, headers: outro.h, payload: { categoryId: "comida" } });
    expect(alheia.statusCode).toBe(404);
  });

  it("recusa categoria que não existe", async () => {
    const { h } = await scenario([{ id: "x", date: "2026-11-05", amountCents: 100 }]);
    const id = await firstId(h);
    const res = await app.inject({ method: "PATCH", url: `/transactions/${id}/category`, headers: h, payload: { categoryId: "lazer" } });
    expect(res.statusCode).toBe(400);
  });
});
