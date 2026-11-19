import { createHash, type JsonWebKey } from "node:crypto";
import { decode, JwtError, verifyRs256 } from "./jwt.js";

// Verificação do "Iniciar sessão com a Apple" (RF01). O app recebe da Apple
// um identityToken (um JWT assinado pela Apple) e o manda para cá. O backend
// não confia no app: confere a assinatura com as chaves públicas da Apple e
// cada campo do token antes de criar a sessão.

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";

export interface AppleIdentity {
  /** Identificador estável do usuário na Apple ("sub"), o mesmo em todo login. */
  sub: string;
  email?: string;
  emailVerified: boolean;
  /** E-mail de retransmissão da Apple, quando a pessoa escolhe esconder o seu. */
  isPrivateEmail: boolean;
}

export type AppleKeySource = (kid: string) => Promise<JsonWebKey | null>;

/**
 * Busca as chaves públicas da Apple e guarda por um tempo. Se aparecer um
 * "kid" desconhecido (a Apple troca as chaves de tempos em tempos), busca de novo.
 */
export function appleKeysFromNetwork(fetchImpl: typeof fetch = fetch, ttlMs = 6 * 60 * 60 * 1000): AppleKeySource {
  let cache: { keys: Map<string, JsonWebKey>; at: number } | null = null;
  async function load() {
    const res = await fetchImpl(APPLE_KEYS_URL);
    if (!res.ok) throw new Error(`Chaves da Apple indisponíveis (${res.status})`);
    const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
    cache = { keys: new Map(body.keys.map((k) => [k.kid, k])), at: Date.now() };
    return cache.keys;
  }
  return async (kid) => {
    let keys = cache && Date.now() - cache.at < ttlMs ? cache.keys : await load();
    if (!keys.has(kid)) keys = await load();
    return keys.get(kid) ?? null;
  };
}

/** O app manda o nonce em texto; a Apple devolve no token o SHA-256 dele em hexadecimal. */
export function hashNonce(rawNonce: string): string {
  return createHash("sha256").update(rawNonce, "utf8").digest("hex");
}

export async function verifyAppleIdentityToken(
  token: string,
  opts: { keys: AppleKeySource; audience: string; rawNonce: string; now?: Date },
): Promise<AppleIdentity> {
  const { header } = decode(token);
  if (typeof header.kid !== "string") throw new JwtError("token sem kid");
  const jwk = await opts.keys(header.kid);
  if (!jwk) throw new JwtError("chave da Apple desconhecida");
  const c = verifyRs256(token, jwk);

  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  // Quem emitiu tem de ser a Apple.
  if (c.iss !== APPLE_ISSUER) throw new JwtError("emissor inválido");
  // O token tem de ter sido emitido para este app (o bundle id), e não para outro.
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.audience)) throw new JwtError("destinatário inválido");
  // Tolerância de 60 s para relógios levemente diferentes.
  if (typeof c.exp !== "number" || c.exp < nowSec - 60) throw new JwtError("token expirado");
  // O nonce amarra o token a este pedido de login: um token copiado de outro
  // login não serve, porque o nonce não bate.
  if (typeof c.nonce !== "string" || c.nonce !== hashNonce(opts.rawNonce)) throw new JwtError("nonce inválido");
  if (typeof c.sub !== "string" || c.sub.length === 0) throw new JwtError("token sem usuário");

  const flag = (v: unknown) => v === true || v === "true";
  return {
    sub: c.sub,
    email: typeof c.email === "string" ? c.email : undefined,
    emailVerified: flag(c.email_verified),
    isPrivateEmail: flag(c.is_private_email),
  };
}
