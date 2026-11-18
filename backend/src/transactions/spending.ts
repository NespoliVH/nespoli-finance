import type { Prisma } from "../generated/prisma/client.js";

// "Gasto" tem uma definição só, usada no resumo, na lista e nos alertas: saída
// de dinheiro que não é transferência entre contas próprias nem pagamento de
// fatura (RF19). O pagamento da fatura ficaria contado duas vezes: uma em
// cada compra no cartão e outra quando a conta corrente paga a fatura.
export const spendingWhere = {
  direction: "debit",
  isInternalTransfer: false,
  isCardBillPayment: false,
} satisfies Prisma.TransactionWhereInput;
