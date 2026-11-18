import { PgBoss } from "pg-boss";

// Fila de tarefas em segundo plano (seção de arquitetura: pg-boss).
//
// Por que uma fila? O Pluggy espera que o webhook responda em poucos
// segundos, e uma sincronização pode levar bem mais que isso. O webhook só
// anota "sincronizar a conexão X" e responde; um trabalhador faz o serviço.
// O pg-boss guarda as tarefas no próprio PostgreSQL, então não é preciso
// outro serviço (como Redis) só para isso, e uma tarefa que falha é tentada
// de novo com intervalo crescente.

export const Jobs = {
  syncConnection: "sync-connection",
  deleteTransactions: "delete-transactions",
} as const;

export interface JobPayloads {
  [Jobs.syncConnection]: { connectionId: string };
  [Jobs.deleteTransactions]: { connectionId: string; pluggyTransactionIds: string[] };
}

export type JobName = keyof JobPayloads;
export type JobHandlers = { [K in JobName]: (data: JobPayloads[K]) => Promise<unknown> };

/** O que as rotas usam: só enfileirar. Os testes trocam por uma fila em memória. */
export interface JobQueue {
  send<K extends JobName>(name: K, data: JobPayloads[K]): Promise<void>;
}

export class PgBossQueue implements JobQueue {
  private constructor(private readonly boss: PgBoss) {}

  static async start(connectionString: string): Promise<PgBossQueue> {
    const boss = new PgBoss({ connectionString, schema: "pgboss" });
    boss.on("error", (err) => console.error("[fila]", err.message));
    await boss.start();
    // "stately": no máximo uma sincronização esperando e uma rodando por
    // conexão. Dez webhooks seguidos do mesmo item viram uma só tarefa na fila.
    await boss.createQueue(Jobs.syncConnection, { policy: "stately", retryLimit: 5, retryBackoff: true, retryDelay: 30 });
    await boss.createQueue(Jobs.deleteTransactions, { retryLimit: 5, retryBackoff: true, retryDelay: 30 });
    return new PgBossQueue(boss);
  }

  async send<K extends JobName>(name: K, data: JobPayloads[K]): Promise<void> {
    const singletonKey = name === Jobs.syncConnection ? data.connectionId : undefined;
    await this.boss.send(name, data, { singletonKey });
  }

  async work(handlers: JobHandlers): Promise<void> {
    for (const name of Object.keys(handlers) as JobName[]) {
      await this.boss.work<JobPayloads[typeof name]>(name, async (jobs) => {
        for (const job of jobs) await (handlers[name] as (d: unknown) => Promise<unknown>)(job.data);
      });
    }
  }

  stop(): Promise<void> {
    return this.boss.stop({ graceful: true });
  }
}
