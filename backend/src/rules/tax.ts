import { applyRate, reaisToCents, sum, type Cents } from "./money.js";

// Estimativa de Imposto de Renda (RN05, RF27).
//
// Não é cálculo oficial. Reproduz, de forma simplificada, o ajuste anual de
// um assalariado:
//   1. rendimentos tributáveis do ano (salário bruto × 12, mais outros confirmados)
//   2. deduções legais: INSS, dependentes, saúde, educação (com limite) e previdência (até 12%)
//   3. base de cálculo nas duas modalidades: completa (deduções reais) e
//      simplificada (desconto de 20% com teto)
//   4. imposto pela tabela anual, menos o redutor da Lei 15.270/2025
//   5. fica a modalidade com menor imposto, como a pessoa faria na declaração
//   6. diferença = imposto devido − IR já retido na fonte no ano
//   7. valor a reservar = diferença ÷ meses até o fim do prazo da declaração
//
// Todas as faixas e limites vêm do arquivo de configuração do ano (RN06),
// nunca do código.

interface Bracket {
  upTo: number | null;
  rateBasisPoints: number;
  deduction?: number;
}

export interface TaxYearConfig {
  year: number;
  deadlineMonth: number;
  incomeTaxAnnual: { brackets: Bracket[] };
  annualReducer: {
    fullReductionUpTo: number;
    maxReduction: number;
    phaseOutUpTo: number;
    phaseOutConstant: number;
    phaseOutFactor: number;
  };
  inssMonthly: { brackets: Bracket[] };
  deductions: {
    perDependentAnnual: number;
    educationLimitPerPersonAnnual: number;
    pensionLimitBasisPoints: number;
    simplifiedRateBasisPoints: number;
    simplifiedCapAnnual: number;
  };
}

export interface TaxInput {
  grossMonthlySalaryCents: Cents;
  withheldMonthlyCents?: Cents | null;
  dependentsCount: number;
  otherTaxableIncomeCents?: Cents; // entradas confirmadas como rendimento além do salário (RF25)
  healthExpensesCents: Cents; // despesas marcadas como saúde no ano (RF26)
  educationExpensesCents: Cents;
  pensionContributionsCents: Cents;
}

export interface TaxStep {
  label: string;
  amountCents: Cents;
}

export interface TaxEstimate {
  year: number;
  taxableIncomeCents: Cents;
  regime: "complete" | "simplified";
  taxDueCents: Cents;
  withheldCents: Cents;
  differenceCents: Cents; // positivo: a pagar; negativo: a restituir
  steps: TaxStep[];
  alternative: { regime: "complete" | "simplified"; taxDueCents: Cents };
}

/** Contribuição mensal ao INSS do empregado: alíquota progressiva por faixa, até o teto. */
export function monthlyInss(grossCents: Cents, config: TaxYearConfig): Cents {
  let total = 0;
  let lower = 0;
  for (const b of config.inssMonthly.brackets) {
    const upper = reaisToCents(b.upTo ?? Number.POSITIVE_INFINITY);
    if (grossCents <= lower) break;
    const slice = Math.min(grossCents, upper) - lower;
    total += applyRate(slice, b.rateBasisPoints);
    lower = upper;
  }
  return total;
}

/** Imposto pela tabela progressiva: base × alíquota da faixa − parcela a deduzir. */
export function progressiveTax(baseCents: Cents, brackets: readonly Bracket[]): Cents {
  if (baseCents <= 0) return 0;
  const bracket = brackets.find((b) => b.upTo === null || baseCents <= reaisToCents(b.upTo));
  if (!bracket) throw new Error("Tabela sem faixa final");
  return Math.max(0, applyRate(baseCents, bracket.rateBasisPoints) - reaisToCents(bracket.deduction ?? 0));
}

/** Redutor anual da Lei 15.270/2025, calculado sobre os rendimentos tributáveis e limitado ao imposto. */
export function annualReduction(taxableIncomeCents: Cents, taxCents: Cents, config: TaxYearConfig): Cents {
  const r = config.annualReducer;
  let reduction: Cents;
  if (taxableIncomeCents <= reaisToCents(r.fullReductionUpTo)) {
    reduction = reaisToCents(r.maxReduction);
  } else if (taxableIncomeCents <= reaisToCents(r.phaseOutUpTo)) {
    reduction = reaisToCents(r.phaseOutConstant) - Math.round(taxableIncomeCents * r.phaseOutFactor);
  } else {
    reduction = 0;
  }
  return Math.min(Math.max(reduction, 0), taxCents);
}

