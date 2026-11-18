import { describe, expect, it } from "vitest";
import { loadTaxConfig } from "../../src/config/tax/index.js";
import {
  annualReduction,
  estimateIncomeTax,
  monthlyInss,
  monthlyReserve,
  monthsUntilDeadline,
  progressiveTax,
  type TaxInput,
} from "../../src/rules/tax.js";

// Os valores esperados foram conferidos à mão com as tabelas de 2026 do arquivo de configuração.
const config = loadTaxConfig(2026);
const base: Omit<TaxInput, "grossMonthlySalaryCents"> = {
  dependentsCount: 0,
  healthExpensesCents: 0,
  educationExpensesCents: 0,
  pensionContributionsCents: 0,
};

describe("INSS mensal", () => {
  it("soma a alíquota de cada faixa: R$ 3.000 dá R$ 248,61 (arredonda por faixa)", () => {
    // 1.621,00 × 7,5% + 1.281,84 × 9% + 97,16 × 12%
    expect(monthlyInss(300_000, config)).toBe(24_861);
  });

  it("para no teto: acima de R$ 8.475,55 a contribuição é a mesma", () => {
    expect(monthlyInss(1_000_000, config)).toBe(98_810);
    expect(monthlyInss(2_000_000, config)).toBe(98_810);
  });
});

describe("tabela progressiva anual", () => {
  it("R$ 50.000 cai na faixa de 22,5%: 11.250,00 − 8.105,88 = 3.144,12", () => {
    expect(progressiveTax(5_000_000, config.incomeTaxAnnual.brackets)).toBe(314_412);
  });

  it("base zero ou isenta não gera imposto", () => {
    expect(progressiveTax(0, config.incomeTaxAnnual.brackets)).toBe(0);
    expect(progressiveTax(2_900_000, config.incomeTaxAnnual.brackets)).toBe(0);
  });
});

describe("redutor da Lei 15.270/2025", () => {
  it("zera o imposto de quem ganha até R$ 60.000 no ano", () => {
    expect(annualReduction(6_000_000, 200_000, config)).toBe(200_000);
  });

  it("diminui aos poucos entre R$ 60.000 e R$ 88.200: em R$ 84.000 vale R$ 401,43", () => {
    // 8.429,73 − 0,095575 × 84.000
    expect(annualReduction(8_400_000, 1_000_000, config)).toBe(40_143);
  });

  it("não existe acima de R$ 88.200", () => {
    expect(annualReduction(12_000_000, 1_000_000, config)).toBe(0);
  });
});

describe("estimateIncomeTax (RN05)", () => {
  it("salário de R$ 5.000 por mês: imposto zero por causa do redutor", () => {
    const r = estimateIncomeTax({ ...base, grossMonthlySalaryCents: 500_000 }, config);
    expect(r.taxableIncomeCents).toBe(6_000_000);
    expect(r.taxDueCents).toBe(0);
  });

  it("escolhe a modalidade com menor imposto: sem deduções, a simplificada", () => {
    const r = estimateIncomeTax({ ...base, grossMonthlySalaryCents: 1_000_000 }, config);
    expect(r.regime).toBe("simplified");
    expect(r.taxDueCents).toBe(1_748_780);
    expect(r.alternative).toEqual({ regime: "complete", taxDueCents: 1_883_451 });
  });

  it("com dependentes e despesas de saúde, a completa passa a valer mais a pena", () => {
    const r = estimateIncomeTax(
      { ...base, grossMonthlySalaryCents: 1_000_000, dependentsCount: 2, healthExpensesCents: 1_000_000 },
      config,
    );
    expect(r.regime).toBe("complete");
    expect(r.taxDueCents).toBe(1_483_322);
    expect(r.taxDueCents).toBeLessThan(r.alternative.taxDueCents);
  });

  it("desconta o IR retido na fonte: diferença negativa é restituição", () => {
    const r = estimateIncomeTax({ ...base, grossMonthlySalaryCents: 1_000_000, withheldMonthlyCents: 150_000 }, config);
    expect(r.withheldCents).toBe(1_800_000);
    expect(r.differenceCents).toBe(1_748_780 - 1_800_000);
    expect(monthlyReserve(r, new Date("2026-11-17T12:00:00Z"), config)).toBe(0);
  });

  it("limita a educação por pessoa e a previdência a 12% da renda", () => {
    const capped = estimateIncomeTax(
      { ...base, grossMonthlySalaryCents: 1_000_000, educationExpensesCents: 10_000_000, pensionContributionsCents: 10_000_000 },
      config,
    );
    const atLimit = estimateIncomeTax(
      { ...base, grossMonthlySalaryCents: 1_000_000, educationExpensesCents: 356_150, pensionContributionsCents: 1_440_000 },
      config,
    );
    expect(capped.taxDueCents).toBe(atLimit.taxDueCents);
  });

  it("os passos mostrados ao usuário fecham com o resultado", () => {
    const r = estimateIncomeTax({ ...base, grossMonthlySalaryCents: 700_000 }, config);
    expect(r.steps.at(-1)?.amountCents).toBe(r.differenceCents);
    expect(r.taxDueCents).toBe(718_637);
  });
});

describe("reserva mensal", () => {
  it("em novembro de 2026, com prazo em maio, são 7 meses", () => {
    expect(monthsUntilDeadline(new Date("2026-11-17T12:00:00Z"), config)).toBe(7);
  });

  it("depois do prazo o mínimo é 1 mês", () => {
    expect(monthsUntilDeadline(new Date("2027-08-01T12:00:00Z"), config)).toBe(1);
  });

  it("divide o valor a pagar arredondando para cima", () => {
    const r = estimateIncomeTax({ ...base, grossMonthlySalaryCents: 700_000 }, config);
    expect(monthlyReserve(r, new Date("2026-11-17T12:00:00Z"), config)).toBe(Math.ceil(718_637 / 7));
  });
});
