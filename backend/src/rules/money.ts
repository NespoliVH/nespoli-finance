// Dinheiro é sempre inteiro em centavos (etapa 3, seção 4.1).
// Percentuais e alíquotas são guardados em pontos-base (1% = 100 pontos-base),
// para que toda conta seja feita com inteiros e o arredondamento aconteça
// em um único lugar.

export type Cents = number;

/** Aplica uma alíquota em pontos-base a um valor em centavos, arredondando ao centavo. */
export function applyRate(amount: Cents, basisPoints: number): Cents {
  return Math.round((amount * basisPoints) / 10_000);
}

/** Converte reais (número decimal da configuração) em centavos inteiros. */
export function reaisToCents(reais: number): Cents {
  return Math.round(reais * 100);
}

export function sum(values: readonly Cents[]): Cents {
  return values.reduce((acc, v) => acc + v, 0);
}
