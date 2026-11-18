import { describe, expect, it } from "vitest";
import { isSalaryLike, suggestTaxableIncome } from "../../src/rules/income.js";

describe("rendimentos tributáveis (RF25)", () => {
  it("sugere salário, aposentadoria e trabalho autônomo pela categoria do Pluggy", () => {
    for (const pluggyCategory of ["Salary", "Retirement", "Entrepreneurial activities"]) {
      expect(suggestTaxableIncome({ description: "TED RECEBIDA", direction: "credit", pluggyCategory })).toBe(true);
    }
  });

  it("sugere pela descrição quando não há categoria", () => {
    expect(suggestTaxableIncome({ description: "CRED SALÁRIO EMPRESA X", direction: "credit" })).toBe(true);
    expect(suggestTaxableIncome({ description: "PIX HONORÁRIOS CONSULTORIA", direction: "credit" })).toBe(true);
  });

  it("não sugere auxílio do governo, transferência própria nem saída", () => {
    expect(suggestTaxableIncome({ description: "BOLSA", direction: "credit", pluggyCategory: "Government aid" })).toBe(false);
    expect(suggestTaxableIncome({ description: "SALARIO", direction: "credit", isInternalTransfer: true })).toBe(false);
    expect(suggestTaxableIncome({ description: "PAGTO SALARIO DOMESTICA", direction: "debit" })).toBe(false);
    expect(suggestTaxableIncome({ description: "PIX RECEBIDO MARIA", direction: "credit" })).toBe(false);
  });

  it("reconhece o salário, que já vem bruto do perfil", () => {
    expect(isSalaryLike({ description: "TED", direction: "credit", pluggyCategory: "Salary" })).toBe(true);
    expect(isSalaryLike({ description: "PROVENTOS FOLHA", direction: "credit" })).toBe(true);
    expect(isSalaryLike({ description: "HONORARIOS", direction: "credit", pluggyCategory: "Entrepreneurial activities" })).toBe(false);
  });
});
