import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateUserAlerts } from "../../src/alerts/evaluate.js";
import { alertPushMessage, formatBRL, notifyAlerts, type PushMessage, type PushSender } from "../../src/alerts/notify.js";
import { buildApp } from "../../src/app.js";
import { syncAndAlert } from "../../src/jobs/workers.js";
import { BlindIndexContext, blindIndex, encryptField } from "../../src/lib/crypto.js";
import { FakePluggy, pluggyTx, testAuth } from "../fakes.js";
import { testKey, testPrisma } from "../helpers.js";

const prisma = testPrisma();
const fieldKey = testKey();
const now = new Date("2026-11-18T12:00:00Z");
const app = buildApp({ prisma, logger: false, authenticate: testAuth, now: () => now });

class MemorySender implements PushSender {
  sent: Array<{ token: string; message: PushMessage }> = [];
  async send(token: string, message: PushMessage) {
    this.sent.push({ token, message });
  }
}

type Spend = { date: string; cents: number; category?: string; internal?: boolean; bill?: boolean; direction?: "debit" | "credit" };

async function setup(spends: Spend[]) {
  const user = await prisma.user.create({ data: { appleUserId: `apple-${Math.random()}` } });
  const conn = await prisma.connection.create({
    data: {
      userId: user.id,
      pluggyItemIdEnc: encryptField("item", fieldKey),
      pluggyItemIdHash: blindIndex(`item-${Math.random()}`, fieldKey, BlindIndexContext.pluggyItem),
      institutionName: "Banco",
      status: "active",
      lastSyncedAt: new Date("2026-11-01T10:00:00Z"),
    },
  });
  const account = await prisma.account.create({
    data: { connectionId: conn.id, userId: user.id, pluggyAccountId: `acc-${Math.random()}`, type: "checking", name: "Conta", balanceCents: 0n },
  });
  for (const s of spends) {
    await prisma.transaction.create({
      data: {
        userId: user.id,
        accountId: account.id,
        pluggyTransactionId: `tx-${Math.random()}`,
        date: new Date(`${s.date}T00:00:00Z`),
        description: "COMPRA",
        direction: s.direction ?? "debit",
        amountCents: BigInt(s.cents),
        categoryId: s.category ?? "comida",
        categorySource: "pluggy",
        isInternalTransfer: s.internal ?? false,
        isCardBillPayment: s.bill ?? false,
      },
    });
  }
  return { user, conn, h: { "x-test-user": user.id } };
}

// O exemplo da RN02: média de 600, 690 e 780 = 690; 980 é 42,03% acima.
const EXAMPLE: Spend[] = [
  { date: "2026-08-05", cents: 60_000 },
  { date: "2026-09-05", cents: 69_000 },
  { date: "2026-10-05", cents: 78_000 },
  { date: "2026-11-05", cents: 98_000 },
];

beforeEach(async () => {
  await prisma.consent.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await app.close();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
});

