import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BlindIndexContext, blindIndex, encryptField } from "../src/lib/crypto.js";
import { testKey, testPrisma } from "./helpers.js";

// Estes testes conferem regras que o próprio banco garante
// (chaves únicas, restrições e exclusão em cascata), sobre o esquema real.

const prisma = testPrisma();
const key = testKey();

async function limpar() {
  await prisma.consent.deleteMany();
  await prisma.user.deleteMany();
}

async function criarCenario() {
  const user = await prisma.user.create({ data: { appleUserId: `apple-${Math.random()}` } });
  const connection = await prisma.connection.create({
    data: {
      userId: user.id,
      pluggyItemIdEnc: encryptField("item-1", key),
      pluggyItemIdHash: blindIndex(`item-${Math.random()}`, key, BlindIndexContext.pluggyItem),
      institutionName: "Banco A",
    },
  });
  const account = await prisma.account.create({
    data: {
      connectionId: connection.id,
      userId: user.id,
      pluggyAccountId: `acc-${Math.random()}`,
      type: "checking",
      name: "Conta Corrente",
      balanceCents: 150000n,
    },
  });
  return { user, connection, account };
}

function transacao(userId: string, accountId: string, pluggyId: string, amountCents = 3200n) {
  return {
    userId,
    accountId,
    pluggyTransactionId: pluggyId,
    date: new Date("2026-11-12"),
    description: "MERCADO BOM PRECO",
    direction: "debit" as const,
    amountCents,
    categoryId: "comida",
    categorySource: "pluggy" as const,
  };
}

beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

describe("esquema do banco", () => {
  it("já vem com as quatro categorias fixas", async () => {
    const cats = await prisma.category.findMany({ orderBy: { displayOrder: "asc" } });
    expect(cats.map((c) => c.id)).toEqual(["contas_fixas", "comida", "imprevistos", "outros"]);
  });

  it("recusa a mesma transação do Pluggy duas vezes (RF12)", async () => {
    const { user, account } = await criarCenario();
    await prisma.transaction.create({ data: transacao(user.id, account.id, "tx-1") });
    await expect(prisma.transaction.create({ data: transacao(user.id, account.id, "tx-1") })).rejects.toThrow();
  });

  it("recusa valor zero ou negativo, porque o sentido fica em direction", async () => {
    const { user, account } = await criarCenario();
    await expect(prisma.transaction.create({ data: transacao(user.id, account.id, "tx-neg", -100n) })).rejects.toThrow();
  });

  it("permite no máximo um alerta por categoria por mês (RN04)", async () => {
    const { user } = await criarCenario();
    const alerta = {
      userId: user.id,
      categoryId: "comida",
      referenceMonth: new Date("2026-11-01"),
      currentCents: 98000n,
      averageCents: 69000n,
      increasePct: "42.03",
    };
    await prisma.alert.create({ data: alerta });
    await expect(prisma.alert.create({ data: alerta })).rejects.toThrow();
  });

  it("exige que o mês de referência do alerta comece no dia 1", async () => {
    const { user } = await criarCenario();
    await expect(
      prisma.alert.create({
        data: {
          userId: user.id,
          categoryId: "comida",
          referenceMonth: new Date("2026-11-15"),
          currentCents: 1n,
          averageCents: 1n,
          increasePct: "0",
        },
      }),
    ).rejects.toThrow();
  });

  it("exclui em cascata e preserva só o consentimento pseudonimizado (RF05)", async () => {
    const { user, account, connection } = await criarCenario();
    await prisma.transaction.create({ data: transacao(user.id, account.id, "tx-cascata") });
    await prisma.consent.create({
      data: {
        userId: user.id,
        subjectHash: blindIndex(user.appleUserId, key, BlindIndexContext.consentSubject),
        connectionId: connection.id,
        type: "bank_data_sharing",
        action: "granted",
        termsVersion: "2026-11-v1",
        purpose: "Categorizar gastos, gerar alertas e estimar o IR",
        appVersion: "1.0.0",
      },
    });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.connection.count()).toBe(0);
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.transaction.count()).toBe(0);
    const consents = await prisma.consent.findMany();
    expect(consents).toHaveLength(1);
    expect(consents[0]?.userId).toBeNull();
    expect(consents[0]?.connectionId).toBeNull();
    expect(consents[0]?.subjectHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
