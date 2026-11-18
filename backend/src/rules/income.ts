// Rendimentos tributáveis (RF25).
//
// Na sincronização, entradas que parecem rendimento tributável chegam
// marcadas como "sugerido". Só entram na estimativa depois que o usuário
// confirma, porque o banco não sabe se um PIX recebido é trabalho, presente
// ou reembolso.
//
// O salário é um caso à parte: o banco mostra o valor líquido, depois do INSS
// e do IR retido, e a declaração precisa do bruto. Por isso o salário vem do
// perfil fiscal (bruto do holerite) e as entradas de salário não são somadas
// de novo na estimativa, mesmo confirmadas.

export interface IncomeInput {
  description: string;
  direction: "debit" | "credit";
  pluggyCategory?: string | null;
  isInternalTransfer?: boolean;
}

// Categorias do Pluggy (GET /categories, conferido em 18/11/2026): 01010000
// Salary, 01020000 Retirement, 01030000 Entrepreneurial activities. Ficam de
// fora Government aid (benefícios em geral isentos) e Non-recurring income.
const SALARY_CATEGORY = /^salary$/i;
const TAXABLE_CATEGORY = /^(salary|retirement|entrepreneurial activities)$/i;

const SALARY_WORDS = /\b(salario|salarios|folha|proventos|vencimentos|remuneracao)\b/;
const OTHER_TAXABLE_WORDS = /\b(pro labore|prolabore|honorarios|aposentadoria|beneficio inss|aluguel recebido|rpa)\b/;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
}

/** Parece salário (que já vem bruto do perfil fiscal)? */
export function isSalaryLike(t: IncomeInput): boolean {
  if (t.direction !== "credit") return false;
  if (t.pluggyCategory && SALARY_CATEGORY.test(t.pluggyCategory)) return true;
  return SALARY_WORDS.test(normalize(t.description));
}

/** A entrada deve chegar como "sugerida" para o usuário confirmar? */
export function suggestTaxableIncome(t: IncomeInput): boolean {
  if (t.direction !== "credit" || t.isInternalTransfer) return false;
  if (t.pluggyCategory && TAXABLE_CATEGORY.test(t.pluggyCategory)) return true;
  const text = normalize(t.description);
  return SALARY_WORDS.test(text) || OTHER_TAXABLE_WORDS.test(text);
}
