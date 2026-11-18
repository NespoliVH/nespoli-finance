// Teste de ponta a ponta contra o sandbox real do Pluggy (conector "Pluggy Bank").
// Usa o banco de TESTE, o cliente e as rotas do backend; só a criação do item,
// que no app real é feita pelo Pluggy Connect, é chamada direto na API.
// Uso: npx tsx scripts/sandbox-e2e.ts  (precisa de PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET)
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { syncConnection } from "../src/connections/sync.js";
import { createPrisma } from "../src/db.js";
import { PluggyClient } from "../src/pluggy/client.js";
import type { JobQueue } from "../src/jobs/queue.js";

const { PLUGGY_CLIENT_ID: clientId, PLUGGY_CLIENT_SECRET: clientSecret, TEST_DATABASE_URL } = process.env;
if (!clientId || !clientSecret || !TEST_DATABASE_URL || !new URL(TEST_DATABASE_URL).pathname.endsWith("_test")) throw new Error("Faltam variáveis");
const baseUrl = "https://api.pluggy.ai";

const prisma = createPrisma(TEST_DATABASE_URL);
const pluggy = new PluggyClient({ baseUrl, clientId, clientSecret });
const fieldKey = randomBytes(32);
const blindKey = randomBytes(32);
const jobs: unknown[] = [];
const queue: JobQueue = { send: async (name, data) => void jobs.push({ name, data }) };

async function apiKey() {
  const r = await fetch(`${baseUrl}/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }) });
  return ((await r.json()) as { apiKey: string }).apiKey;
}

const log = (label: string, value: unknown) => console.log(`- ${label}:`, typeof value === "string" ? value : JSON.stringify(value));

const user = await prisma.user.create({ data: { appleUserId: `sandbox-${Date.now()}` } });
const app = buildApp({
  prisma,
  logger: false,
  authenticate: async () => user.id,
  connections: { queue, fieldKey, blindKey, pluggy: { api: pluggy, webhookSecret: "x".repeat(32) } },
});
let itemId: string | undefined;

try {
  // 1. token do Connect pelas rotas do backend
  const tokenRes = await app.inject({ method: "POST", url: "/connections/connect-token" });
  log("POST /connections/connect-token", { status: tokenRes.statusCode, temToken: typeof tokenRes.json().accessToken === "string" });

  // 2. o que o Pluggy Connect faria: cria o item com as credenciais de teste do Pluggy Bank
  const key = await apiKey();
  const created = await fetch(`${baseUrl}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": key },
    body: JSON.stringify({ connectorId: 2, parameters: { user: "user-ok", password: "password-ok" }, clientUserId: user.id }),
  });
  const createdBody = (await created.json()) as { id: string; status: string };
  itemId = createdBody.id;
  log("item criado no sandbox", { http: created.status, status: createdBody.status });

  // 3. espera o Pluggy terminar a coleta
  let item = await pluggy.getItem(itemId);
  for (let i = 0; i < 60 && item.status === "UPDATING"; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    item = await pluggy.getItem(itemId);
  }
  log("item depois da coleta", { status: item.status, executionStatus: item.executionStatus, banco: item.connector.name, donoConfere: item.clientUserId === user.id });

  // 4. o app registra a conexão (com consentimento)
  const conn = await app.inject({ method: "POST", url: "/connections", payload: { itemId, termsVersion: "1.0", appVersion: "0.1.0" } });
  log("POST /connections", { status: conn.statusCode, body: conn.json() });
  const connectionId = conn.json().id as string;

  // 5. sincroniza duas vezes: a segunda não pode criar nada
  const first = await syncConnection({ prisma, pluggy, fieldKey }, connectionId);
  log("primeira sincronização", first);
  const second = await syncConnection({ prisma, pluggy, fieldKey }, connectionId);
  log("segunda sincronização", second);

  const accounts = await prisma.account.findMany({ where: { userId: user.id } });
  log("contas", accounts.map((a) => ({ tipo: a.type, nome: a.name, final: a.numberLast4, saldo: Number(a.balanceCents) / 100 })));

  const byCat = await prisma.transaction.groupBy({ by: ["categoryId", "categorySource"], where: { userId: user.id }, _count: true });
  log("transações por categoria", byCat.map((g) => `${g.categoryId ?? "sem categoria"}/${g.categorySource ?? "-"}: ${g._count}`));
  const flags = await prisma.transaction.groupBy({ by: ["direction", "isInternalTransfer", "isCardBillPayment"], where: { userId: user.id }, _count: true });
  log("direção e marcações", flags);
  const pluggyCats = await prisma.transaction.groupBy({ by: ["pluggyCategory"], where: { userId: user.id }, _count: true, orderBy: { _count: { pluggyCategory: "desc" } } });
  log("categorias do Pluggy vistas", pluggyCats.map((g) => `${g.pluggyCategory ?? "nula"}: ${g._count}`));
  const range = await prisma.transaction.aggregate({ where: { userId: user.id }, _min: { date: true }, _max: { date: true } });
  log("datas", { de: range._min.date, ate: range._max.date });

  // 6. nomes oficiais das categorias que marcam o que não é gasto
  const cats = (await (await fetch(`${baseUrl}/categories`, { headers: { "X-API-KEY": key } })).json()) as { results: Array<{ id: string; description: string; parentDescription?: string }> };
  log("categorias de transferência própria e fatura", cats.results.filter((c) => /same person|credit card payment/i.test(c.description)).map((c) => `${c.id} ${c.description}`));
  log("total de categorias do Pluggy", cats.results.length);

  // 7. revoga: apaga o item no Pluggy e os dados aqui
  const del = await app.inject({ method: "DELETE", url: `/connections/${connectionId}` });
  log("DELETE /connections/:id", { status: del.statusCode, contasRestantes: await prisma.account.count({ where: { userId: user.id } }) });
  itemId = undefined;
  const consents = await prisma.consent.findMany({ where: { userId: user.id }, orderBy: { occurredAt: "asc" } });
  log("consentimentos", consents.map((c) => c.action));
} finally {
  if (itemId) await pluggy.deleteItem(itemId).catch(() => undefined);
  await prisma.consent.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await app.close();
  await prisma.$disconnect();
}
