import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { Jobs } from "../jobs/queue.js";
import { BlindIndexContext, blindIndex, decryptField, encryptField, safeEqualText } from "../lib/crypto.js";
import { makeRequireUser, type Authenticate } from "../http/auth.js";
import { PluggyError, type PluggyApi } from "../pluggy/client.js";
import { connectionStatusFromItem } from "../pluggy/mapping.js";

// Rotas de conexão bancária (RF06 a RF14) e o webhook do Pluggy.

export interface ConnectionDeps {
  prisma: PrismaClient;
  queue: JobQueue;
  authenticate: Authenticate;
  fieldKey: Buffer;
  blindKey: Buffer;
  pluggy: { api: PluggyApi; webhookSecret: string; webhookUrl?: string } | null;
  now?: () => Date;
}

// Texto da finalidade gravado em cada consentimento (LGPD, art. 8º e 9º).
export const BANK_DATA_PURPOSE =
  "Ler saldos e transações das contas escolhidas para categorizar gastos, gerar alertas e estimar o IR no app Nespoli Finance.";

const createBody = z.object({
  itemId: z.string().min(1).max(100),
  termsVersion: z.string().min(1).max(20),
  appVersion: z.string().min(1).max(20),
});
const reconnectedBody = createBody.omit({ itemId: true });
const connectTokenBody = z.object({ connectionId: z.uuid().optional() }).optional();
const idParams = z.object({ id: z.uuid() });

// Só os campos usados; o resto do corpo do webhook é ignorado.
const webhookBody = z.object({
  event: z.string(),
  itemId: z.string().optional(),
  transactionIds: z.array(z.string()).optional(),
});

