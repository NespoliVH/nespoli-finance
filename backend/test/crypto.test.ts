import { describe, expect, it } from "vitest";
import { BlindIndexContext, blindIndex, decryptField, encryptField } from "../src/lib/crypto.js";
import { testKey } from "./helpers.js";

describe("criptografia de campo (AES-256-GCM)", () => {
  it("recupera o valor original com a mesma chave", () => {
    const key = testKey();
    const cifrado = encryptField("item-123-abc", key);
    expect(decryptField(cifrado, key)).toBe("item-123-abc");
  });

  it("gera resultados diferentes para o mesmo valor (IV aleatório)", () => {
    const key = testKey();
    const a = encryptField("mesmo valor", key);
    const b = encryptField("mesmo valor", key);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("não guarda o valor em texto puro", () => {
    const cifrado = encryptField("12345-6", testKey());
    expect(Buffer.from(cifrado).toString("utf8")).not.toContain("12345-6");
  });

  it("recusa a leitura com outra chave", () => {
    const cifrado = encryptField("segredo", testKey());
    expect(() => decryptField(cifrado, testKey())).toThrow();
  });

  it("detecta um byte alterado no banco", () => {
    const key = testKey();
    const cifrado = encryptField("segredo", key);
    const ultimo = cifrado.length - 1;
    cifrado[ultimo] = (cifrado[ultimo] ?? 0) ^ 0xff;
    expect(() => decryptField(cifrado, key)).toThrow();
  });

  it("recusa chaves que não têm 256 bits", () => {
    expect(() => encryptField("x", Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe("índice cego (HMAC-SHA256)", () => {
  it("é determinístico, o que permite buscar", () => {
    const key = testKey();
    expect(blindIndex("item-1", key, BlindIndexContext.pluggyItem)).toBe(
      blindIndex("item-1", key, BlindIndexContext.pluggyItem),
    );
  });

  it("muda com a chave, então não pode ser recalculado sem ela", () => {
    expect(blindIndex("item-1", testKey(), "c")).not.toBe(blindIndex("item-1", testKey(), "c"));
  });

  it("separa contextos diferentes", () => {
    const key = testKey();
    expect(blindIndex("abc", key, BlindIndexContext.pluggyItem)).not.toBe(
      blindIndex("abc", key, BlindIndexContext.consentSubject),
    );
  });
});
