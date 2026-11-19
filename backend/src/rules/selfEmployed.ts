import { applyRate, reaisToCents, type Cents } from "./money.js";
import { progressiveTax, reduction, type SelfEmployedAnnual, type TaxYearConfig } from "./tax.js";

// Autônomo: INSS de contribuinte individual, livro-caixa e carnê-leão mensal.
//
// Não é cálculo oficial. Segue as regras da Receita e do INSS de forma
// simplificada (valores no arquivo do ano, RN06):
//
// INSS do contribuinte individual
//   - recebido de pessoa física: o próprio autônomo paga 20% sobre o que
//     recebeu, entre o salário mínimo e o teto (ou 11% do mínimo, no plano
//     simplificado);
//   - recebido de empresa: a empresa retém 11% e repassa ao INSS;
//   - quem também tem emprego soma o salário: o teto vale para o total.
//
// Livro-caixa
//   - despesas necessárias ao trabalho (aluguel da sala, material, telefone...);
//   - a dedução do mês vai até o que foi recebido como autônomo no mês, e o
//     que sobra passa para os meses seguintes, até dezembro.
//
// Carnê-leão (rendimentos recebidos de pessoas físicas)
//   - base = recebido de pessoas físicas − deduções (INSS pago pelo próprio
//     autônomo, dependentes e livro-caixa) ou o desconto simplificado mensal,
//     o que for maior;
//   - imposto pela tabela mensal, menos a redução mensal da Lei 15.270/2025;
//   - vence no último dia útil do mês seguinte; abaixo de R$ 10 passa para o mês seguinte.
//
// O que vem de empresa não entra no carnê-leão: a empresa já retém o imposto.

export type IncomeType = "salaried" | "self_employed" | "both";
export type InssPlan = "standard" | "simplified" | "none";

export interface SelfEmployedProfile {
  incomeType: IncomeType;
  inssPlan: InssPlan;
  grossMonthlySalaryCents: Cents; // zero para quem é só autônomo
  dependentsCount: number;
}

export interface SelfEmployedMonthInput {
  month: string; // "2026-03"
  fromIndividualsCents: Cents;
  fromCompaniesCents: Cents;
  bookExpensesCents: Cents; // despesas marcadas como livro-caixa no mês
}

export interface CarneLeaoMonth {
  month: string;
  fromIndividualsCents: Cents;
  fromCompaniesCents: Cents;
  inssPaidCents: Cents; // pago pelo próprio autônomo (GPS)
  inssWithheldCents: Cents; // retido pelas empresas
  bookExpensesCents: Cents;
  bookDeductionCents: Cents; // usado neste mês
  bookCarryOverCents: Cents; // passa para o mês seguinte
  dependentsCents: Cents;
  deductionKind: "legal" | "simplified";
  deductionCents: Cents;
  baseCents: Cents;
  taxBeforeReductionCents: Cents;
  reductionCents: Cents;
  taxCents: Cents;
  /** O que vai no DARF deste mês, já somado ao que ficou abaixo de R$ 10 antes. */
  payableCents: Cents;
  dueDate: string | null; // "2026-04-30"; null quando não há nada a pagar
}

export function hasSelfEmployment(t: IncomeType): boolean {
  return t !== "salaried";
}

/** Contribuição do autônomo no mês: a paga por ele e a retida pelas empresas. */
export function selfEmployedInss(
  month: Pick<SelfEmployedMonthInput, "fromIndividualsCents" | "fromCompaniesCents">,
  profile: SelfEmployedProfile,
  config: TaxYearConfig,
): { paidCents: Cents; withheldCents: Cents } {
  const c = config.inssSelfEmployed;
  const ceiling = reaisToCents(c.ceiling);
  const minimum = reaisToCents(c.minimumWage);
  const salary = profile.incomeType === "both" ? profile.grossMonthlySalaryCents : 0;

  // O teto vale para a soma de tudo: salário, empresas e pessoas físicas.
  let room = Math.max(0, ceiling - salary);
  const companyBase = Math.min(month.fromCompaniesCents, room);
  const withheldCents = applyRate(companyBase, c.companyWithholdingRateBasisPoints);
  room -= companyBase;

  if (profile.inssPlan === "none" || month.fromIndividualsCents + month.fromCompaniesCents <= 0) {
    return { paidCents: 0, withheldCents };
  }
  if (profile.inssPlan === "simplified") {
    if (month.fromIndividualsCents <= 0) return { paidCents: 0, withheldCents };
    return { paidCents: applyRate(minimum, c.simplifiedRateBasisPoints), withheldCents };
  }
  if (month.fromIndividualsCents <= 0) return { paidCents: 0, withheldCents };
  // O total do mês não pode ficar abaixo do salário mínimo.
  const floor = Math.max(0, minimum - salary - companyBase);
  const base = Math.min(Math.max(month.fromIndividualsCents, floor), room);
  return { paidCents: applyRate(base, c.standardRateBasisPoints), withheldCents };
}