export function registerConnectionRoutes(app: FastifyInstance, deps: ConnectionDeps): void {
  const { prisma, queue, fieldKey, blindKey } = deps;
  const now = () => deps.now?.() ?? new Date();

  const requireUser = makeRequireUser(deps.authenticate);

  function requirePluggy(reply: FastifyReply) {
    if (!deps.pluggy) {
      void reply.code(503).send({ error: "pluggy_not_configured" });
      return null;
    }
    return deps.pluggy;
  }

  // RF08: o app pede um token de curta duração para abrir o Pluggy Connect.
  // As credenciais do Pluggy ficam só aqui no backend (RNF02).
  app.post("/connections/connect-token", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const pluggy = requirePluggy(reply);
    if (!pluggy) return;
    const body = connectTokenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    // Com connectionId, o token serve para renovar o consentimento ou corrigir o login de uma conexão existente.
    let itemId: string | undefined;
    if (body.data?.connectionId) {
      const conn = await prisma.connection.findFirst({ where: { id: body.data.connectionId, userId } });
      if (!conn) return reply.code(404).send({ error: "not_found" });
      itemId = decryptField(conn.pluggyItemIdEnc, fieldKey);
    }
    const accessToken = await pluggy.api.createConnectToken({ clientUserId: userId, webhookUrl: pluggy.webhookUrl, itemId });
    // O Pluggy Connect só abre no modo "atualizar" se receber o id do item.
    // Ele é do próprio usuário, então pode ir para o app só nesse caso.
    return itemId ? { accessToken, updateItem: itemId } : { accessToken };
  });

  // RF06 e RF07: depois que o usuário conecta o banco no Pluggy Connect, o app
  // manda o id do item e a versão dos termos aceitos. A conexão e o registro
  // de consentimento são gravados juntos, numa única transação do banco.
  app.post("/connections", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const pluggy = requirePluggy(reply);
    if (!pluggy) return;
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { itemId, termsVersion, appVersion } = body.data;

    let item;
    try {
      item = await pluggy.api.getItem(itemId);
    } catch (err) {
      if (err instanceof PluggyError && err.status === 404) return reply.code(404).send({ error: "item_not_found" });
      throw err;
    }
    // O item precisa ter sido criado com o token deste usuário. Sem essa
    // conferência, alguém que descobrisse o id do item de outra pessoa
    // poderia ligá-lo à própria conta.
    if (item.clientUserId !== userId) return reply.code(403).send({ error: "item_not_owned" });

    const itemHash = blindIndex(itemId, blindKey, BlindIndexContext.pluggyItem);
    const existing = await prisma.connection.findUnique({ where: { pluggyItemIdHash: itemHash } });
    if (existing) return reply.code(409).send({ error: "already_connected", id: existing.id });

    const connection = await prisma.$transaction(async (tx) => {
      const conn = await tx.connection.create({
        data: {
          userId,
          pluggyItemIdEnc: encryptField(itemId, fieldKey),
          pluggyItemIdHash: itemHash,
          institutionName: item.connector.name,
          status: connectionStatusFromItem(item, now()),
          consentExpiresAt: item.consentExpiresAt ?? null,
        },
      });
      await tx.consent.create({
        data: {
          userId,
          subjectHash: blindIndex(userId, blindKey, BlindIndexContext.consentSubject),
          connectionId: conn.id,
          type: "bank_data_sharing",
          action: "granted",
          termsVersion,
          purpose: BANK_DATA_PURPOSE,
          appVersion,
        },
      });
      return conn;
    });

    await queue.send(Jobs.syncConnection, { connectionId: connection.id });
    return reply.code(201).send({ id: connection.id, institutionName: connection.institutionName, status: connection.status });
  });

  // RF09: lista as conexões do usuário com as contas e o estado de cada uma.
  app.get("/connections", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const connections = await prisma.connection.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: { accounts: { orderBy: { name: "asc" } } },
    });
    return connections.map((c) => ({
      id: c.id,
      institutionName: c.institutionName,
      status: c.status,
      consentExpiresAt: c.consentExpiresAt,
      lastSyncedAt: c.lastSyncedAt,
      accounts: c.accounts.map((a) => ({
        id: a.id,
        type: a.type,
        name: a.name,
        numberLast4: a.numberLast4, // o número completo nunca sai do backend
        balanceCents: Number(a.balanceCents),
      })),
    }));
  });

  // RF11: atualização manual. Só agenda; se já houver uma sincronização
  // esperando na fila para a conexão, a fila descarta o pedido repetido.
  app.post("/connections/:id/sync", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    if (!requirePluggy(reply)) return;
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const conn = await prisma.connection.findFirst({ where: { id: params.data.id, userId } });
    if (!conn) return reply.code(404).send({ error: "not_found" });
    await queue.send(Jobs.syncConnection, { connectionId: conn.id });
    return reply.code(202).send({ queued: true });
  });

  // RF12: depois de reconectar um banco (login corrigido ou consentimento
  // renovado no Pluggy Connect), o app avisa aqui. Grava um novo registro de
  // consentimento, porque o usuário aceitou de novo, e agenda a sincronização.
  app.post("/connections/:id/reconnected", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    if (!requirePluggy(reply)) return;
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = reconnectedBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const conn = await prisma.connection.findFirst({ where: { id: params.data.id, userId } });
    if (!conn) return reply.code(404).send({ error: "not_found" });

    await prisma.$transaction([
      prisma.consent.create({
        data: {
          userId,
          subjectHash: blindIndex(userId, blindKey, BlindIndexContext.consentSubject),
          connectionId: conn.id,
          type: "bank_data_sharing",
          action: "granted",
          termsVersion: body.data.termsVersion,
          purpose: BANK_DATA_PURPOSE,
          appVersion: body.data.appVersion,
        },
      }),
      prisma.connection.update({ where: { id: conn.id }, data: { status: "updating" } }),
    ]);
    await queue.send(Jobs.syncConnection, { connectionId: conn.id });
    return reply.code(202).send({ queued: true });
  });

  // RF13: desconectar um banco. Apaga o item no Pluggy, grava a revogação
  // e exclui a conexão; contas e transações saem junto (exclusão em cascata).
  app.delete("/connections/:id", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const pluggy = requirePluggy(reply);
    if (!pluggy) return;
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });

    const conn = await prisma.connection.findFirst({ where: { id: params.data.id, userId } });
    if (!conn) return reply.code(404).send({ error: "not_found" });

    try {
      await pluggy.api.deleteItem(decryptField(conn.pluggyItemIdEnc, fieldKey));
    } catch (err) {
      // Item que já não existe no Pluggy não impede a exclusão aqui.
      if (!(err instanceof PluggyError && err.status === 404)) throw err;
    }

    const lastGrant = await prisma.consent.findFirst({
      where: { connectionId: conn.id, action: "granted" },
      orderBy: { occurredAt: "desc" },
    });
    await prisma.$transaction([
      prisma.consent.create({
        data: {
          userId,
          subjectHash: blindIndex(userId, blindKey, BlindIndexContext.consentSubject),
          connectionId: conn.id,
          type: "bank_data_sharing",
          action: "revoked",
          termsVersion: lastGrant?.termsVersion ?? "desconhecida",
          purpose: BANK_DATA_PURPOSE,
          appVersion: lastGrant?.appVersion ?? "desconhecida",
        },
      }),
      prisma.connection.delete({ where: { id: conn.id } }),
    ]);
    return reply.code(204).send();
  });

  // Webhook do Pluggy. O segredo no caminho da URL prova que a chamada veio de
  // quem recebeu a URL (só o Pluggy). Mesmo assim o corpo não é confiável:
  // ele só diz "olhe o item X", e os dados são sempre buscados na API.
  app.post("/webhooks/pluggy/:secret", async (req, reply) => {
    const pluggy = deps.pluggy;
    const secret = (req.params as { secret?: string }).secret ?? "";
    if (!pluggy || !safeEqualText(secret, pluggy.webhookSecret)) return reply.code(404).send();

    const body = webhookBody.safeParse(req.body);
    if (!body.success || !body.data.itemId) return reply.code(200).send({ ignored: true });
    const { event, itemId, transactionIds } = body.data;

    const itemHash = blindIndex(itemId, blindKey, BlindIndexContext.pluggyItem);
    const conn = await prisma.connection.findUnique({ where: { pluggyItemIdHash: itemHash } });
    // Item desconhecido responde 200 do mesmo jeito: o Pluggy não precisa reenviar,
    // e quem estiver testando ids não descobre quais existem.
    if (!conn) return reply.code(200).send({ ignored: true });

    switch (event) {
      case "item/deleted":
        await prisma.connection.update({ where: { id: conn.id }, data: { status: "revoked" } });
        break;
      case "transactions/deleted":
        if (transactionIds?.length) {
          await queue.send(Jobs.deleteTransactions, { connectionId: conn.id, pluggyTransactionIds: transactionIds });
        }
        break;
      default:
        // item/created, item/updated, item/error, item/login_succeeded,
        // item/waiting_user_*, transactions/created e transactions/updated:
        // em todos, o certo é reler o item e sincronizar.
        await queue.send(Jobs.syncConnection, { connectionId: conn.id });
    }
    return reply.code(200).send({ received: true });
  });
}
