import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "../db.js";
import type { Authenticate } from "../http/auth.js";
import { JwtError, signHs256, verifyHs256 } from "./jwt.js";

// Sessão do app (RF02). Depois do login com a Apple o app recebe dois
// tokens do backend:
// - token de acesso: JWT curto (15 min), vai em toda requisição;
// - token de renovação: aleatório e longo (60 dias), só serve para pedir
//   um novo par. No banco fica apenas o SHA-256 dele, nunca o valor.
// O app guarda os dois no Keychain.

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 60;

export interface SessionDeps {
  prisma: PrismaClient;
  signingKey: Buffer;
  now?: () => Date;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export const hashRefreshToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

function newRefreshToken() {
  return randomBytes(32).toString("base64url");
}

function accessToken(userId: string, sessionId: string, now: Date, key: Buffer) {
  const iat = Math.floor(now.getTime() / 1000);
  return signHs256({ typ: "access", sub: userId, sid: sessionId, iat, exp: iat + ACCESS_TTL_SECONDS }, key);
}

const refreshExpiry = (now: Date) => new Date(now.getTime() + REFRESH_TTL_DAYS * 86_400_000);

export async function createSession(deps: SessionDeps, userId: string): Promise<TokenPair> {
  const now = deps.now?.() ?? new Date();
  const refreshToken = newRefreshToken();
  const session = await deps.prisma.session.create({
    data: { userId, refreshTokenHash: hashRefreshToken(refreshToken), expiresAt: refreshExpiry(now) },
  });
  return { accessToken: accessToken(userId, session.id, now, deps.signingKey), refreshToken, expiresIn: ACCESS_TTL_SECONDS };
}

/**
 * Troca o token de renovação por um par novo (rotação): o antigo deixa de
 * valer na hora. Devolve null se o token não existe, venceu ou foi revogado.
 */
export async function refreshSession(deps: SessionDeps, refreshToken: string): Promise<TokenPair | null> {
  const now = deps.now?.() ?? new Date();
  const session = await deps.prisma.session.findUnique({ where: { refreshTokenHash: hashRefreshToken(refreshToken) } });
  if (!session || session.revokedAt || session.expiresAt <= now) return null;
  const next = newRefreshToken();
  // A condição no hash garante que duas renovações simultâneas com o mesmo
  // token não gerem dois pares válidos: só a primeira acha a linha.
  const updated = await deps.prisma.session.updateMany({
    where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
    data: { refreshTokenHash: hashRefreshToken(next), expiresAt: refreshExpiry(now) },
  });
  if (updated.count !== 1) return null;
  return { accessToken: accessToken(session.userId, session.id, now, deps.signingKey), refreshToken: next, expiresIn: ACCESS_TTL_SECONDS };
}

/** Lê o "Authorization: Bearer ..." e confere o token e a sessão. */
export async function sessionFromRequest(deps: SessionDeps, req: FastifyRequest): Promise<{ userId: string; sessionId: string } | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  let claims;
  try {
    claims = verifyHs256(header.slice(7), deps.signingKey);
  } catch (err) {
    if (err instanceof JwtError) return null;
    throw err;
  }
  const nowSec = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  if (claims.typ !== "access" || typeof claims.exp !== "number" || claims.exp <= nowSec) return null;
  if (typeof claims.sub !== "string" || typeof claims.sid !== "string") return null;
  // Confere a sessão no banco: depois de sair (logout) ou excluir a conta,
  // o token de acesso para de valer na hora, sem esperar os 15 minutos.
  const session = await deps.prisma.session.findUnique({ where: { id: claims.sid } });
  if (!session || session.userId !== claims.sub || session.revokedAt) return null;
  return { userId: session.userId, sessionId: session.id };
}

export function sessionAuthenticate(deps: SessionDeps): Authenticate {
  return async (req) => (await sessionFromRequest(deps, req))?.userId ?? null;
}

export async function revokeSession(deps: SessionDeps, sessionId: string): Promise<void> {
  await deps.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: deps.now?.() ?? new Date() } });
}
