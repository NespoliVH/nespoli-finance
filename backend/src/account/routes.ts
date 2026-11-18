import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BANK_DATA_PURPOSE, type ConnectionDeps } from "../connections/routes.js";
import type { PrismaClient } from "../db.js";
import { makeRequireUser, type Authenticate } from "../http/auth.js";
import { BlindIndexContext, blindIndex, decryptField } from "../lib/crypto.js";
import { PluggyError } from "../pluggy/client.js";

// Conta e privacidade (RF04, RF05, RNF12, RNF13).

export interface AccountDeps {
  prisma: PrismaClient;
  authenticate: Authenticate;
  fieldKey: Buffer;
  blindKey: Buffer;
  pluggy: ConnectionDeps["pluggy"];
}

export const PRIVACY_PURPOSE =
  "Usar os dados da conta e das transações para as funções do app Nespoli Finance, conforme a política de privacidade.";

const privacyBody = z.object({
  termsVersion: z.string().min(1).max(20),
  appVersion: z.string().min(1).max(20),
  action: z.enum(["granted", "revoked"]).default("granted"),
});

// Para excluir, o app manda a palavra digitada pelo usuário. Evita que uma
// chamada errada (ou um toque sem querer) apague tudo.
const deleteBody = z.object({ confirm: z.literal("EXCLUIR") });

export function registerAccountRoutes(app: FastifyInstance, deps: AccountDeps): void {
  const { prisma, fieldKey, blindKey } = deps;
  const requireUser = makeRequireUser(deps.authenticate);
  const subjectHash = (userId: string) => blindIndex(userId, blindKey, BlindIndexContext.consentSubject);

  // Tela de ajustes: o básico da conta e quantas conexões e aparelhos existem.
  app.get("/me", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { _count: { select: { connections: true, devices: true } }, taxProfile: { select: { userId: true } } },
    });
    if (!user) return reply.code(404).send({ error: "not_found" });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      connectionsCount: user._count.connections,
      devicesCount: user._count.devices,
      hasTaxProfile: user.taxProfile !== null,
    };
  });

  // RF04: os consentimentos dados e revogados, do mais novo para o mais antigo.
  app.get("/consents", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const consents = await prisma.consent.findMany({
      where: { userId },
      include: { connection: { select: { institutionName: true } } },
      orderBy: { occurredAt: "desc" },
    });
    return {
      items: consents.map((c) => ({
        id: c.id,
        type: c.type,
        action: c.action,
        purpose: c.purpose,
        termsVersion: c.termsVersion,
        occurredAt: c.occurredAt,
        // Conexão já excluída fica sem nome: o registro continua, a conexão não.
        institutionName: c.connection?.institutionName ?? null,
      })),
    };
  });

  // RNF13: aceite (ou revogação) da política de privacidade, gravado como os
  // demais consentimentos, só com inserções.
  app.post("/consents/privacy-policy", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const body = privacyBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const c = await prisma.consent.create({
      data: {
        userId,
        subjectHash: subjectHash(userId),
        type: "privacy_policy",
        action: body.data.action,
        termsVersion: body.data.termsVersion,
        purpose: PRIVACY_PURPOSE,
        appVersion: body.data.appVersion,
      },
    });
    return reply.code(201).send({ id: c.id, occurredAt: c.occurredAt });
  });

  // RF05 e RNF12: exclusão da conta.
  //   1. apaga cada item no Pluggy; se algum falhar, para e nada é apagado
  //      aqui, para o usuário tentar de novo sem deixar dados no Pluggy
  //   2. grava a revogação de cada consentimento ainda ativo
  //   3. apaga o usuário; o resto sai em cascata
  // Os registros de consentimento ficam, sem o id do usuário (vira nulo) e só
  // com o subjectHash, como prova de que houve consentimento e revogação (LGPD, art. 8º).
  app.delete("/me", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const body = deleteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "confirmation_required" });

    const connections = await prisma.connection.findMany({ where: { userId } });
    if (connections.length > 0 && !deps.pluggy) return reply.code(503).send({ error: "pluggy_not_configured" });
    for (const conn of connections) {
      try {
        await deps.pluggy!.api.deleteItem(decryptField(conn.pluggyItemIdEnc, fieldKey));
      } catch (err) {
        if (!(err instanceof PluggyError && err.status === 404)) {
          req.log.error({ connectionId: conn.id }, "falha ao apagar item no Pluggy na exclusão da conta");
          return reply.code(502).send({ error: "pluggy_unavailable", retry: true });
        }
      }
    }

    // O que está concedido agora: o último registro de cada (tipo, conexão) é "granted".
    const all = await prisma.consent.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } });
    const latest = new Map<string, (typeof all)[number]>();
    for (const c of all) latest.set(`${c.type}|${c.connectionId ?? ""}`, c);
    const toRevoke = [...latest.values()].filter((c) => c.action === "granted");

    await prisma.$transaction([
      ...toRevoke.map((c) =>
        prisma.consent.create({
          data: {
            userId,
            subjectHash: c.subjectHash,
            connectionId: c.connectionId,
            type: c.type,
            action: "revoked",
            termsVersion: c.termsVersion,
            purpose: c.type === "bank_data_sharing" ? BANK_DATA_PURPOSE : c.purpose,
            appVersion: c.appVersion,
          },
        }),
      ),
      // Desliga os registros do usuário e das conexões antes de apagar. Deixar
      // para o "ON DELETE SET NULL" falha no Postgres, porque o mesmo registro
      // seria alterado por dois caminhos de cascata ao mesmo tempo.
      prisma.consent.updateMany({ where: { userId }, data: { userId: null, connectionId: null } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);
    return reply.code(204).send();
  });
}
