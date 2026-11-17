// Categorização automática (RN01, RF15 a RF19).
//
// A ordem de decisão é fixa e explicável: para qualquer transação dá para
// dizer qual passo escolheu a categoria (campo category_source).
//   1. regra criada pelo usuário para o estabelecimento
//   2. categoria informada pelo Pluggy, convertida para as quatro do app
//   3. palavras-chave na descrição
//   4. Outros

export type CategoryId = "contas_fixas" | "comida" | "imprevistos" | "outros";
export type CategorySource = "user_rule" | "pluggy" | "keyword" | "default";

export interface CategorizationInput {
  description: string;
  direction: "debit" | "credit";
  pluggyCategory?: string | null;
  isInternalTransfer?: boolean;
  isCardBillPayment?: boolean;
}

export interface CategorizationResult {
  categoryId: CategoryId;
  source: CategorySource;
  merchantKey: string;
}

/**
 * Normaliza a descrição do banco em uma chave de estabelecimento, para que
 * "PADARIA PAO QUENTE 02/03" e "Padaria Pão Quente" casem com a mesma regra.
 * Remove acentos, números (parcelas, datas, códigos), pontuação e espaços
 * repetidos, e mantém as quatro primeiras palavras.
 */
export function normalizeMerchant(description: string): string {
  return description
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\d+/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\b(parc|parcela|compra|cartao|debito|credito|pix|enviado|pagamento)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ");
}

// Conversão das categorias do Pluggy. Os nomes do Pluggy vêm em inglês;
// a correspondência é por trecho de texto, então "Food and drinks" e
// "Eating out" caem em Comida. A lista oficial de categorias do Pluggy será
// conferida no módulo 4, quando a integração for feita.
const PLUGGY_MAP: ReadonlyArray<[RegExp, CategoryId]> = [
  [/food|restaurant|eating out|groceries|supermarket|bakery|delivery/i, "comida"],
  [/rent|housing|utilit|electricity|water|gas bill|internet|telecom|phone|education|school|insurance|condominium|subscription/i, "contas_fixas"],
  [/health|pharmac|drugstore|hospital|medical|doctor|vehicle maintenance|car repair|fine/i, "imprevistos"],
];

// Palavras-chave em português, já sem acento, procuradas na chave normalizada.
const KEYWORD_MAP: ReadonlyArray<[RegExp, CategoryId]> = [
  [/\b(mercado|supermercado|padaria|restaurante|lanchonete|ifood|acougue|hortifruti|pizzaria|cafe|bar)\b/, "comida"],
  [/\b(aluguel|condominio|energia|luz|agua|saneamento|internet|telefone|celular|mensalidade|escola|faculdade|seguro|iptu|ipva)\b/, "contas_fixas"],
  [/\b(farmacia|drogaria|hospital|clinica|laboratorio|oficina|mecanico|guincho|multa|conserto|veterinario)\b/, "imprevistos"],
];

/** Uma transação conta como gasto? Entradas, transferências entre contas próprias e pagamento de fatura não contam (RF19). */
export function isSpending(t: Pick<CategorizationInput, "direction" | "isInternalTransfer" | "isCardBillPayment">): boolean {
  return t.direction === "debit" && !t.isInternalTransfer && !t.isCardBillPayment;
}

/**
 * Decide a categoria de uma transação. Devolve null para o que não é gasto,
 * porque essas transações ficam sem categoria (etapa 3, campo category_id).
 * `userRules` mapeia chave de estabelecimento para categoria (RF18).
 */
export function categorize(
  input: CategorizationInput,
  userRules: ReadonlyMap<string, CategoryId> = new Map(),
): CategorizationResult | null {
  if (!isSpending(input)) return null;
  const merchantKey = normalizeMerchant(input.description);

  const ruled = userRules.get(merchantKey);
  if (ruled) return { categoryId: ruled, source: "user_rule", merchantKey };

  if (input.pluggyCategory) {
    const match = PLUGGY_MAP.find(([re]) => re.test(input.pluggyCategory ?? ""));
    if (match) return { categoryId: match[1], source: "pluggy", merchantKey };
  }

  const kw = KEYWORD_MAP.find(([re]) => re.test(merchantKey));
  if (kw) return { categoryId: kw[1], source: "keyword", merchantKey };

  return { categoryId: "outros", source: "default", merchantKey };
}
