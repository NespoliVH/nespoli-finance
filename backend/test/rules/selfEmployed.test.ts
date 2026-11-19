import { describe, expect, it } from "vitest";
import { loadTaxConfig } from "../../src/config/tax/index.js";
import {
  carneLeaoDueDate,
  carneLeaoMonths,
  projectSelfEmployedYear,
  selfEmployedInss,
  type SelfEmployedMonthInput,
  type SelfEmployedProfile,
} from "../../src/rules/selfEmployed.js";
import { estimateIncomeTax, reduction } from "../../src/rules/tax.js";

// Valores conferidos à mão com as tabelas de 2026 (Receita Federal e INSS).
const config = loadTaxConfig(2026);
const autonomo: SelfEmployedProfile = { incomeType: "self_employed", inssPlan: "standard", grossMonthlySalaryCents: 0, dependentsCount: 0 };
const month = (m: string, pf: number, pj = 0, book = 0): SelfEmployedMonthInput => ({
  month: m,
  fromIndividualsCents: pf,
  fromCompaniesCents: pj,
  bookExpensesCents: book,
});

describe("INSS do contribuinte individual", () => {
  it("20% sobre o recebido de pessoas físicas", () => {
    expect(selfEmployedInss(month("2026-03", 600_000), autonomo, config)).toEqual({ paidCents: 120_000, withheldCents: 0 });
  });

  it("nunca abaixo do salário mínimo: R$ 500 recebidos pagam 20% de R$ 1.621", () => {
    expect(selfEmployedInss(month("2026-03", 50_000), autonomo, config).paidCents).toBe(32_420);
  });

  it("a empresa retém 11% do que paga", () => {
    expect(selfEmployedInss(month("2026-03", 0, 100_000), autonomo, config)).toEqual({ paidCents: 0, withheldCents: 11_000 });
  });

  it("plano simplificado: 11% do salário mínimo", () => {
    expect(selfEmployedInss(month("2026-03", 300_000), { ...autonomo, inssPlan: "simplified" }, config).paidCents).toBe(17_831);
  });

  it("quem também tem emprego soma o salário no teto", () => {
    // Teto 8.475,55 − salário 8.000 = 475,55 de espaço; 20% = 95,11.
    const both: SelfEmployedProfile = { ...autonomo, incomeType: "both", grossMonthlySalaryCents: 800_000 };
    expect(selfEmployedInss(month("2026-03", 200_000), both, config).paidCents).toBe(9_511);
  });
});

describe("carnê-leão mensal", () => {
  it("R$ 6.000 de pessoas físicas, com INSS e livro-caixa: R$ 112,26 até 30/04", () => {
    // Base 6.000 − 1.200 (INSS) − 500 (livro-caixa) = 4.300; 4.300 × 22,5% − 675,49 = 292,01;
    // redução mensal 978,62 − 0,133145 × 6.000 = 179,75; imposto 112,26.
    const [m] = carneLeaoMonths([month("2026-03", 600_000, 0, 50_000)], autonomo, config);
    expect(m).toMatchObject({
      deductionKind: "legal",
      deductionCents: 170_000,
      baseCents: 430_000,
      taxBeforeReductionCents: 29_201,
      reductionCents: 17_975,
      taxCents: 11_226,
      payableCents: 11_226,
      dueDate: "2026-04-30",
    });
  });

  it("usa o desconto simplificado quando ele é maior que as deduções", () => {
    const [m] = carneLeaoMonths([month("2026-03", 300_000)], { ...autonomo, inssPlan: "simplified" }, config);
    expect(m).toMatchObject({ deductionKind: "simplified", deductionCents: 60_720, baseCents: 239_280, taxCents: 0, dueDate: null });
  });

  it("até R$ 5.000 no mês a redução zera o imposto", () => {
    const [m] = carneLeaoMonths([month("2026-03", 500_000)], { ...autonomo, inssPlan: "none" }, config);
    expect(m!.taxBeforeReductionCents).toBeGreaterThan(0);
    expect(m!.taxCents).toBe(0);
  });

  it("o livro-caixa que passa do recebido fica para o mês seguinte", () => {
    const none = { ...autonomo, inssPlan: "none" as const };
    const [jan, feb] = carneLeaoMonths([month("2026-01", 100_000, 0, 300_000), month("2026-02", 500_000)], none, config);
    expect(jan).toMatchObject({ bookDeductionCents: 100_000, bookCarryOverCents: 200_000, baseCents: 0 });
    expect(feb).toMatchObject({ bookDeductionCents: 200_000, bookCarryOverCents: 0, baseCents: 300_000 });
  });

  it("abaixo de R$ 10 não gera DARF e o valor vai para o mês seguinte", () => {
    const none = { ...autonomo, inssPlan: "none" as const };
    // Acima de R$ 7.350 não há redução. Base 2.450 → R$ 1,59; base 3.000 → R$ 55,84.
    const [jan, feb] = carneLeaoMonths([month("2026-01", 800_000, 0, 555_000), month("2026-02", 800_000, 0, 500_000)], none, config);
    expect(jan).toMatchObject({ taxCents: 159, payableCents: 0, dueDate: null });
    expect(feb).toMatchObject({ taxCents: 5_584, payableCents: 5_743, dueDate: "2026-03-31" });
  });

  it("dependentes só entram para quem não tem salário", () => {
    const four = { ...autonomo, inssPlan: "none" as const, dependentsCount: 4 };
    const [alone] = carneLeaoMonths([month("2026-03", 300_000)], four, config);
    expect(alone).toMatchObject({ deductionKind: "legal", dependentsCents: 75_836 });
    const [both] = carneLeaoMonths([month("2026-03", 300_000)], { ...four, incomeType: "both", grossMonthlySalaryCents: 300_000 }, config);
    expect(both).toMatchObject({ deductionKind: "simplified", dependentsCents: 0 });
  });

  it("vence no último dia útil do mês seguinte", () => {
    expect(carneLeaoDueDate("2026-01")).toBe("2026-02-27"); // 28/02/2026 é sábado
    expect(carneLeaoDueDate("2026-04")).toBe("2026-05-29"); // 31/05/2026 é domingo
    expect(carneLeaoDueDate("2026-12")).toBe("2027-01-29"); // 31/01/2027 é domingo
  });

  it("a redução mensal usa o rendimento, não a base", () => {
    expect(reduction(600_000, 100_000, config.monthlyReducer)).toBe(17_975);
    expect(reduction(800_000, 100_000, config.monthlyReducer)).toBe(0);
  });
});

