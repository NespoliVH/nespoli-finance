import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { syncConnection } from "../../src/connections/sync.js";
import { buildHandlers } from "../../src/jobs/workers.js";
import { BlindIndexContext, blindIndex, decryptField } from "../../src/lib/crypto.js";
import { FakePluggy, MemoryQueue, pluggyTx } from "../fakes.js";
import { testKey, testPrisma } from "../helpers.js";

// Fluxo completo da conexão bancária sobre o banco real, com o Pluggy e a
// fila trocados por versões em memória.

const prisma = testPrisma();
const fieldKey = testKey();
const blindKey = testKey();
const SECRET = "s".repeat(40);
const now = new Date("2026-11-17T12:00:00Z");

let pluggy: FakePluggy;
let queue: MemoryQueue;
let app: ReturnType<typeof buildApp>;

function makeApp() {
  return buildApp({
    prisma,
    logger: false,
    connections: {
      queue,
      fieldKey,
      blindKey,
      now: () => now,
      pluggy: { api: pluggy, webhookSecret: SECRET, webhookUrl: `https://api.example/webhooks/pluggy/${SECRET}` },
      // Nos testes, o usuário vem de um cabeçalho. No app real virá do login (módulo 3).
      authenticate: async (req) => (req.headers["x-test-user"] as string | undefined) ?? null,
    },
  });
}

const deps = () => ({ prisma, pluggy, fieldKey, now: () => now });

async function newUser() {
  return prisma.user.create({ data: { appleUserId: `apple-${Math.random()}` } });
}

async function connect(userId: string, itemId = "item-1") {
  pluggy.addItem(itemId, userId);
  pluggy.accounts.set(itemId, [
    { id: `${itemId}-cc`, itemId, type: "BANK", subtype: "CHECKING_ACCOUNT", name: "Conta Corrente", number: "12345-6", balance: 1500 },
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/connections",
    headers: { "x-test-user": userId },
    payload: { itemId, termsVersion: "1.0", appVersion: "0.1.0" },
  });
  return res;
}

beforeEach(async () => {
  await prisma.consent.deleteMany();
  await prisma.user.deleteMany();
  pluggy = new FakePluggy();
  queue = new MemoryQueue();
  app = makeApp();
});

afterAll(async () => {
  await app.close();
  await prisma.consent.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
});

describe("autenticação e configuração", () => {
  it("sem usuário identificado, responde 401", async () => {
    const res = await app.inject({ method: "POST", url: "/connections/connect-token" });
    expect(res.statusCode).toBe(401);
  });

  it("sem Pluggy configurado, responde 503", async () => {
    const semPluggy = buildApp({
      prisma,
      logger: false,
      connections: { queue, fieldKey, blindKey, pluggy: null, authenticate: async () => "u" },
    });
    const res = await semPluggy.inject({ method: "POST", url: "/connections/connect-token" });
    expect(res.statusCode).toBe(503);
    await semPluggy.close();
  });
});

describe("POST /connections/connect-token", () => {
  it("gera o token com o id do usuário, para o item ficar ligado a ele", async () => {
    const user = await newUser();
    const res = await app.inject({ method: "POST", url: "/connections/connect-token", headers: { "x-test-user": user.id } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accessToken: "token-1" });
    expect(pluggy.tokens[0]).toEqual({ clientUserId: user.id, itemId: undefined });
  });
});

