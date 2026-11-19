import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "../db.js";
import { BlindIndexContext, blindIndex } from "../lib/crypto.js";
import { verifyAppleIdentityToken, type AppleKeySource } from "./apple.js";
import { JwtError } from "./jwt.js";
import { createSession, refreshSession, revokeSession, sessionFromRequest } from "./session.js";

// Rotas de login (módulo 3): entrar com a Apple, renovar a sessão e sair.

export interface AuthDeps {
  prisma: PrismaClient;
  blindKey: Buffer;
  signingKey: Buffer;
  /** Bundle id do app; o token da Apple precisa ter sido emitido para ele. */
  appleAudience: string;
  appleKeys: AppleKeySource;
  now?: () => Date;
}

const appleBody = z.object({
  identityToken: z.string().min(1).max(10_000),
  rawNonce: z.string().min(16).max(200),
  // A Apple só manda o nome no PRIMEIRO login, e só para o app (não vai no token).
  fullName: z
    .object({ givenName: z.string().max(100).nullish(), familyName: z.string().max(100).nullish() })
    .nullish(),
});
const refreshBody = z.object({ refreshToken: z.string().min(1).max(200) });

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const session = { prisma: deps.prisma, signingKey: deps.signingKey, now: deps.now };

  // RF01: entrar com a Apple. Cria o usuário no primeiro login.
  app.post("/auth/apple", async (req, reply) => {
    const body = appleBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    let identity;
    try {
      identity = await verifyAppleIdentityToken(body.data.identityToken, {
        keys: deps.appleKeys,
        audience: deps.appleAudience,
        rawNonce: body.data.rawNonce,
        now: deps.now?.(),
      });
    } catch (err) {
      if (err instanceof JwtError) return reply.code(401).send({ error: "invalid_apple_token" });
      req.log.error({ err }, "falha ao buscar as chaves da Apple");
      return reply.code(503).send({ error: "apple_unavailable", retry: true });
    }

    // O identificador da Apple é guardado como índice cego (HMAC), e não em
    // texto: dá para achar o usuário no próximo login, mas um vazamento do
    // banco não revela o identificador.
    const appleUserId = blindIndex(identity.sub, deps.blindKey, BlindIndexContext.appleUser);
    const name = [body.data.fullName?.givenName, body.data.fullName?.familyName].filter(Boolean).join(" ") || null;

    const existing = await deps.prisma.user.findUnique({ where: { appleUserId } });
    const user = existing
      ? identity.email && identity.email !== existing.email
        ? await deps.prisma.user.update({ where: { id: existing.id }, data: { email: identity.email } })
        : existing
      : await deps.prisma.user.create({ data: { appleUserId, email: identity.email ?? null, name } });

    const tokens = await createSession(session, user.id);
    return reply.code(existing ? 200 : 201).send({
      ...tokens,
      isNewUser: !existing,
      user: { id: user.id, name: user.name, email: user.email },
    });
  });

  // RF02: renova o acesso com o token de renovação (que é trocado a cada uso).
  app.post("/auth/refresh", async (req, reply) => {
    const body = refreshBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const tokens = await refreshSession(session, body.data.refreshToken);
    if (!tokens) return reply.code(401).send({ error: "invalid_refresh_token" });
    return tokens;
  });

  // RF02: sair. A sessão é revogada e os dois tokens deixam de valer.
  app.post("/auth/logout", async (req, reply) => {
    const current = await sessionFromRequest(session, req);
    if (!current) return reply.code(401).send({ error: "unauthorized" });
    await revokeSession(session, current.sessionId);
    return reply.code(204).send();
  });
}
