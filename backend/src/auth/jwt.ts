import { createHmac, createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import { safeEqualText } from "../lib/crypto.js";

// JWT (JSON Web Token) feito só com o módulo crypto do Node, sem biblioteca:
// são poucas linhas e assim cada passo da verificação fica visível no código.
// Um JWT tem três partes em base64url separadas por ponto: cabeçalho,
// conteúdo (claims) e assinatura.

export type Claims = Record<string, unknown>;

export class JwtError extends Error {}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function parseJson(part: string, what: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new JwtError(`${what} inválido`);
  }
}

export function decode(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("formato inválido");
  const [h, p, s] = parts as [string, string, string];
  return { header: parseJson(h, "cabeçalho"), claims: parseJson(p, "conteúdo"), signingInput: `${h}.${p}`, signature: Buffer.from(s, "base64url") };
}

/** Assina com HMAC-SHA256 (HS256): usado no token de acesso do próprio backend. */
export function signHs256(claims: Claims, key: Buffer): string {
  const input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(createHmac("sha256", key).update(input).digest())}`;
}

export function verifyHs256(token: string, key: Buffer): Claims {
  const { header, claims, signingInput, signature } = decode(token);
  // Só aceita o algoritmo esperado: evita o ataque de trocar "alg" no cabeçalho.
  if (header.alg !== "HS256") throw new JwtError("algoritmo inesperado");
  const expected = createHmac("sha256", key).update(signingInput).digest("base64url");
  if (!safeEqualText(expected, signature.toString("base64url"))) throw new JwtError("assinatura inválida");
  return claims;
}

/** Verifica RS256 com uma chave pública no formato JWK (como a Apple publica). */
export function verifyRs256(token: string, jwk: JsonWebKey): Claims {
  const { header, claims, signingInput, signature } = decode(token);
  if (header.alg !== "RS256") throw new JwtError("algoritmo inesperado");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (!verifySignature("RSA-SHA256", Buffer.from(signingInput), key, signature)) throw new JwtError("assinatura inválida");
  return claims;
}