/** Último dia útil (segunda a sexta) do mês seguinte. Feriados não são considerados. */
export function carneLeaoDueDate(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  // Dia 0 do mês m+2 = último dia do mês m+1 (meses do Date começam em 0).
  const d = new Date(Date.UTC(y, m + 1, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Calcula o carnê-leão de cada mês, em ordem, levando o livro-caixa e os valores abaixo de R$ 10. */
export function carneLeaoMonths(
  months: readonly SelfEmployedMonthInput[],
  profile: SelfEmployedProfile,
  config: TaxYearConfig,
): CarneLeaoMonth[] {
  const md = config.monthlyDeductions;
  const simplified = reaisToCents(md.simplifiedMonthly);
  const minimumDarf = reaisToCents(config.carneLeao.minimumDarf);
  // Dependentes só entram aqui se não foram usados no salário (retenção na fonte).
  const dependents = profile.incomeType === "self_employed" ? reaisToCents(md.perDependentMonthly) * profile.dependentsCount : 0;

  let carry = 0;
  let pending = 0;
  return [...months]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const inss = selfEmployedInss(m, profile, config);
      const workIncome = m.fromIndividualsCents + m.fromCompaniesCents;
      const available = m.bookExpensesCents + carry;
      const bookDeduction = Math.min(available, workIncome);
      carry = available - bookDeduction;

      const pf = m.fromIndividualsCents;
      let deductionKind: "legal" | "simplified" = "legal";
      let deduction = 0;
      let base = 0;
      let gross = 0;
      let red = 0;
      if (pf > 0) {
        const legal = inss.paidCents + dependents + bookDeduction;
        deductionKind = legal >= simplified ? "legal" : "simplified";
        deduction = Math.max(legal, simplified);
        base = Math.max(0, pf - deduction);
        gross = progressiveTax(base, config.incomeTaxMonthly.brackets);
        red = reduction(pf, gross, config.monthlyReducer);
      }
      const tax = gross - red;
      pending += tax;
      const payable = pending >= minimumDarf ? pending : 0;
      if (payable > 0) pending = 0;

      return {
        month: m.month,
        fromIndividualsCents: pf,
        fromCompaniesCents: m.fromCompaniesCents,
        inssPaidCents: inss.paidCents,
        inssWithheldCents: inss.withheldCents,
        bookExpensesCents: m.bookExpensesCents,
        bookDeductionCents: bookDeduction,
        bookCarryOverCents: carry,
        dependentsCents: pf > 0 && deductionKind === "legal" ? dependents : 0,
        deductionKind,
        deductionCents: deduction,
        baseCents: base,
        taxBeforeReductionCents: gross,
        reductionCents: red,
        taxCents: tax,
        payableCents: payable,
        dueDate: payable > 0 ? carneLeaoDueDate(m.month) : null,
      };
    });
}

/**
 * Leva os meses já vividos para o ano inteiro, pela média mensal (RN05),
 * no formato que a estimativa anual usa.
 */
export function projectSelfEmployedYear(months: readonly CarneLeaoMonth[], monthsElapsed: number): SelfEmployedAnnual {
  const project = (pick: (m: CarneLeaoMonth) => Cents) =>
    Math.round((months.reduce((acc, m) => acc + pick(m), 0) / Math.max(1, monthsElapsed)) * 12);
  return {
    incomeCents: project((m) => m.fromIndividualsCents + m.fromCompaniesCents),
    inssCents: project((m) => m.inssPaidCents + m.inssWithheldCents),
    bookDeductionCents: project((m) => m.bookDeductionCents),
    carneLeaoPaidCents: project((m) => m.taxCents),
  };
}
