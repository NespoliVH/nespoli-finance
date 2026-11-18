import { describe, expect, it } from "vitest";
import { evaluateAlert, monthStart } from "../../src/rules/alerts.js";

describe("evaluateAlert (RN02 a RN04)", () => {
  it("alerta quando passa de 30% acima da média e a diferença é de pelo menos R$ 50", () => {
    // média de 600, 690 e 780 = 690,00; 980,00 é 42,03% acima
    expect(evaluateAlert(98_000, [60_000, 69_000, 78_000])).toEqual({
      alert: true,
      currentCents: 98_000,
      averageCents: 69_000,
      increasePct: 42.03,
    });
  });

  it("usa no máximo os 3 meses mais recentes", () => {
    const r = evaluateAlert(98_000, [60_000, 69_000, 78_000, 1_000_000]);
    expect(r).toMatchObject({ alert: true, averageCents: 69_000 });
  });

  it("exatamente 30% acima não dispara (precisa passar de 30%)", () => {
    expect(evaluateAlert(130_000, [100_000, 100_000])).toEqual({ alert: false, reason: "below_threshold" });
    expect(evaluateAlert(130_001, [100_000, 100_000]).alert).toBe(true);
  });

  it("não alerta em categoria pequena: 100% de aumento, mas só R$ 20", () => {
    expect(evaluateAlert(4_000, [2_000, 2_000])).toEqual({ alert: false, reason: "below_threshold" });
  });

  it("exige pelo menos 2 meses de histórico (RN03)", () => {
    expect(evaluateAlert(100_000, [10_000])).toEqual({ alert: false, reason: "insufficient_history" });
    expect(evaluateAlert(100_000, [])).toEqual({ alert: false, reason: "insufficient_history" });
  });

  it("sem gasto na média não há base de comparação", () => {
    expect(evaluateAlert(100_000, [0, 0, 0])).toEqual({ alert: false, reason: "no_baseline" });
  });
});

describe("monthStart", () => {
  it("devolve o primeiro dia do mês em UTC", () => {
    expect(monthStart(new Date("2026-11-17T23:59:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
