import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "../db.js";
import { makeRequireUser, type Authenticate } from "../http/auth.js";
import { dateOnly } from "../transactions/period.js";

// Tela de alertas (RF24) e registro do aparelho para a notificação.

export interface AlertDeps {
  prisma: PrismaClient;
  authenticate: Authenticate;
  now?: () => Date;
}

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
// Token do APNs: 64 caracteres hexadecimais hoje; a Apple diz que pode crescer.
const deviceBody = z.object({
  apnsToken: z.string().regex(/^[0-9a-fA-F]{64,200}$/),
  showAmountsInPush: z.boolean().default(false),
});
const devicePrefsBody = z.object({ showAmountsInPush: z.boolean() });

export function registerAlertRoutes(app: FastifyInstance, deps: AlertDeps): void {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();
  const requireUser = makeRequireUser(deps.authenticate);

  // Alertas do mais novo para o mais antigo, com tudo que a tela mostra.
  app.get("/alerts", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const q = listQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const alerts = await prisma.alert.findMany({
      where: { userId },
      include: { category: true },
      orderBy: [{ referenceMonth: "desc" }, { createdAt: "desc" }],
      take: q.data.limit,
    });
    return {
      items: alerts.map((a) => ({
        id: a.id,
        month: dateOnly(a.referenceMonth).slice(0, 7),
        category: { id: a.category.id, name: a.category.name, icon: a.category.icon },
        currentCents: Number(a.currentCents),
        averageCents: Number(a.averageCents),
        increasePct: Number(a.increasePct),
        read: a.readAt !== null,
        createdAt: a.createdAt,
      })),
    };
  });

  // Marcar um alerta como lido. Alerta de outra pessoa responde 404, igual a um que não existe.
  app.post("/alerts/:id/read", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const res = await prisma.alert.updateMany({
      where: { id: params.data.id, userId, readAt: null },
      data: { readAt: now() },
    });
    if (res.count === 0) {
      const exists = await prisma.alert.count({ where: { id: params.data.id, userId } });
      if (!exists) return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(204).send();
  });

  app.post("/alerts/read-all", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const res = await prisma.alert.updateMany({ where: { userId, readAt: null }, data: { readAt: now() } });
    return { marked: res.count };
  });

  // O app manda o token do APNs a cada abertura; o mesmo token de novo só
  // atualiza. Se o aparelho trocar de dono (outra conta no mesmo iPhone), o
  // token passa para o usuário novo, para o antigo não receber avisos alheios.
  app.put("/devices", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const body = deviceBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { apnsToken, showAmountsInPush } = body.data;
    const device = await prisma.device.upsert({
      where: { apnsToken },
      create: { userId, apnsToken, showAmountsInPush },
      update: { userId, showAmountsInPush },
    });
    return { id: device.id, showAmountsInPush: device.showAmountsInPush };
  });

  // Preferência "mostrar valores na notificação", por aparelho.
  app.patch("/devices/:id", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = devicePrefsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const res = await prisma.device.updateMany({
      where: { id: params.data.id, userId },
      data: { showAmountsInPush: body.data.showAmountsInPush },
    });
    if (res.count === 0) return reply.code(404).send({ error: "not_found" });
    return { id: params.data.id, showAmountsInPush: body.data.showAmountsInPush };
  });
}