describe("avaliação dos alertas (RF23, RN02 a RN04)", () => {
  it("cria o alerta quando o mês passa da média, e só uma vez por categoria no mês", async () => {
    const { user } = await setup(EXAMPLE);
    const first = await evaluateUserAlerts(prisma, user.id, now);
    expect(first).toEqual([
      expect.objectContaining({ categoryId: "comida", categoryName: "Comida", referenceMonth: "2026-11", currentCents: 98_000, averageCents: 69_000, increasePct: 42.03 }),
    ]);

    // mais uma compra no mesmo mês: o alerta já existe, nada de novo (RN04)
    await prisma.transaction.updateMany({ where: { userId: user.id, date: new Date("2026-11-05T00:00:00Z") }, data: { amountCents: 120_000n } });
    expect(await evaluateUserAlerts(prisma, user.id, now)).toEqual([]);
    expect(await prisma.alert.count({ where: { userId: user.id } })).toBe(1);
  });

  it("sem 2 meses completos de histórico não há alerta (RN03)", async () => {
    const { user } = await setup([
      { date: "2026-10-05", cents: 10_000 },
      { date: "2026-11-05", cents: 98_000 },
    ]);
    expect(await evaluateUserAlerts(prisma, user.id, now)).toEqual([]);
  });

  it("mês sem gasto na categoria conta como zero na média", async () => {
    const { user } = await setup([
      { date: "2026-08-05", cents: 60_000 },
      { date: "2026-09-05", cents: 5_000, category: "outros" }, // nada de comida em setembro
      { date: "2026-10-05", cents: 60_000 },
      { date: "2026-11-05", cents: 60_000 },
    ]);
    const [alert] = await evaluateUserAlerts(prisma, user.id, now);
    expect(alert).toMatchObject({ categoryId: "comida", averageCents: 40_000, increasePct: 50 });
  });

  it("transferência própria, pagamento de fatura e entrada não contam como gasto (RF19)", async () => {
    const { user } = await setup([
      ...EXAMPLE.slice(0, 3),
      { date: "2026-11-05", cents: 70_000 },
      { date: "2026-11-06", cents: 50_000, internal: true },
      { date: "2026-11-07", cents: 50_000, bill: true },
      { date: "2026-11-08", cents: 50_000, direction: "credit" },
    ]);
    expect(await evaluateUserAlerts(prisma, user.id, now)).toEqual([]);
  });
});

describe("notificação (RF24)", () => {
  const alert = {
    id: "a1",
    userId: "u1",
    categoryId: "comida",
    categoryName: "Comida",
    referenceMonth: "2026-11",
    currentCents: 98_000,
    averageCents: 69_000,
    increasePct: 42.03,
  };

  it("esconde os valores por padrão", () => {
    const m = alertPushMessage(alert, false);
    expect(m.body).toBe("Seus gastos com Comida este mês estão acima da sua média. Toque para ver.");
    expect(m.body).not.toMatch(/R\$|\d/);
    expect(m.data).toEqual({ alertId: "a1" });
  });

  it("mostra os valores só se o usuário escolheu", () => {
    expect(alertPushMessage(alert, true).body).toBe("Comida: R$ 980,00 este mês, 42% acima da sua média (R$ 690,00).");
  });

  it("formata reais com milhar e centavos", () => {
    expect(formatBRL(123_456_78)).toBe("R$ 123.456,78");
    expect(formatBRL(5)).toBe("R$ 0,05");
  });

  it("sem remetente configurado (ainda sem APNs), não manda nada", async () => {
    expect(await notifyAlerts(prisma, null, [alert])).toBe(0);
  });

  it("depois da sincronização, avisa cada aparelho do usuário com a preferência dele", async () => {
    const { user, conn } = await setup(EXAMPLE.slice(0, 3));
    await prisma.device.createMany({
      data: [
        { userId: user.id, apnsToken: "a".repeat(64) },
        { userId: user.id, apnsToken: "b".repeat(64), showAmountsInPush: true },
      ],
    });
    const pluggy = new FakePluggy();
    pluggy.addItem("item", user.id);
    pluggy.accounts.set("item", [{ id: "acc-novo", itemId: "item", type: "BANK", subtype: "CHECKING_ACCOUNT", name: "Conta 2", balance: 0 }]);
    pluggy.transactions.set("acc-novo", [pluggyTx("mercado", "acc-novo", { amount: -980, category: "Groceries" })]);

    const sender = new MemorySender();
    const res = await syncAndAlert({ prisma, pluggy, fieldKey, now: () => now, push: sender }, conn.id);
    expect(res).toMatchObject({ alerts: 1, pushed: 2 });
    const bodies = Object.fromEntries(sender.sent.map((s) => [s.token[0], s.message.body]));
    expect(bodies.a).not.toContain("R$");
    expect(bodies.b).toContain("R$ 980,00");

    // a mesma sincronização de novo não repete o aviso
    const again = await syncAndAlert({ prisma, pluggy, fieldKey, now: () => now, push: sender }, conn.id);
    expect(again).toMatchObject({ alerts: 0, pushed: 0 });
  });
});

