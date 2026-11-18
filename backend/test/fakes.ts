import type { FastifyRequest } from "fastify";
import type { JobName, JobPayloads, JobQueue } from "../src/jobs/queue.js";
import type { PluggyAccount, PluggyApi, PluggyItem, PluggyTransaction } from "../src/pluggy/client.js";
import { PluggyError } from "../src/pluggy/client.js";

/** Pluggy falso em memória, com os dados de um banco de mentira. */
export class FakePluggy implements PluggyApi {
  items = new Map<string, PluggyItem>();
  accounts = new Map<string, PluggyAccount[]>();
  transactions = new Map<string, PluggyTransaction[]>();
  deleted: string[] = [];
  tokens: Array<{ clientUserId: string; itemId?: string }> = [];
  lastDateFrom: string | undefined;

  addItem(id: string, clientUserId: string, extra: Partial<PluggyItem> = {}) {
    this.items.set(id, { id, status: "UPDATED", clientUserId, connector: { name: "Pluggy Bank" }, ...extra });
  }

  async createConnectToken(o: { clientUserId: string; itemId?: string }) {
    this.tokens.push({ clientUserId: o.clientUserId, itemId: o.itemId });
    return `token-${this.tokens.length}`;
  }
  async getItem(id: string) {
    const item = this.items.get(id);
    if (!item) throw new PluggyError("not found", 404);
    return item;
  }
  async deleteItem(id: string) {
    this.deleted.push(id);
    this.items.delete(id);
  }
  async listAccounts(itemId: string) {
    return this.accounts.get(itemId) ?? [];
  }
  async listTransactions(accountId: string, o: { dateFrom?: string }) {
    this.lastDateFrom = o.dateFrom;
    return this.transactions.get(accountId) ?? [];
  }
}

/** Fila em memória: guarda as tarefas para o teste conferir e rodar. */
export class MemoryQueue implements JobQueue {
  jobs: Array<{ name: JobName; data: unknown }> = [];
  async send<K extends JobName>(name: K, data: JobPayloads[K]) {
    this.jobs.push({ name, data });
  }
}

export function pluggyTx(id: string, accountId: string, extra: Partial<PluggyTransaction> = {}): PluggyTransaction {
  return {
    id,
    accountId,
    date: new Date("2026-11-10T15:00:00Z"),
    description: "SUPERMERCADO BOM PRECO",
    amount: -123.45,
    type: "DEBIT",
    status: "POSTED",
    category: "Groceries",
    ...extra,
  };
}

/** Nos testes, o usuário vem de um cabeçalho. No app real virá do login (módulo 3). */
export const testAuth = async (req: FastifyRequest) => (req.headers["x-test-user"] as string | undefined) ?? null;