export function estimateIncomeTax(input: TaxInput, config: TaxYearConfig): TaxEstimate {
  const d = config.deductions;
  const taxable = input.grossMonthlySalaryCents * 12 + (input.otherTaxableIncomeCents ?? 0);

  const inss = monthlyInss(input.grossMonthlySalaryCents, config) * 12;
  const dependents = reaisToCents(d.perDependentAnnual) * input.dependentsCount;
  const health = input.healthExpensesCents; // saúde não tem limite
  const education = Math.min(
    input.educationExpensesCents,
    reaisToCents(d.educationLimitPerPersonAnnual) * (1 + input.dependentsCount),
  );
  const pension = Math.min(input.pensionContributionsCents, applyRate(taxable, d.pensionLimitBasisPoints));
  const legalDeductions = sum([inss, dependents, health, education, pension]);

  const completeBase = Math.max(0, taxable - legalDeductions);
  const simplifiedDiscount = Math.min(applyRate(taxable, d.simplifiedRateBasisPoints), reaisToCents(d.simplifiedCapAnnual));
  const simplifiedBase = Math.max(0, taxable - simplifiedDiscount);

  const taxFor = (base: Cents) => {
    const gross = progressiveTax(base, config.incomeTaxAnnual.brackets);
    return gross - annualReduction(taxable, gross, config);
  };
  const completeTax = taxFor(completeBase);
  const simplifiedTax = taxFor(simplifiedBase);
  const regime = completeTax <= simplifiedTax ? "complete" : "simplified";
  const taxDue = Math.min(completeTax, simplifiedTax);
  const withheld = (input.withheldMonthlyCents ?? 0) * 12;

  const steps: TaxStep[] =
    regime === "complete"
      ? [
          { label: "Rendimentos tributáveis no ano", amountCents: taxable },
          { label: "(−) Contribuição ao INSS", amountCents: inss },
          { label: `(−) Dependentes (${input.dependentsCount})`, amountCents: dependents },
          { label: "(−) Saúde, educação e previdência", amountCents: health + education + pension },
          { label: "(=) Base de cálculo", amountCents: completeBase },
          { label: "Imposto pela tabela, com o redutor", amountCents: taxDue },
          { label: "(−) Retido na fonte no ano", amountCents: withheld },
          { label: "(=) Diferença", amountCents: taxDue - withheld },
        ]
      : [
          { label: "Rendimentos tributáveis no ano", amountCents: taxable },
          { label: "(−) Desconto simplificado", amountCents: simplifiedDiscount },
          { label: "(=) Base de cálculo", amountCents: simplifiedBase },
          { label: "Imposto pela tabela, com o redutor", amountCents: taxDue },
          { label: "(−) Retido na fonte no ano", amountCents: withheld },
          { label: "(=) Diferença", amountCents: taxDue - withheld },
        ];

  return {
    year: config.year,
    taxableIncomeCents: taxable,
    regime,
    taxDueCents: taxDue,
    withheldCents: withheld,
    differenceCents: taxDue - withheld,
    steps,
    alternative: regime === "complete" ? { regime: "simplified", taxDueCents: simplifiedTax } : { regime: "complete", taxDueCents: completeTax },
  };
}

/**
 * Meses para guardar o valor: do mês de `today` (inclusive) até o mês do fim
 * do prazo da declaração no ano seguinte (inclusive). Em novembro de 2026,
 * com prazo em maio, são 7 meses (novembro a maio).
 */
export function monthsUntilDeadline(today: Date, config: TaxYearConfig): number {
  const deadlineIndex = (config.year + 1) * 12 + (config.deadlineMonth - 1);
  const todayIndex = today.getUTCFullYear() * 12 + today.getUTCMonth();
  return Math.max(1, deadlineIndex - todayIndex + 1);
}

/** Valor a reservar por mês. Zero quando a estimativa é de restituição. */
export function monthlyReserve(estimate: TaxEstimate, today: Date, config: TaxYearConfig): Cents {
  if (estimate.differenceCents <= 0) return 0;
  return Math.ceil(estimate.differenceCents / monthsUntilDeadline(today, config));
}