describe("rotas da tela de alertas (RF24)", () => {
  it("lista, marca um como lido e marca todos", async () => {
    const { user, h } = await setup(EXAMPLE);
    await evaluateUserAlerts(prisma, user.id, now);

    const list = await app.inject({ method: "GET", url: "/alerts", headers: h });
    expect(list.statusCode).toBe(200);
    const [item] = list.json().items;
    expect(item).toMatchObject({
      month: "2026-11",
      category: { id: "comida", name: "Comida" },
      currentCents: 98_000,
      averageCents: 69_000,
      increasePct: 42.03,
      read: false,
    });
    expect((await app.inject({ method: "GET", url: "/summary", headers: h })).json().unreadAlerts).toBe(1);

    const read = await app.inject({ method: "POST", url: `/alerts/${item.id}/read`, headers: h });
    expect(read.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/alerts", headers: h })).json().items[0].read).toBe(true);
    expect((await app.inject({ method: "GET", url: "/summary", headers: h })).json().unreadAlerts).toBe(0);

    // de novo não dá erro
    expect((await app.inject({ method: "POST", url: `/alerts/${item.id}/read`, headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/alerts/read-all", headers: h })).json()).toEqual({ marked: 0 });
  });

  it("alerta de outra pessoa responde 404 e não aparece na lista", async () => {
    const dono = await setup(EXAMPLE);
    await evaluateUserAlerts(prisma, dono.user.id, now);
    const [alert] = await prisma.alert.findMany({ where: { userId: dono.user.id } });
    const outro = await setup([]);
    expect((await app.inject({ method: "GET", url: "/alerts", headers: outro.h })).json().items).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/alerts/${alert!.id}/read`, headers: outro.h })).statusCode).toBe(404);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: alert!.id } })).readAt).toBeNull();
  });

  it("sem login responde 401", async () => {
    expect((await app.inject({ method: "GET", url: "/alerts" })).statusCode).toBe(401);
  });
});

describe("aparelho para notificação", () => {
  const token = "ab".repeat(32);

  it("registra o aparelho escondendo valores por padrão e troca a preferência", async () => {
    const { h } = await setup([]);
    const put = await app.inject({ method: "PUT", url: "/devices", headers: h, payload: { apnsToken: token } });
    expect(put.json()).toMatchObject({ showAmountsInPush: false });
    const patch = await app.inject({ method: "PATCH", url: `/devices/${put.json().id}`, headers: h, payload: { showAmountsInPush: true } });
    expect(patch.json()).toMatchObject({ showAmountsInPush: true });
    expect(await prisma.device.count()).toBe(1);
  });

  it("o mesmo iPhone com outra conta passa a avisar só a conta nova", async () => {
    const a = await setup([]);
    const b = await setup([]);
    const first = await app.inject({ method: "PUT", url: "/devices", headers: a.h, payload: { apnsToken: token } });
    await app.inject({ method: "PUT", url: "/devices", headers: b.h, payload: { apnsToken: token } });
    expect(await prisma.device.findUniqueOrThrow({ where: { apnsToken: token } })).toMatchObject({ userId: b.user.id });
    // e a conta antiga não consegue mais mexer nele
    const patch = await app.inject({ method: "PATCH", url: `/devices/${first.json().id}`, headers: a.h, payload: { showAmountsInPush: true } });
    expect(patch.statusCode).toBe(404);
  });

  it("recusa token inválido", async () => {
    const { h } = await setup([]);
    const res = await app.inject({ method: "PUT", url: "/devices", headers: h, payload: { apnsToken: "nao-e-token" } });
    expect(res.statusCode).toBe(400);
  });
});
