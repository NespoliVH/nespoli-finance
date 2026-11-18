import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadTaxConfig } from "../config/tax/index.js";
import type { PrismaClient } from "../db.js";
import { makeRequireUser, type Authenticate } from "../http/auth.js";
import { isSalaryLike } from "../rules/income.js";
import type { Cents } from "../rules/money.js";
import { estimateIncomeTax, monthlyReserve, monthsUntilDeadline, type TaxYearConfig } from "../rules/tax.js";
import { brazilDate } from "../pluggy/mapping.js";
import { spendingWhere } from "../transactions/spending.js";

// Estimativa de IR (RF25 a RF27, RN05, RN06).
//
// O cálculo em si é a função pura do módulo 2 (rules/tax.ts). Aqui o backend
// junta as entradas dela: o perfil fiscal, os rendimentos que o usuário
// confirmou e as despesas que ele marcou como dedutíveis.

export interface TaxDeps {
  prisma: PrismaClient;
  authenticate: Authenticate;
  now?: () => Date;
  /** Os testes trocam a tabela; no app, vem do arquivo do ano (RN06). */
  loadConfig?: (year: number) => TaxYearConfig;
}

export const TAX_DISCLAIMER =
  "Estimativa aproximada, feita com os dados do app. Não é cálculo oficial e não substitui a declaração à Receita Federal.";

const MAX_CENTS = 100_000_000_00; // R$ 100 milhões: só para barrar valor digitado errado

const profileBody = z.object({
  grossMonthlySalaryCents: z.number().int().min(0).max(MAX_CENTS),
  withheldMonthlyCents: z.number().int().min(0).max(MAX_CENTS).nullable().default(null),
  dependentsCount: z.number().int().min(0).max(20).default(0),
});

const idParams = z.object({ id: z.uuid() });
const markBody = z
  .object({
    // RF25: confirmar ou recusar a sugestão de rendimento.
    taxableIncome: z.enum(["confirmed", "no"]).optional(),
    // RF26: marcar ou desmarcar despesa dedutível.
    deductibleType: z.enum(["health", "education", "pension"]).nullable().optional(),
  })
  .refine((b) => b.taxableIncome !== undefined || b.deductibleType !== undefined, { message: "nada para mudar" });

/** A tabela do ano só vale como oficial quando todos os blocos foram conferidos (RN06). */
function isVerified(config: TaxYearConfig): boolean {
  return Object.values(config as unknown as Record<string, unknown>).every(
    (v) => typeof v !== "object" || v === null || Array.isArray(v) || (v as { verifiedOfficial?: boolean }).verifiedOfficial !== false,
  );
}

function sumCents(rows: { amountCents: bigint }[]): Cents {
  return rows.reduce((acc, r) => acc + Number(r.amountCents), 0);
}

