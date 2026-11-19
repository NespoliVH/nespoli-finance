import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { makeRequireUser, type Authenticate } from "../http/auth.js";
import { isSpending } from "../rules/categorization.js";
import { currentMonth, dateOnly, MONTH_PATTERN, monthRange } from "./period.js";
import { spendingWhere } from "./spending.js";

// Resumo do mês e lista de transações (RF16 a RF22, RN07). A definição de
// gasto (RF19) fica em spending.ts, compartilhada com os alertas.

export interface TransactionDeps {
  prisma: PrismaClient;
  authenticate: Authenticate;
  now?: () => Date;
}

const CATEGORY_IDS = ["contas_fixas", "comida", "imprevistos", "outros"] as const;

const summaryQuery = z.object({ month: z.string().regex(MONTH_PATTERN).optional() });

const listQuery = z.object({
  month: z.string().regex(MONTH_PATTERN).optional(),
  categoryId: z.enum(CATEGORY_IDS).optional(),
  kind: z.enum(["all", "spending", "income"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

const idParams = z.object({ id: z.uuid() });
const categoryBody = z.object({
  categoryId: z.enum(CATEGORY_IDS),
  // RF18: vem desligado no app, para a correção pontual ser o padrão (etapa 4).
  applyToFuture: z.boolean().default(false),
  // Só vale com applyToFuture. O usuário escolhe se a regra também corrige as
  // compras antigas do estabelecimento; vem ligado, que foi o pedido da pessoa.
  includePast: z.boolean().default(true),
});

// Cursor da paginação: data e id da última transação da página, em base64url.
// Paginar "a partir da última vista" em vez de "pular N linhas" mantém a lista
// estável quando chegam transações novas enquanto o usuário rola a tela.
function encodeCursor(date: Date, id: string): string {
  return Buffer.from(`${dateOnly(date)}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { date: Date; id: string } | null {
  const [date, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!date || !id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !z.uuid().safeParse(id).success) return null;
  return { date: new Date(`${date}T00:00:00Z`), id };
}

type TransactionWithAccount = Prisma.TransactionGetPayload<{ include: { account: true } }>;

function serializeTransaction(t: TransactionWithAccount) {
  return {
    id: t.id,
    date: dateOnly(t.date),
    description: t.description,
    amountCents: Number(t.amountCents),
    direction: t.direction,
    status: t.status,
    isSpending: isSpending(t),
    isInternalTransfer: t.isInternalTransfer,
    isCardBillPayment: t.isCardBillPayment,
    categoryId: t.categoryId,
    categorySource: t.categorySource,
    taxableIncome: t.taxableIncome,
    deductibleType: t.deductibleType,
    incomeSource: t.incomeSource,
    account: { id: t.account.id, name: t.account.name, type: t.account.type, numberLast4: t.account.numberLast4 },
  };
}

export function registerTransactionRoutes(app: FastifyInstance, deps: TransactionDeps): void {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();
  const requireUser = makeRequireUser(deps.authenticate);

  // RF20 e RF21: total gasto e total por categoria no mês, em valor e percentual.
  app.get("/summary", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const q = summaryQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const range = monthRange(q.data.month ?? currentMonth(now()));

    const [categories, groups, connections, unreadAlerts] = await Promise.all([
      prisma.category.findMany({ orderBy: { displayOrder: "asc" } }),
      prisma.transaction.groupBy({
        by: ["categoryId"],
        where: { userId, date: { gte: range.start, lt: range.end }, ...spendingWhere },
        _sum: { amountCents: true },
        _count: true,
      }),
      prisma.connection.findMany({ where: { userId }, select: { status: true, lastSyncedAt: true } }),
      prisma.alert.count({ where: { userId, referenceMonth: range.start, readAt: null } }),
    ]);

    const byCategory = new Map(groups.map((g) => [g.categoryId, g]));
    const totalCents = groups.reduce((acc, g) => acc + Number(g._sum.amountCents ?? 0n), 0);
    const synced = connections.map((c) => c.lastSyncedAt).filter((d): d is Date => d !== null);

    return {
      month: range.month,
      totalCents,
      // As quatro categorias sempre aparecem, na ordem fixa, mesmo com zero.
      categories: categories.map((c) => {
        const g = byCategory.get(c.id);
        const cents = Number(g?._sum.amountCents ?? 0n);
        return {
          id: c.id,
          name: c.name,
          icon: c.icon,
          totalCents: cents,
          count: g?._count ?? 0,
          // Percentual em pontos-base (4235 = 42,35%), inteiro como o resto do dinheiro.
          percentBasisPoints: totalCents === 0 ? 0 : Math.round((cents * 10_000) / totalCents),
        };
      }),
      unreadAlerts,
      connections: {
        count: connections.length,
        // Primeira importação ainda em andamento: a tela mostra a barra de progresso (etapa 4).
        importing: connections.some((c) => c.lastSyncedAt === null && c.status !== "login_error" && c.status !== "consent_expired"),
        // "Atualizado há": a conexão mais antiga, para não prometer dados mais novos do que são.
        oldestSyncAt: synced.length ? new Date(Math.min(...synced.map((d) => d.getTime()))) : null,
      },
    };
  });

  // RF22: transações do mês, com filtro por categoria, do mais recente para o mais antigo.
  app.get("/transactions", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const q = listQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const { categoryId, kind, limit, cursor } = q.data;
    const range = monthRange(q.data.month ?? currentMonth(now()));

    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) return reply.code(400).send({ error: "invalid_cursor" });

    const where: Prisma.TransactionWhereInput = {
      userId,
      date: { gte: range.start, lt: range.end },
      ...(kind === "spending" || categoryId ? spendingWhere : {}),
      ...(kind === "income" ? { direction: "credit" } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(after ? { OR: [{ date: { lt: after.date } }, { date: after.date, id: { lt: after.id } }] } : {}),
    };

    const rows = await prisma.transaction.findMany({
      where,
      include: { account: true },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: limit + 1, // um a mais só para saber se existe próxima página
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(serializeTransaction),
      nextCursor: rows.length > limit && last ? encodeCursor(last.date, last.id) : null,
    };
  });

  // RF16 a RF18: o usuário corrige a categoria. A correção fica marcada como
  // manual e nenhuma sincronização a desfaz (RF17). Com applyToFuture, cria
  // ou troca a regra do estabelecimento, que vale para as próximas compras.
  // Com includePast (padrão), a regra também recategoriza as compras antigas
  // do mesmo estabelecimento. As que o usuário corrigiu uma a uma ficam como
  // estão: uma correção manual vale mais que a regra (RF17).
  app.patch("/transactions/:id/category", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = categoryBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { categoryId, applyToFuture, includePast } = body.data;

    // Filtrar pelo dono na própria busca: transação de outra pessoa responde
    // 404, igual a uma que não existe.
    const tx = await prisma.transaction.findFirst({ where: { id: params.data.id, userId } });
    if (!tx) return reply.code(404).send({ error: "not_found" });
    // Entradas, transferências próprias e pagamento de fatura não têm categoria de gasto.
    if (!isSpending(tx)) return reply.code(422).send({ error: "not_spending" });

    const createRule = applyToFuture && tx.merchantKey !== null;
    const recategorizePast = createRule && includePast;
    const [updated, ...rest] = await prisma.$transaction([
      prisma.transaction.update({
        where: { id: tx.id },
        data: { categoryId, categorySource: "manual" },
        include: { account: true },
      }),
      ...(createRule
        ? [
            prisma.categoryRule.upsert({
              where: { userId_merchantKey: { userId, merchantKey: tx.merchantKey! } },
              create: { userId, merchantKey: tx.merchantKey!, categoryId },
              update: { categoryId },
            }),
          ]
        : []),
      ...(recategorizePast
        ? [
            prisma.transaction.updateMany({
              where: {
                userId,
                merchantKey: tx.merchantKey!,
                id: { not: tx.id },
                ...spendingWhere,
                OR: [{ categorySource: null }, { categorySource: { not: "manual" } }],
              },
              data: { categoryId, categorySource: "user_rule" },
            }),
          ]
        : []),
    ]);
    const past = rest.at(-1);
    const recategorizedCount = recategorizePast && past && "count" in past ? past.count : 0;
    return { transaction: serializeTransaction(updated as TransactionWithAccount), ruleCreated: createRule, recategorizedCount };
  });
}
