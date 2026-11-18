import { z } from "zod";

// Cliente mínimo da API do Pluggy (módulo 4).
//
// Por que não usar o SDK oficial (pluggy-sdk)? O app usa só seis chamadas, e
// um cliente próprio de ~150 linhas sobre o fetch do Node é mais fácil de
// explicar, de testar com respostas falsas e não traz dependências extras.
// Os nomes das rotas e dos campos foram conferidos nas definições de tipos do
// SDK oficial, versão 0.94.3.
//
// Toda resposta passa por um esquema Zod: dado que vem de fora é validado
// antes de ser usado, e campos que o app não usa são descartados.

const itemSchema = z.object({
  id: z.string(),
  status: z.string(),
  executionStatus: z.string().nullish(),
  clientUserId: z.string().nullish(),
  consentExpiresAt: z.coerce.date().nullish(),
  lastUpdatedAt: z.coerce.date().nullish(),
  connector: z.object({ name: z.string() }),
});

const accountSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  type: z.string(), // BANK ou CREDIT
  subtype: z.string().nullish(), // CHECKING_ACCOUNT, SAVINGS_ACCOUNT, CREDIT_CARD
  name: z.string(),
  marketingName: z.string().nullish(),
  number: z.string().nullish(),
  balance: z.number(),
});

const transactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.coerce.date(),
  description: z.string(),
  amount: z.number(),
  type: z.enum(["DEBIT", "CREDIT"]),
  status: z.string().nullish(), // PENDING ou POSTED
  category: z.string().nullish(),
});

const accountsPage = z.object({ results: z.array(accountSchema) });
const transactionsPage = z.object({ results: z.array(transactionSchema), next: z.string().nullish() });

export type PluggyItem = z.infer<typeof itemSchema>;
export type PluggyAccount = z.infer<typeof accountSchema>;
export type PluggyTransaction = z.infer<typeof transactionSchema>;

/** O que o resto do backend usa do Pluggy. Os testes trocam por uma versão falsa. */
export interface PluggyApi {
  createConnectToken(options: { clientUserId: string; webhookUrl?: string; itemId?: string }): Promise<string>;
  getItem(itemId: string): Promise<PluggyItem>;
  deleteItem(itemId: string): Promise<void>;
  listAccounts(itemId: string): Promise<PluggyAccount[]>;
  listTransactions(accountId: string, options: { dateFrom?: string }): Promise<PluggyTransaction[]>;
}

export class PluggyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface ClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

// A chave de API do Pluggy vale 2 horas. Renovamos com folga, e também
// quando a API responde 401.
const API_KEY_TTL_MS = 100 * 60 * 1000;
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 200;

export class PluggyClient implements PluggyApi {
  private apiKey: { value: string; expiresAt: number } | null = null;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async createConnectToken(options: { clientUserId: string; webhookUrl?: string; itemId?: string }): Promise<string> {
    const body = {
      itemId: options.itemId,
      options: { clientUserId: options.clientUserId, webhookUrl: options.webhookUrl, avoidDuplicates: true },
    };
    const res = await this.request("POST", "connect_token", { body });
    return z.object({ accessToken: z.string() }).parse(res).accessToken;
  }

  async getItem(itemId: string): Promise<PluggyItem> {
    return itemSchema.parse(await this.request("GET", `items/${encodeURIComponent(itemId)}`));
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.request("DELETE", `items/${encodeURIComponent(itemId)}`);
  }

  async listAccounts(itemId: string): Promise<PluggyAccount[]> {
    return accountsPage.parse(await this.request("GET", "accounts", { query: { itemId } })).results;
  }

  /** Busca todas as páginas da listagem por cursor (rota v2/transactions). */
  async listTransactions(accountId: string, options: { dateFrom?: string }): Promise<PluggyTransaction[]> {
    const all: PluggyTransaction[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = transactionsPage.parse(
        await this.request("GET", "v2/transactions", { query: { accountId, dateFrom: options.dateFrom, after } }),
      );
      all.push(...res.results);
      after = res.next ? (new URL(res.next, this.baseUrl).searchParams.get("after") ?? undefined) : undefined;
      if (!after) return all;
    }
    throw new PluggyError("Paginação de transações não terminou");
  }

  private async getApiKey(): Promise<string> {
    if (this.apiKey && this.apiKey.expiresAt > this.now()) return this.apiKey.value;
    const res = await this.send("POST", "auth", {
      body: { clientId: this.options.clientId, clientSecret: this.options.clientSecret, nonExpiring: false },
    });
    if (!res.ok) throw new PluggyError("Falha ao autenticar no Pluggy", res.status);
    const { apiKey } = z.object({ apiKey: z.string() }).parse(await res.json());
    this.apiKey = { value: apiKey, expiresAt: this.now() + API_KEY_TTL_MS };
    return apiKey;
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const apiKey = await this.getApiKey();
      const res = await this.send(method, path, { ...opts, apiKey });
      if (res.status === 401 && attempt === 0) {
        this.apiKey = null; // chave venceu antes do previsto: pede outra e tenta de novo
        continue;
      }
      if (!res.ok) throw new PluggyError(`Pluggy respondeu ${res.status} em ${method} /${path.split("/")[0]}`, res.status);
      return res.status === 204 ? null : res.json();
    }
    throw new PluggyError("Pluggy recusou a chave de API", 401);
  }

  private send(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined>; apiKey?: string },
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiKey) headers["X-API-KEY"] = opts.apiKey;
    return this.fetchFn(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // A chave de API nunca segue um redirecionamento para outro endereço.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}