describe("ajuste anual do autônomo", () => {
  it("soma o trabalho autônomo, deduz INSS e livro-caixa e abate o carnê-leão", () => {
    // Base completa 72.000 − 10.000 − 5.000 = 57.000 → 4.770,34 − redução 1.548,33 = 3.222,01.
    // Simplificada: 57.600 → 3.387,01. Fica a completa; diferença 3.222,01 − 3.000 = 222,01.
    const e = estimateIncomeTax(
      {
        grossMonthlySalaryCents: 0,
        dependentsCount: 0,
        healthExpensesCents: 0,
        educationExpensesCents: 0,
        pensionContributionsCents: 0,
        selfEmployed: { incomeCents: 7_200_000, inssCents: 1_000_000, bookDeductionCents: 500_000, carneLeaoPaidCents: 300_000 },
      },
      config,
    );
    expect(e.regime).toBe("complete");
    expect(e.taxDueCents).toBe(322_201);
    expect(e.alternative.taxDueCents).toBe(338_701);
    expect(e.carneLeaoPaidCents).toBe(300_000);
    expect(e.differenceCents).toBe(22_201);
    expect(e.steps.map((s) => s.label)).toContain("(−) Livro-caixa");
    expect(e.steps.map((s) => s.label)).toContain("(−) Carnê-leão do ano");
  });

  it("exemplo do modo demonstração do app: R$ 6.000 por mês de pessoas físicas", () => {
    // Doze meses iguais ao de março: INSS 1.200, livro-caixa 500 e carnê-leão 112,26 por mês.
    const months = carneLeaoMonths(
      Array.from({ length: 12 }, (_, i) => month(`2026-${String(i + 1).padStart(2, "0")}`, 600_000, 0, 50_000)),
      autonomo,
      config,
    );
    const year = projectSelfEmployedYear(months, 12);
    expect(year).toEqual({ incomeCents: 7_200_000, inssCents: 1_440_000, bookDeductionCents: 600_000, carneLeaoPaidCents: 134_712 });
    const e = estimateIncomeTax(
      { grossMonthlySalaryCents: 0, dependentsCount: 0, healthExpensesCents: 0, educationExpensesCents: 0, pensionContributionsCents: 0, selfEmployed: year },
      config,
    );
    // Base completa 51.600 (faixa de 22,5%) → 3.504,15 − 1.548,33 = 1.955,82; menos 1.347,12 de carnê-leão = 608,70.
    expect(e).toMatchObject({ regime: "complete", taxDueCents: 195_582, differenceCents: 60_870, alternative: { taxDueCents: 338_701 } });
  });

  it("projeta os meses vividos para o ano pela média", () => {
    const months = carneLeaoMonths([month("2026-01", 600_000), month("2026-02", 0)], autonomo, config);
    const year = projectSelfEmployedYear(months, 2);
    expect(year.incomeCents).toBe(3_600_000);
    expect(year.inssCents).toBe(720_000);
  });
});
