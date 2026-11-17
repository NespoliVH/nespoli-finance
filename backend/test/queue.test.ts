import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/app.js";
import { Jobs, PgBossQueue } from "../src/jobs/queue.js";

describe("fila com pg-boss", () => {
  it("entrega a tarefa ao trabalhador", async () => {
    const queue = await PgBossQueue.start(process.env.TEST_DATABASE_URL!);
    try {
      const received = new Promise<unknown>((resolve) => {
        void queue.work({
          [Jobs.syncConnection]: async (data) => resolve(data),
          [Jobs.deleteTransactions]: async () => undefined,
        });
      });
      await queue.send(Jobs.syncConnection, { connectionId: "c-1" });
      await expect(received).resolves.toEqual({ connectionId: "c-1" });
    } finally {
      await queue.stop();
    }
  }, 20_000);
});

describe("log", () => {
  it("não grava o segredo do webhook", () => {
    expect(redactUrl("/webhooks/pluggy/abc123?x=1")).toBe("/webhooks/pluggy/[removido]?x=1");
    expect(redactUrl("/connections")).toBe("/connections");
  });
});
