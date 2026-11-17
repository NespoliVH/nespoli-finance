import { deleteTransactions, syncConnection, type SyncDeps } from "../connections/sync.js";
import type { JobHandlers } from "./queue.js";

// O que cada tarefa da fila faz. Fica separado da fila para os testes
// chamarem os mesmos trabalhadores sem o pg-boss.
export function buildHandlers(deps: SyncDeps): JobHandlers {
  return {
    "sync-connection": ({ connectionId }) => syncConnection(deps, connectionId),
    "delete-transactions": ({ connectionId, pluggyTransactionIds }) =>
      deleteTransactions(deps.prisma, connectionId, pluggyTransactionIds),
  };
}
