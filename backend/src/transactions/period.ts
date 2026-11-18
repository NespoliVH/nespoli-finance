import { brazilDate } from "../pluggy/mapping.js";

// Período do resumo (RN07): o mês de calendário, do dia 1 ao último dia.
// As datas das transações já estão gravadas no fuso de São Paulo (módulo 4),
// então o mês é só um intervalo de datas: [dia 1, dia 1 do mês seguinte).

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MonthRange {
  month: string; // "2026-11"
  start: Date; // 2026-11-01
  end: Date; // 2026-12-01 (exclusivo)
}

export function monthRange(month: string): MonthRange {
  if (!MONTH_PATTERN.test(month)) throw new Error(`Mês inválido: ${month}`);
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { month, start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

/** O mês corrente no Brasil. Às 22h do dia 31 em São Paulo ainda é o mesmo mês, mesmo que em UTC já seja o seguinte. */
export function currentMonth(now: Date): string {
  return brazilDate(now).toISOString().slice(0, 7);
}

/** Data gravada (meia-noite UTC) como texto "AAAA-MM-DD", para o app não precisar lidar com fuso. */
export function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
