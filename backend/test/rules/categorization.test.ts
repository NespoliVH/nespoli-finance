import { describe, expect, it } from "vitest";
import { categorize, isSpending, normalizeMerchant, type CategoryId } from "../../src/rules/categorization.js";

describe("normalizeMerchant", () => {
  it("remove acentos, números, pontuação e palavras do banco", () => {
    expect(normalizeMerchant("PADARIA PÃO QUENTE 02/03")).toBe("padaria pao quente");
    expect(normalizeMerchant("Padaria Pão Quente")).toBe("padaria pao quente");
    expect(normalizeMerchant("COMPRA CARTAO - FARMÁCIA SÃO JOÃO*123")).toBe("farmacia sao joao");
    expect(normalizeMerchant("Pix enviado: Condomínio Ed. Aurora")).toBe("condominio ed aurora");
  });

  it("mantém só as quatro primeiras palavras", () => {
    expect(normalizeMerchant("um dois tres quatro cinco seis")).toBe("um dois tres quatro");
  });
});

describe("categorize (RN01)", () => {
  const debit = (description: string, pluggyCategory?: string) => ({ description, direction: "debit" as const, pluggyCategory });

  it("passo 1: regra do usuário vence a categoria do Pluggy", () => {
    const rules = new Map<string, CategoryId>([["padaria pao quente", "outros"]]);
    expect(categorize(debit("PADARIA PAO QUENTE 02/03", "Food and drinks"), rules)).toEqual({
      categoryId: "outros",
      source: "user_rule",
      merchantKey: "padaria pao quente",
    });
  });

  it("passo 2: categoria do Pluggy convertida", () => {
    expect(categorize(debit("XPTO LTDA", "Food and drinks"))?.categoryId).toBe("comida");
    expect(categorize(debit("XPTO LTDA", "Pharmacy"))?.categoryId).toBe("imprevistos");
    expect(categorize(debit("XPTO LTDA", "Electricity"))).toMatchObject({ categoryId: "contas_fixas", source: "pluggy" });
  });

  it("passo 3: palavra-chave quando o Pluggy não ajuda", () => {
    expect(categorize(debit("DROGARIA SAO PAULO", "Shopping"))).toMatchObject({ categoryId: "imprevistos", source: "keyword" });
    expect(categorize(debit("Supermercado Bom Preço"))).toMatchObject({ categoryId: "comida", source: "keyword" });
    expect(categorize(debit("ALUGUEL APTO 12"))).toMatchObject({ categoryId: "contas_fixas", source: "keyword" });
  });

  it("passo 4: Outros quando nada casa", () => {
    expect(categorize(debit("LOJA QUALQUER"))).toMatchObject({ categoryId: "outros", source: "default" });
  });

  it("não categoriza entradas, transferências próprias nem pagamento de fatura (RF19)", () => {
    expect(categorize({ description: "SALARIO", direction: "credit" })).toBeNull();
    expect(categorize({ description: "TED MESMA TITULARIDADE", direction: "debit", isInternalTransfer: true })).toBeNull();
    expect(categorize({ description: "PAGAMENTO FATURA", direction: "debit", isCardBillPayment: true })).toBeNull();
    expect(isSpending({ direction: "debit" })).toBe(true);
  });
});
