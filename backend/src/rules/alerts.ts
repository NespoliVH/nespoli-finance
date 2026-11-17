import type { Cents } from "./money.js";

// Regra de alerta de gasto (RN02 a RN04).
//
// Há alerta quando o gasto do mês em uma categoria passa de 30% acima da
// média dos meses completos anteriores (até 3) E a diferença é de pelo menos
// R$ 50. O valor mínimo evita alertas bobos em categorias pequenas: de R$ 10
// para R$ 20 é 100% de aumento, mas não interessa a ninguém.
// Sem pelo menos 2 meses completos de histórico não há média confiável (RN03).
// A garantia de no máximo um alerta por categoria por mês (RN04) fica no banco.

export const ALERT_RULE = {
  thresholdBasisPoints: 13_000, // 130% da média, ou seja, 30% acima
  minDifferenceCents: 5_000, // R$ 50,00
  historyMonths: 3,
  minHistoryMonths: 2,
} as const;

export type AlertDecision =
  | { alert: true; currentCents: Cents; averageCents: Cents; increasePct: number }
  | { alert: false; reason: "insufficient_history" | "no_baseline" | "below_threshold" };

/**
 * @param currentCents gasto do mês atual na categoria
 * @param previousMonthsCents gastos dos meses completos anteriores, do mais recente para o mais antigo
 */
export function evaluateAlert(currentCents: Cents, previousMonthsCents: readonly Cents[]): AlertDecision {
  const history = previousMonthsCents.slice(0, ALERT_RULE.historyMonths);
  if (history.length < ALERT_RULE.minHistoryMonths) {
    return { alert: false, reason: "insufficient_history" };
  }
  const averageCents = Math.round(history.reduce((a, b) => a + b, 0) / history.length);
  // Sem gasto nenhum na média não existe "aumento percentual" que faça sentido.
  if (averageCents === 0) return { alert: false, reason: "no_baseline" };

  const aboveThreshold = currentCents * 10_000 > averageCents * ALERT_RULE.thresholdBasisPoints;
  const bigEnough = currentCents - averageCents >= ALERT_RULE.minDifferenceCents;
  if (!aboveThreshold || !bigEnough) return { alert: false, reason: "below_threshold" };

  const increasePct = Math.round(((currentCents - averageCents) / averageCents) * 10_000) / 100;
  return { alert: true, currentCents, averageCents, increasePct };
}

/** Primeiro dia do mês, em UTC: o formato de reference_month no banco. */
export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