export function registerTaxRoutes(app: FastifyInstance, deps: TaxDeps): void {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();
  const loadConfig = deps.loadConfig ?? loadTaxConfig;
  const requireUser = makeRequireUser(deps.authenticate);

  app.get("/tax/profile", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const p = await prisma.taxProfile.findUnique({ where: { userId } });
    if (!p) return reply.code(404).send({ error: "profile_not_found" });
    return {
      grossMonthlySalaryCents: Number(p.grossMonthlySalaryCents),
      withheldMonthlyCents: p.withheldMonthlyCents === null ? null : Number(p.withheldMonthlyCents),
      dependentsCount: p.dependentsCount,
    };
  });

  app.put("/tax/profile", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const body = profileBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const data = {
      grossMonthlySalaryCents: BigInt(body.data.grossMonthlySalaryCents),
      withheldMonthlyCents: body.data.withheldMonthlyCents === null ? null : BigInt(body.data.withheldMonthlyCents),
      dependentsCount: body.data.dependentsCount,
    };
    await prisma.taxProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return body.data;
  });

  // RF25 e RF26: marcações fiscais de uma transação. Rendimento só em entrada,
  // dedutível só em gasto; o contrário responde 422.
  app.patch("/transactions/:id/tax", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = markBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const tx = await prisma.transaction.findFirst({ where: { id: params.data.id, userId } });
    if (!tx) return reply.code(404).send({ error: "not_found" });
    const { taxableIncome, deductibleType } = body.data;
    if (taxableIncome !== undefined && tx.direction !== "credit") return reply.code(422).send({ error: "not_income" });
    if (deductibleType !== undefined && (tx.direction !== "debit" || tx.isInternalTransfer || tx.isCardBillPayment)) {
      return reply.code(422).send({ error: "not_spending" });
    }
    const updated = await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        ...(taxableIncome !== undefined ? { taxableIncome } : {}),
        ...(deductibleType !== undefined ? { deductibleType } : {}),
      },
    });
    return { id: updated.id, taxableIncome: updated.taxableIncome, deductibleType: updated.deductibleType };
  });

  // Entradas sugeridas como rendimento que esperam a confirmação do usuário (RF25).
  app.get("/tax/suggestions", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const rows = await prisma.transaction.findMany({
      where: { userId, direction: "credit", taxableIncome: "suggested" },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: 100,
    });
    return {
      items: rows.map((t) => ({
        id: t.id,
        date: t.date.toISOString().slice(0, 10),
        description: t.description,
        amountCents: Number(t.amountCents),
        // O app avisa que salário já vem do perfil e não é somado de novo.
        looksLikeSalary: isSalaryLike(t),
      })),
    };
  });

  // RF27: a estimativa do ano corrente, com o passo a passo e o aviso.
  app.get("/tax/estimate", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const today = brazilDate(now());
    const year = today.getUTCFullYear();

    let config: TaxYearConfig;
    try {
      config = loadConfig(year);
    } catch {
      return reply.code(503).send({ error: "tax_table_missing", year });
    }
    const profile = await prisma.taxProfile.findUnique({ where: { userId } });
    if (!profile) return reply.code(409).send({ error: "profile_required" });

    const yearRange = { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) };
    const [income, deductible] = await Promise.all([
      prisma.transaction.findMany({
        where: { userId, date: yearRange, direction: "credit", taxableIncome: "confirmed", isInternalTransfer: false },
        select: { amountCents: true, description: true, direction: true, pluggyCategory: true },
      }),
      prisma.transaction.findMany({
        where: { userId, date: yearRange, ...spendingWhere, deductibleType: { not: null } },
        select: { amountCents: true, deductibleType: true },
      }),
    ]);

    // RN05: os rendimentos confirmados até agora são projetados para o ano
    // pela média mensal. O salário fica de fora porque já vem bruto do perfil.
    const otherSoFar = sumCents(income.filter((t) => !isSalaryLike(t)));
    const monthsElapsed = today.getUTCMonth() + 1;
    const otherProjected = Math.round((otherSoFar / monthsElapsed) * 12);
    // As despesas dedutíveis entram como estão: projetar gasto com médico seria chute.
    const byType = (type: string) => sumCents(deductible.filter((t) => t.deductibleType === type));

    const estimate = estimateIncomeTax(
      {
        grossMonthlySalaryCents: Number(profile.grossMonthlySalaryCents),
        withheldMonthlyCents: profile.withheldMonthlyCents === null ? null : Number(profile.withheldMonthlyCents),
        dependentsCount: profile.dependentsCount,
        otherTaxableIncomeCents: otherProjected,
        healthExpensesCents: byType("health"),
        educationExpensesCents: byType("education"),
        pensionContributionsCents: byType("pension"),
      },
      config,
    );

    return {
      year,
      disclaimer: TAX_DISCLAIMER,
      tableVerifiedOfficial: isVerified(config),
      estimate,
      monthlyReserveCents: monthlyReserve(estimate, today, config),
      monthsUntilDeadline: monthsUntilDeadline(today, config),
      inputs: {
        otherIncomeSoFarCents: otherSoFar,
        otherIncomeProjectedCents: otherProjected,
        monthsElapsed,
        healthCents: byType("health"),
        educationCents: byType("education"),
        pensionCents: byType("pension"),
      },
    };
  });
}
