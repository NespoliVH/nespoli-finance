import type { PrismaClient } from "../db.js";
import { decryptField, encryptField } from "../lib/crypto.js";
import type { PluggyApi } from "../pluggy/client.js";
import { connectionStatusFromItem, mapAccount, mapTransaction } from "../pluggy/mapping.js";
import { categorize, type CategoryId } from "../rules/categorization.js";
import { suggestTaxableIncome } from "../rules/income.js";

// Sincronização de uma conexão (RF10 a RF12). Roda na fila, nunca dentro da
// requisição do webhook, porque buscar 13 meses de transações pode demorar.
//
// Passos:
//   1. lê o item no Pluggy e atualiza o estado da conexão
//   2. se o item ainda está atualizando, para: o Pluggy avisa de novo quando terminar
//   3. grava ou atualiza as contas
//   4. busca as transações desde a última sincronização (com margem) e grava
//      só as novas; as que já existem têm valor, data e situação atualizados
//      mas a categoria fica como está, para não desfazer correções do usuário

export interface SyncDeps {
  prisma: PrismaClient;
  pluggy: PluggyApi;
  fieldKey: Buffer;
  now?: () => Date;
}

export const FIRST_SYNC_MONTHS = 13; // um ano de histórico para o IR, mais o mês corrente
export const RESYNC_MARGIN_DAYS = 30; // transações pendentes podem mudar por algumas semanas

export interface SyncResult {
  status: string;
  accounts: number;
  created: number;
  updated: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function syncStartDate(lastSyncedAt: Date | null, now: Date): Date {
  const start = new Date(now);
  if (lastSyncedAt) {
    start.setTime(lastSyncedAt.getTime() - RESYNC_MARGIN_DAYS * 86_400_000);
  } else {
    start.setUTCMonth(start.getUTCMonth() - FIRST_SYNC_MONTHS, 1);
  }
  return start;
}

export async function syncConnection(deps: SyncDeps, connectionId: string): Promise<SyncResult | null> {
  const { prisma, pluggy, fieldKey } = deps;
  const now = deps.now?.() ?? new Date();

  const connection = await prisma.connection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.status === "revoked") return null; // excluída enquanto esperava na fila

  const itemId = decryptField(connection.pluggyItemIdEnc, fieldKey);
  const item = await pluggy.getItem(itemId);
  const status = connectionStatusFromItem(item, now);

  await prisma.connection.update({
    where: { id: connection.id },
    data: { status, consentExpiresAt: item.consentExpiresAt ?? null, institutionName: item.connector.name },
  });
  if (status !== "active") return { status, accounts: 0, created: 0, updated: 0 };

  const rules = await prisma.categoryRule.findMany({ where: { userId: connection.userId } });
  const userRules = new Map(rules.map((r) => [r.merchantKey, r.categoryId as CategoryId]));
  const dateFrom = isoDate(syncStartDate(connection.lastSyncedAt, now));

  let created = 0;
  let updated = 0;
  const pluggyAccounts = await pluggy.listAccounts(itemId);

  for (const pa of pluggyAccounts) {
    const a = mapAccount(pa);
    const accountData = {
      type: a.type,
      name: a.name,
      numberEnc: a.number ? encryptField(a.number, fieldKey) : null,
      numberLast4: a.numberLast4,
      balanceCents: BigInt(a.balanceCents),
    };
    const existing = await prisma.account.findUnique({ where: { pluggyAccountId: a.pluggyAccountId } });
    // Uma conta do Pluggy pertence a uma única conexão; se aparecer em outra, algo está errado.
    if (existing && existing.connectionId !== connection.id) {
      throw new Error("Conta do Pluggy já vinculada a outra conexão");
    }
    const account = existing
      ? await prisma.account.update({ where: { id: existing.id }, data: accountData })
      : await prisma.account.create({
          data: { ...accountData, pluggyAccountId: a.pluggyAccountId, connectionId: connection.id, userId: connection.userId },
        });

    const txs = (await pluggy.listTransactions(pa.id, { dateFrom }))
      .map(mapTransaction)
      .filter((t): t is NonNullable<typeof t> => t !== null);
    if (txs.length === 0) continue;

    const known = await prisma.transaction.findMany({
      where: { pluggyTransactionId: { in: txs.map((t) => t.pluggyTransactionId) } },
      select: { pluggyTransactionId: true },
    });
    const knownIds = new Set(known.map((k) => k.pluggyTransactionId));

    const fresh = txs.filter((t) => !knownIds.has(t.pluggyTransactionId));
    if (fresh.length > 0) {
      const res = await prisma.transaction.createMany({
        // skipDuplicates: se duas sincronizações correrem juntas, a chave única
        // em pluggy_transaction_id descarta a cópia em vez de dar erro (RF12).
        skipDuplicates: true,
        data: fresh.map((t) => {
          const cat = categorize(t, userRules);
          return {
            accountId: account.id,
            userId: connection.userId,
            pluggyTransactionId: t.pluggyTransactionId,
            date: t.date,
            description: t.description,
            merchantKey: cat?.merchantKey ?? null,
            direction: t.direction,
            amountCents: BigInt(t.amountCents),
            status: t.status,
            pluggyCategory: t.pluggyCategory,
            categoryId: cat?.categoryId ?? null,
            categorySource: cat?.source ?? null,
            isInternalTransfer: t.isInternalTransfer,
            isCardBillPayment: t.isCardBillPayment,
            // RF25: só sugere; quem confirma é o usuário.
            taxableIncome: suggestTaxableIncome(t) ? "suggested" : "no",
          } as const;
        }),
      });
      created += res.count;
    }

    const changed = txs.filter((t) => knownIds.has(t.pluggyTransactionId));
    if (changed.length > 0) {
      await prisma.$transaction(
        changed.map((t) =>
          prisma.transaction.update({
            where: { pluggyTransactionId: t.pluggyTransactionId },
            data: { date: t.date, description: t.description, amountCents: BigInt(t.amountCents), status: t.status },
          }),
        ),
      );
      updated += changed.length;
    }
  }

  await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: now } });
  return { status, accounts: pluggyAccounts.length, created, updated };
}

/** Remove transações que o banco apagou (webhook transactions/deleted), só dentro da conexão certa. */
export async function deleteTransactions(prisma: PrismaClient, connectionId: string, pluggyIds: string[]): Promise<number> {
  const res = await prisma.transaction.deleteMany({
    where: { pluggyTransactionId: { in: pluggyIds }, account: { connectionId } },
  });
  return res.count;
}