describe("POST /connections", () => {
  it("grava a conexão criptografada e o consentimento, e agenda a sincronização", async () => {
    const user = await newUser();
    const res = await connect(user.id);
    expect(res.statusCode).toBe(201);

    const conn = await prisma.connection.findFirstOrThrow({ where: { userId: user.id } });
    expect(Buffer.from(conn.pluggyItemIdEnc).toString("utf8")).not.toContain("item-1");
    expect(decryptField(conn.pluggyItemIdEnc, fieldKey)).toBe("item-1");
    expect(conn.pluggyItemIdHash).toBe(blindIndex("item-1", blindKey, BlindIndexContext.pluggyItem));

    const consent = await prisma.consent.findFirstOrThrow({ where: { connectionId: conn.id } });
    expect(consent).toMatchObject({ type: "bank_data_sharing", action: "granted", termsVersion: "1.0", appVersion: "0.1.0" });
    expect(queue.jobs).toEqual([{ name: "sync-connection", data: { connectionId: conn.id } }]);
  });

  it("recusa o item criado por outro usuário", async () => {
    const dona = await newUser();
    const intruso = await newUser();
    pluggy.addItem("item-x", dona.id);
    const res = await app.inject({
      method: "POST",
      url: "/connections",
      headers: { "x-test-user": intruso.id },
      payload: { itemId: "item-x", termsVersion: "1.0", appVersion: "0.1.0" },
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.connection.count()).toBe(0);
  });

  it("não deixa conectar o mesmo item duas vezes", async () => {
    const user = await newUser();
    await connect(user.id);
    const res = await connect(user.id);
    expect(res.statusCode).toBe(409);
  });
});

describe("sincronização", () => {
  async function connected() {
    const user = await newUser();
    await connect(user.id);
    const conn = await prisma.connection.findFirstOrThrow({ where: { userId: user.id } });
    pluggy.transactions.set("item-1-cc", [
      pluggyTx("t1", "item-1-cc"), // Groceries → comida
      pluggyTx("t2", "item-1-cc", { description: "SALARIO EMPRESA", amount: 5000, type: "CREDIT", category: "Salary" }),
      pluggyTx("t3", "item-1-cc", { description: "PIX MESMA TITULARIDADE", category: "Same person transfer - PIX" }),
      pluggyTx("t4", "item-1-cc", { description: "FARMACIA SAO JOAO", category: null }),
    ]);
    return { user, conn };
  }

  it("grava contas e transações já categorizadas", async () => {
    const { user, conn } = await connected();
    const result = await syncConnection(deps(), conn.id);
    expect(result).toMatchObject({ status: "active", accounts: 1, created: 4, updated: 0 });

    const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id } });
    expect(account).toMatchObject({ type: "checking", numberLast4: "3456", balanceCents: 150000n });
    expect(decryptField(account.numberEnc!, fieldKey)).toBe("12345-6");

    const txs = await prisma.transaction.findMany({ where: { userId: user.id }, orderBy: { pluggyTransactionId: "asc" } });
    expect(txs.map((t) => [t.pluggyTransactionId, t.categoryId, t.categorySource])).toEqual([
      ["t1", "comida", "pluggy"],
      ["t2", null, null], // entrada não é gasto
      ["t3", null, null], // transferência entre contas próprias
      ["t4", "imprevistos", "keyword"],
    ]);
    expect(txs[0]?.amountCents).toBe(12345n);
    expect(pluggy.lastDateFrom).toBe("2025-10-01"); // primeira vez: 13 meses
  });

  it("sincronizar de novo não duplica e não desfaz a correção do usuário (RF12)", async () => {
    const { user, conn } = await connected();
    await syncConnection(deps(), conn.id);
    await prisma.transaction.update({
      where: { pluggyTransactionId: "t1" },
      data: { categoryId: "outros", categorySource: "manual" },
    });
    pluggy.transactions.get("item-1-cc")![0]!.amount = -130;

    const again = await syncConnection(deps(), conn.id);
    expect(again).toMatchObject({ created: 0, updated: 4 });
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(4);
    const t1 = await prisma.transaction.findUniqueOrThrow({ where: { pluggyTransactionId: "t1" } });
    expect(t1).toMatchObject({ categoryId: "outros", categorySource: "manual", amountCents: 13000n });
    expect(pluggy.lastDateFrom).toBe("2026-10-18"); // da última sincronização, menos 30 dias
  });

  it("aplica a regra criada pelo usuário para o estabelecimento", async () => {
    const { user, conn } = await connected();
    await prisma.categoryRule.create({ data: { userId: user.id, merchantKey: "supermercado bom preco", categoryId: "contas_fixas" } });
    await syncConnection(deps(), conn.id);
    const t1 = await prisma.transaction.findUniqueOrThrow({ where: { pluggyTransactionId: "t1" } });
    expect(t1).toMatchObject({ categoryId: "contas_fixas", categorySource: "user_rule" });
  });

  it("item ainda atualizando: só registra o estado e espera o próximo aviso", async () => {
    const { conn } = await connected();
    pluggy.items.get("item-1")!.status = "UPDATING";
    const result = await syncConnection(deps(), conn.id);
    expect(result).toMatchObject({ status: "updating", created: 0 });
    expect(await prisma.transaction.count()).toBe(0);
  });
});

