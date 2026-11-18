import { evaluateUserAlerts } from "../alerts/evaluate.js";
import { notifyAlerts, type PushSender } from "../alerts/notify.js";
import { deleteTransactions, syncConnection, type SyncDeps } from "../connections/sync.js";
import type { JobHandlers } from "./queue.js";

export interface WorkerDeps extends SyncDeps {
  /** Envio da notificação; null enquanto não há APNs (conta paga da Apple). */
  push?: PushSender | null;
}

/** Sincroniza e, se chegou algo novo, avalia os alertas do usuário e avisa dos novos (RF23, RF24). */
export async function syncAndAlert(deps: WorkerDeps, connectionId: string) {
  const result = await syncConnection(deps, connectionId);
  if (!result || result.created + result.updated === 0) return { result, alerts: 0, pushed: 0 };
  const conn = await deps.prisma.connection.findUniqueOrThrow({ where: { id: connectionId }, select: { userId: true } });
  const alerts = await evaluateUserAlerts(deps.prisma, conn.userId, deps.now?.() ?? new Date());
  const pushed = await notifyAlerts(deps.prisma, deps.push ?? null, alerts);
  return { result, alerts: alerts.length, pushed };
}

// O que cada tarefa da fila faz. Fica separado da fila para os testes
// chamarem os mesmos trabalhadores sem o pg-boss.
export function buildHandlers(deps: WorkerDeps): JobHandlers {
  return {
    "sync-connection": ({ connectionId }) => syncAndAlert(deps, connectionId),
    "delete-transactions": ({ connectionId, pluggyTransactionIds }) =>
      deleteTransactions(deps.prisma, connectionId, pluggyTransactionIds),
  };
}
