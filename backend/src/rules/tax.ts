import { applyRate, reaisToCents, sum, type Cents } from "./money.js";

// Estimativa de Imposto de Renda (RN05, RF27).
//
// Não é cálculo oficial. Reproduz, de forma simplificada, o ajuste anual de
// um assalariado, de um autônomo ou de quem é os dois:
//   1. rendimentos tributáveis do ano (salário bruto × 12, trabalho autônomo
//      e outros rendimentos confirmados)
//   2. deduções legais: INSS (do emprego e de autônomo), dependentes, saúde,
//      educação (com limite), previdência (até 12%) e livro-caixa
//   3. base de cálculo nas duas modalidades: completa (deduções reais) e
//      simplificada (desconto de 20% com teto; nela o livro-caixa não entra)
//   4. imposto pela tabela anual, menos o redutor da Lei 15.270/2025
//   5. fica a modalidade com menor imposto, como a pessoa faria na declaração
//   6. diferença = imposto devido − IR retido na fonte − carnê-leão pago
//   7. valor a reservar = diferença ÷ meses até o fim do prazo da declaração
//
// O carnê-leão mensal do autônomo fica em rules/selfEmployed.ts.
//
// Todas as faixas e limites vêm do arquivo de configuração do ano (RN06),
// nunca do código.

export interface Bracket {
  upTo: number | null;
  rateBasisPoints: number;
  deduction?: number;
}

export interface ReducerConfig {
  fullReductionUpTo: number;
  maxReduction: number;
  phaseOutUpTo: number;
  phaseOutConstant: number;
  phaseOutFactor: number;
}

export interface TaxYearConfig {
  year: number;
  deadlineMonth: number;
  incomeTaxMonthly: { brackets: Bracket[] };
  incomeTaxAnnual: { brackets: Bracket[] };
  annualReducer: ReducerConfig;
  monthlyReducer: ReducerConfig;
  monthlyDeductions: { perDependentMonthly: number; simplifiedMonthly: number };
  carneLeao: { darfCode: string; minimumDarf: number };
  inssSelfEmployed: {
    minimumWage: number;
    ceiling: number;
    standardRateBasisPoints: number;
    simplifiedRateBasisPoints: number;
    companyWithholdingRateBasisPoints: number;
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
  /** Trabalho sem vínculo (autônomo), já projetado para o ano. */
  selfEmployed?: SelfEmployedAnnual;
}

export interface SelfEmployedAnnual {
  incomeCents: Cents; // recebido de pessoas físicas e de empresas
  inssCents: Cents; // contribuição de autônomo paga e a retida pelas empresas
  bookDeductionCents: Cents; // livro-caixa já limitado mês a mês
  carneLeaoPaidCents: Cents; // carnê-leão do ano, que abate do imposto como o retido
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
  carneLeaoPaidCents: Cents;
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
  return reduction(taxableIncomeCents, taxCents, config.annualReducer);
}

/**
 * Redução da Lei 15.270/2025 (mensal ou anual, conforme a tabela). Usa os
 * rendimentos tributáveis, e não a base de cálculo, e nunca passa do imposto.
 */
export function reduction(taxableIncomeCents: Cents, taxCents: Cents, r: ReducerConfig): Cents {
  let value: Cents;
  if (taxableIncomeCents <= reaisToCents(r.fullReductionUpTo)) {
    value = reaisToCents(r.maxReduction);
  } else if (taxableIncomeCents <= reaisToCents(r.phaseOutUpTo)) {
    value = reaisToCents(r.phaseOutConstant) - Math.round(taxableIncomeCents * r.phaseOutFactor);
  } else {
    value = 0;
  }
  return Math.min(Math.max(value, 0), taxCents);
}

export function estimateIncomeTax(input: TaxInput, config: TaxYearConfig): TaxEstimate {
  const d = config.deductions;
  const se = input.selfEmployed;
  const taxable = input.grossMonthlySalaryCents * 12 + (input.otherTaxableIncomeCents ?? 0) + (se?.incomeCents ?? 0);

  const inss = monthlyInss(input.grossMonthlySalaryCents, config) * 12 + (se?.inssCents ?? 0);
  // Livro-caixa só existe na declaração completa.
  const book = se?.bookDeductionCents ?? 0;
  const dependents = reaisToCents(d.perDependentAnnual) * input.dependentsCount;
  const health = input.healthExpensesCents; // saúde não tem limite
  const education = Math.min(
    input.educationExpensesCents,
    reaisToCents(d.educationLimitPerPersonAnnual) * (1 + input.dependentsCount),
  );
  const pension = Math.min(input.pensionContributionsCents, applyRate(taxable, d.pensionLimitBasisPoints));
  const legalDeductions = sum([inss, dependents, health, education, pension, book]);

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
  const carneLeao = se?.carneLeaoPaidCents ?? 0;
  const difference = taxDue - withheld - carneLeao;

  const paidSteps: TaxStep[] = [
    { label: "(−) Retido na fonte no ano", amountCents: withheld },
    ...(se ? [{ label: "(−) Carnê-leão do ano", amountCents: carneLeao }] : []),
    { label: "(=) Diferença", amountCents: difference },
  ];
  const steps: TaxStep[] =
    regime === "complete"
      ? [
          { label: "Rendimentos tributáveis no ano", amountCents: taxable },
          { label: "(−) Contribuição ao INSS", amountCents: inss },
          { label: `(−) Dependentes (${input.dependentsCount})`, amountCents: dependents },
          { label: "(−) Saúde, educação e previdência", amountCents: health + education + pension },
          ...(se ? [{ label: "(−) Livro-caixa", amountCents: book }] : []),
          { label: "(=) Base de cálculo", amountCents: completeBase },
          { label: "Imposto pela tabela, com o redutor", amountCents: taxDue },
          ...paidSteps,
        ]
      : [
          { label: "Rendimentos tributáveis no ano", amountCents: taxable },
          { label: "(−) Desconto simplificado", amountCents: simplifiedDiscount },
          { label: "(=) Base de cálculo", amountCents: simplifiedBase },
          { label: "Imposto pela tabela, com o redutor", amountCents: taxDue },
          ...paidSteps,
        ];

  return {
    year: config.year,
    taxableIncomeCents: taxable,
    regime,
    taxDueCents: taxDue,
    withheldCents: withheld,
    carneLeaoPaidCents: carneLeao,
    differenceCents: difference,
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