describe("webhook do Pluggy", () => {
  const hook = (payload: object, secret = SECRET) =>
    app.inject({ method: "POST", url: `/webhooks/pluggy/${secret}`, payload });

  it("segredo errado responde 404 e não faz nada", async () => {
    const res = await hook({ event: "item/updated", itemId: "item-1" }, "errado");
    expect(res.statusCode).toBe(404);
    expect(queue.jobs).toHaveLength(0);
  });

  it("item desconhecido responde 200 sem agendar nada", async () => {
    const res = await hook({ event: "item/updated", itemId: "nao-existe" });
    expect(res.statusCode).toBe(200);
    expect(queue.jobs).toHaveLength(0);
  });

  it("item/updated agenda a sincronização da conexão certa", async () => {
    const user = await newUser();
    await connect(user.id);
    queue.jobs = [];
    const conn = await prisma.connection.findFirstOrThrow();
    const res = await hook({ event: "item/updated", itemId: "item-1", eventId: "e1" });
    expect(res.statusCode).toBe(200);
    expect(queue.jobs).toEqual([{ name: "sync-connection", data: { connectionId: conn.id } }]);
  });

  it("transactions/deleted apaga só as transações daquela conexão", async () => {
    const user = await newUser();
    await connect(user.id);
    const conn = await prisma.connection.findFirstOrThrow();
    pluggy.transactions.set("item-1-cc", [pluggyTx("t1", "item-1-cc"), pluggyTx("t2", "item-1-cc")]);
    await syncConnection(deps(), conn.id);
    queue.jobs = [];

    await hook({ event: "transactions/deleted", itemId: "item-1", transactionIds: ["t1"] });
    expect(queue.jobs[0]?.name).toBe("delete-transactions");
    await buildHandlers(deps())["delete-transactions"](queue.jobs[0]!.data as never);
    expect((await prisma.transaction.findMany()).map((t) => t.pluggyTransactionId)).toEqual(["t2"]);
  });
});

describe("GET e DELETE /connections", () => {
  it("lista só as conexões do próprio usuário, sem o número completo da conta", async () => {
    const a = await newUser();
    const b = await newUser();
    await connect(a.id, "item-a");
    await connect(b.id, "item-b");
    const connA = await prisma.connection.findFirstOrThrow({ where: { userId: a.id } });
    await syncConnection(deps(), connA.id);

    const res = await app.inject({ method: "GET", url: "/connections", headers: { "x-test-user": a.id } });
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].accounts[0]).toEqual({ id: expect.any(String), type: "checking", name: "Conta Corrente", numberLast4: "3456", balanceCents: 150000 });
    expect(JSON.stringify(body)).not.toContain("12345");
  });

  it("revogar apaga o item no Pluggy e os dados aqui, e registra a revogação", async () => {
    const user = await newUser();
    await connect(user.id);
    const conn = await prisma.connection.findFirstOrThrow();
    pluggy.transactions.set("item-1-cc", [pluggyTx("t1", "item-1-cc")]);
    await syncConnection(deps(), conn.id);

    const res = await app.inject({ method: "DELETE", url: `/connections/${conn.id}`, headers: { "x-test-user": user.id } });
    expect(res.statusCode).toBe(204);
    expect(pluggy.deleted).toEqual(["item-1"]);
    expect(await prisma.connection.count()).toBe(0);
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.transaction.count()).toBe(0);
    const consents = await prisma.consent.findMany({ orderBy: { occurredAt: "asc" } });
    expect(consents.map((c) => c.action)).toEqual(["granted", "revoked"]);
    expect(consents.every((c) => c.connectionId === null)).toBe(true); // a prova fica, o vínculo some
  });

  it("não deixa revogar a conexão de outra pessoa", async () => {
    const dona = await newUser();
    const outro = await newUser();
    await connect(dona.id);
    const conn = await prisma.connection.findFirstOrThrow();
    const res = await app.inject({ method: "DELETE", url: `/connections/${conn.id}`, headers: { "x-test-user": outro.id } });
    expect(res.statusCode).toBe(404);
    expect(pluggy.deleted).toHaveLength(0);
  });
});
