import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const chave = Buffer.alloc(32, 1).toString("base64");

describe("configuração", () => {
  it("aceita uma configuração completa", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://x", FIELD_ENCRYPTION_KEY: chave, BLIND_INDEX_KEY: chave });
    expect(env.PORT).toBe(3000);
  });

  it("não inicia sem a chave de criptografia", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://x", BLIND_INDEX_KEY: chave })).toThrow(/FIELD_ENCRYPTION_KEY/);
  });

  it("não inicia com uma chave curta", () => {
    const curta = Buffer.alloc(16).toString("base64");
    expect(() =>
      loadEnv({ DATABASE_URL: "postgresql://x", FIELD_ENCRYPTION_KEY: curta, BLIND_INDEX_KEY: chave }),
    ).toThrow(/32 bytes/);
  });

  it("exige as três configurações do Pluggy juntas", () => {
    const base = { DATABASE_URL: "postgresql://x", FIELD_ENCRYPTION_KEY: chave, BLIND_INDEX_KEY: chave };
    expect(() => loadEnv({ ...base, PLUGGY_CLIENT_ID: "id" })).toThrow(/preencha as três/);
    const env = loadEnv({ ...base, PLUGGY_CLIENT_ID: "id", PLUGGY_CLIENT_SECRET: "s", PLUGGY_WEBHOOK_SECRET: "w".repeat(32) });
    expect(env.PLUGGY_API_URL).toBe("https://api.pluggy.ai");
  });
});
