import type { PrismaClient } from "../db.js";
import { evaluateAlert, ALERT_RULE } from "../rules/alerts.js";
import type { Cents } from "../rules/money.js";
import { currentMonth, monthRange, type MonthRange } from "../transactions/period.js";
import { spendingWhere } from "../transactions/spending.js";

// Avaliação dos alertas de um usuário (RF23), depois de cada sincronização.
//
// Para cada categoria, compara o gasto do mês corrente com os meses completos
// anteriores e aplica a regra pura de rules/alerts.ts (RN02 e RN03). Quem
// garante no máximo um alerta por categoria por mês (RN04) é a chave única do
// banco: gravar de novo o mesmo alerta não faz nada.

export interface NewAlert {
  id: string;
  userId: string;
  categoryId: string;
  categoryName: string;
  referenceMonth: string;
  currentCents: Cents;
  averageCents: Cents;
  increasePct: number;
}

function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

async function spendingByCategory(prisma: PrismaClient, userId: string, range: MonthRange): Promise<Map<string, Cents>> {
  const groups = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: { userId, date: { gte: range.start, lt: range.end }, ...spendingWhere },
    _sum: { amountCents: true },
  });
  return new Map(
    groups.filter((g) => g.categoryId !== null).map((g) => [g.categoryId!, Number(g._sum.amountCents ?? 0n)]),
  );
}

/**
 * Meses completos anteriores que contam como histórico, do mais recente para
 * o mais antigo. Um mês só conta se o app já tinha dados dele: a partir do mês
 * da transação mais antiga do usuário. A primeira importação começa no dia 1º
 * desse mês, então ele vem inteiro. Mês sem gasto na categoria conta como zero,
 * porque não gastar também é histórico.
 */
function historyMonths(month: string, earliest: Date | null): MonthRange[] {
  if (!earliest) return [];
  const firstMonth = earliest.toISOString().slice(0, 7);
  const months: MonthRange[] = [];
  let m = previousMonth(month);
  while (months.length < ALERT_RULE.historyMonths && m >= firstMonth) {
    months.push(monthRange(m));
    m = previousMonth(m);
  }
  return months;
}

/** Avalia o mês corrente e devolve só os alertas criados agora (para a notificação). */
export async function evaluateUserAlerts(prisma: PrismaClient, userId: string, now: Date): Promise<NewAlert[]> {
  const month = monthRange(currentMonth(now));
  const earliest = await prisma.transaction.findFirst({
    where: { userId },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  const history = historyMonths(month.month, earliest?.date ?? null);
  if (history.length < ALERT_RULE.minHistoryMonths) return [];

  const [current, ...previous] = await Promise.all([
    spendingByCategory(prisma, userId, month),
    ...history.map((r) => spendingByCategory(prisma, userId, r)),
  ]);
  const categories = await prisma.category.findMany({ orderBy: { displayOrder: "asc" } });

  const created: NewAlert[] = [];
  for (const category of categories) {
    const currentCents = current!.get(category.id) ?? 0;
    const decision = evaluateAlert(
      currentCents,
      previous.map((p) => p.get(category.id) ?? 0),
    );
    if (!decision.alert) continue;

    const key = { userId, categoryId: category.id, referenceMonth: month.start };
    const res = await prisma.alert.createManyAndReturn({
      // Alerta que já existe neste mês é descartado em silêncio, e não volta na
      // resposta; assim só o alerta novo é notificado (RN04).
      skipDuplicates: true,
      data: [
        {
          ...key,
          currentCents: BigInt(decision.currentCents),
          averageCents: BigInt(decision.averageCents),
          increasePct: decision.increasePct,
        },
      ],
    });
    for (const a of res) {
      created.push({
        id: a.id,
        userId,
        categoryId: category.id,
        categoryName: category.name,
        referenceMonth: month.month,
        currentCents: decision.currentCents,
        averageCents: decision.averageCents,
        increasePct: decision.increasePct,
      });
    }
  }
  return created;
}
