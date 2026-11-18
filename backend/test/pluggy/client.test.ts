import { describe, expect, it } from "vitest";
import { PluggyClient, PluggyError } from "../../src/pluggy/client.js";

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };

/** fetch falso: responde conforme a rota e anota cada chamada. */
function fakeFetch(routes: (c: Call, n: number) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (input: URL, init: RequestInit) => {
    const call = {
      method: init.method ?? "GET",
      url: input,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const r = routes(call, calls.length);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const item = { id: "item-1", status: "UPDATED", clientUserId: "u1", connector: { name: "Pluggy Bank" }, extra: "ignorado" };

function client(fetchFn: typeof fetch, now = () => 0) {
  return new PluggyClient({ baseUrl: "https://api.example/", clientId: "id", clientSecret: "secret", fetch: fetchFn, now });
}

describe("PluggyClient", () => {
  it("autentica uma vez e reaproveita a chave de API", async () => {
    const { fn, calls } = fakeFetch((c) => (c.url.pathname === "/auth" ? { body: { apiKey: "k1" } } : { body: item }));
    const pluggy = client(fn);
    await pluggy.getItem("item-1");
    await pluggy.getItem("item-1");
    expect(calls.map((c) => c.url.pathname)).toEqual(["/auth", "/items/item-1", "/items/item-1"]);
    expect(calls[0]?.body).toMatchObject({ clientId: "id", clientSecret: "secret" });
    expect(calls[1]?.headers["X-API-KEY"]).toBe("k1");
  });

  it("pede chave nova quando ela vence ou a API responde 401", async () => {
    let keys = 0;
    let t = 0;
    const { fn, calls } = fakeFetch((c, n) => {
      if (c.url.pathname === "/auth") return { body: { apiKey: `k${++keys}` } };
      return n === 2 ? { status: 401 } : { body: item };
    });
    const pluggy = client(fn, () => t);
    await pluggy.getItem("item-1"); // 401 na primeira, renova e repete
    expect(calls.filter((c) => c.url.pathname === "/auth")).toHaveLength(2);
    t = 2 * 60 * 60 * 1000; // duas horas depois
    await pluggy.getItem("item-1");
    expect(calls.filter((c) => c.url.pathname === "/auth")).toHaveLength(3);
  });

  it("valida a resposta e descarta campos que o app não usa", async () => {
    const { fn } = fakeFetch((c) => (c.url.pathname === "/auth" ? { body: { apiKey: "k" } } : { body: item }));
    const got = await client(fn).getItem("item-1");
    expect(got).not.toHaveProperty("extra");

    const bad = fakeFetch((c) => (c.url.pathname === "/auth" ? { body: { apiKey: "k" } } : { body: { id: 1 } }));
    await expect(client(bad.fn).getItem("item-1")).rejects.toThrow();
  });

  it("codifica o id no caminho, para um id malicioso não mudar a rota", async () => {
    const { fn, calls } = fakeFetch((c) => (c.url.pathname === "/auth" ? { body: { apiKey: "k" } } : { body: item }));
    await client(fn).getItem("../accounts?x=1");
    expect(calls[1]?.url.pathname).toBe("/items/..%2Faccounts%3Fx%3D1");
  });

  it("segue o cursor até a última página de transações", async () => {
    const tx = (id: string) => ({ id, accountId: "a1", date: "2026-11-10T10:00:00Z", description: "X", amount: -1, type: "DEBIT" });
    const { fn, calls } = fakeFetch((c) => {
      if (c.url.pathname === "/auth") return { body: { apiKey: "k" } };
      const after = c.url.searchParams.get("after");
      if (!after) return { body: { results: [tx("t1"), tx("t2")], next: "/v2/transactions?accountId=a1&after=c2" } };
      return { body: { results: [tx("t3")], next: null } };
    });
    const txs = await client(fn).listTransactions("a1", { dateFrom: "2025-10-01" });
    expect(txs.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(calls[1]?.url.searchParams.get("dateFrom")).toBe("2025-10-01");
    expect(calls[2]?.url.searchParams.get("after")).toBe("c2");
  });

  it("erro da API vira PluggyError com o código HTTP", async () => {
    const { fn } = fakeFetch((c) => (c.url.pathname === "/auth" ? { body: { apiKey: "k" } } : { status: 404, body: {} }));
    await expect(client(fn).getItem("x")).rejects.toMatchObject({ status: 404 });
    await expect(client(fn).getItem("x")).rejects.toBeInstanceOf(PluggyError);
  });

  it("manda clientUserId e webhookUrl no token do Connect", async () => {
    const { fn, calls } = fakeFetch((c) => (c.url.pathname === "/auth" ? { body: { apiKey: "k" } } : { body: { accessToken: "ct" } }));
    const token = await client(fn).createConnectToken({ clientUserId: "u1", webhookUrl: "https://x/webhooks/pluggy/s" });
    expect(token).toBe("ct");
    expect(calls[1]?.body).toMatchObject({ options: { clientUserId: "u1", webhookUrl: "https://x/webhooks/pluggy/s" } });
  });
});
