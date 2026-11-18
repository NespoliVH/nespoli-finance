import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { BlindIndexContext, blindIndex, encryptField } from "../../src/lib/crypto.js";
import { PluggyError } from "../../src/pluggy/client.js";
import { FakePluggy, MemoryQueue, testAuth } from "../fakes.js";
import { testKey, testPrisma } from "../helpers.js";

const prisma = testPrisma();
const fieldKey = testKey();
const blindKey = testKey();
const SECRET = "s".repeat(40);

let pluggy: FakePluggy;
let app: ReturnType<typeof buildApp>;

function makeApp() {
  return buildApp({
    prisma,
    logger: false,
    authenticate: testAuth,
    connections: { queue: new MemoryQueue(), fieldKey, blindKey, pluggy: { api: pluggy, webhookSecret: SECRET } },
  });
}

async function userWithConnection(itemId = `item-${Math.random()}`) {
  const user = await prisma.user.create({ data: { appleUserId: `apple-${Math.random()}`, name: "Ana" } });
  pluggy.addItem(itemId, user.id);
  const h = { "x-test-user": user.id };
  const res = await app.inject({ method: "POST", url: "/connections", headers: h, payload: { itemId, termsVersion: "1.0", appVersion: "1.0.0" } });
  expect(res.statusCode).toBe(201);
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id: res.json().id } });
  const account = await prisma.account.create({
    data: { connectionId: conn.id, userId: user.id, pluggyAccountId: `acc-${Math.random()}`, type: "checking", name: "Conta", balanceCents: 0n },
  });
  await prisma.transaction.create({
    data: { userId: user.id, accountId: account.id, pluggyTransactionId: `tx-${Math.random()}`, date: new Date("2026-11-05T00:00:00Z"), description: "X", direction: "debit", amountCents: 100n, categoryId: "outros" },
  });
  return { user, conn, itemId, h };
}

beforeEach(async () => {
  pluggy = new FakePluggy();
  app = makeApp();
  await prisma.consent.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await app.close();
  await prisma.consent.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
});

describe("ajustes e consentimentos (RF04, RNF13)", () => {
  it("mostra a conta e os consentimentos, com instituição e finalidade", async () => {
    const { h } = await userWithConnection();
    await app.inject({ method: "POST", url: "/consents/privacy-policy", headers: h, payload: { termsVersion: "1.0", appVersion: "1.0.0" } });

    expect((await app.inject({ method: "GET", url: "/me", headers: h })).json()).toMatchObject({
      name: "Ana",
      connectionsCount: 1,
      devicesCount: 0,
      hasTaxProfile: false,
    });
    const consents = (await app.inject({ method: "GET", url: "/consents", headers: h })).json().items;
    expect(consents).toEqual([
      expect.objectContaining({ type: "privacy_policy", action: "granted", termsVersion: "1.0" }),
      expect.objectContaining({ type: "bank_data_sharing", action: "granted", institutionName: "Pluggy Bank" }),
    ]);
    expect(consents[1].purpose).toContain("categorizar gastos");
  });

  it("não mostra consentimentos de outra pessoa", async () => {
    await userWithConnection();
    const outro = await prisma.user.create({ data: { appleUserId: `apple-${Math.random()}` } });
    expect((await app.inject({ method: "GET", url: "/consents", headers: { "x-test-user": outro.id } })).json().items).toEqual([]);
  });
});

describe("exclusão da conta (RF05, RNF12)", () => {
  it("apaga no Pluggy, grava as revogações e apaga os dados, mantendo a prova do consentimento", async () => {
    const { user, itemId, h } = await userWithConnection();
    await app.inject({ method: "POST", url: "/consents/privacy-policy", headers: h, payload: { termsVersion: "1.0", appVersion: "1.0.0" } });

    const res = await app.inject({ method: "DELETE", url: "/me", headers: h, payload: { confirm: "EXCLUIR" } });
    expect(res.statusCode).toBe(204);
    expect(pluggy.deleted).toEqual([itemId]);

    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
    expect(await prisma.connection.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0);

    // Sobra só o registro de consentimento, sem o id do usuário, achável pelo subjectHash.
    const subjectHash = blindIndex(user.id, blindKey, BlindIndexContext.consentSubject);
    const trail = await prisma.consent.findMany({ where: { subjectHash }, orderBy: { occurredAt: "asc" } });
    expect(trail.every((c) => c.userId === null)).toBe(true);
    expect(trail.map((c) => `${c.type}:${c.action}`).sort()).toEqual([
      "bank_data_sharing:granted",
      "bank_data_sharing:revoked",
      "privacy_policy:granted",
      "privacy_policy:revoked",
    ]);
  });

  it("exige a confirmação digitada", async () => {
    const { user, h } = await userWithConnection();
    const res = await app.inject({ method: "DELETE", url: "/me", headers: h, payload: { confirm: "sim" } });
    expect(res.statusCode).toBe(400);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
  });

  it("se o Pluggy falhar, não apaga nada e pede para tentar de novo", async () => {
    const { user, h } = await userWithConnection();
    pluggy.deleteItem = async () => {
      throw new PluggyError("fora do ar", 500);
    };
    const res = await app.inject({ method: "DELETE", url: "/me", headers: h, payload: { confirm: "EXCLUIR" } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "pluggy_unavailable", retry: true });
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
  });

  it("item que já sumiu do Pluggy não impede a exclusão", async () => {
    const { user, itemId, h } = await userWithConnection();
    pluggy.items.delete(itemId);
    pluggy.deleteItem = async () => {
      throw new PluggyError("not found", 404);
    };
    expect((await app.inject({ method: "DELETE", url: "/me", headers: h, payload: { confirm: "EXCLUIR" } })).statusCode).toBe(204);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
  });

  it("um usuário não apaga outro", async () => {
    const a = await userWithConnection();
    const b = await userWithConnection();
    await app.inject({ method: "DELETE", url: "/me", headers: a.h, payload: { confirm: "EXCLUIR" } });
    expect(await prisma.user.count({ where: { id: b.user.id } })).toBe(1);
    expect(await prisma.transaction.count({ where: { userId: b.user.id } })).toBe(1);
  });
});

describe("modo offline: revalidação com ETag (RNF15)", () => {
  it("responde 304 sem corpo quando nada mudou, e 200 quando mudou", async () => {
    const { h } = await userWithConnection();
    const first = await app.inject({ method: "GET", url: "/summary?month=2026-11", headers: h });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"/);
    expect(first.headers["cache-control"]).toBe("private, no-cache");

    const same = await app.inject({ method: "GET", url: "/summary?month=2026-11", headers: { ...h, "if-none-match": etag } });
    expect(same.statusCode).toBe(304);
    expect(same.body).toBe("");

    await prisma.transaction.updateMany({ data: { amountCents: 999n } });
    const changed = await app.inject({ method: "GET", url: "/summary?month=2026-11", headers: { ...h, "if-none-match": etag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it("não põe ETag em erro nem em escrita", async () => {
    expect((await app.inject({ method: "GET", url: "/summary" })).headers.etag).toBeUndefined();
    const { h } = await userWithConnection();
    const post = await app.inject({ method: "POST", url: "/consents/privacy-policy", headers: h, payload: { termsVersion: "1", appVersion: "1" } });
    expect(post.headers.etag).toBeUndefined();
  });
});
