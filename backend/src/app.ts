import Fastify, { type FastifyInstance } from "fastify";
import { registerAccountRoutes } from "./account/routes.js";
import { registerAuthRoutes, type AuthDeps } from "./auth/routes.js";
import { registerAlertRoutes } from "./alerts/routes.js";
import { registerConnectionRoutes, type ConnectionDeps } from "./connections/routes.js";
import type { PrismaClient } from "./db.js";
import { nobody, type Authenticate } from "./http/auth.js";
import { registerEtag } from "./http/etag.js";
import { registerTaxRoutes } from "./tax/routes.js";
import { registerTransactionRoutes } from "./transactions/routes.js";

export interface AppDeps {
  prisma: PrismaClient;
  logger?: boolean;
  /** Quem é o usuário da requisição. Sem isso, nenhuma rota de usuário aceita chamadas. */
  authenticate?: Authenticate;
  now?: () => Date;
  connections?: Omit<ConnectionDeps, "prisma" | "authenticate" | "now">;
  /** Login com a Apple (módulo 3). Sem isso, as rotas /auth não existem. */
  auth?: Omit<AuthDeps, "prisma" | "now">;
}

/** Tira o segredo do webhook da URL antes de ela ir para o log. */
export function redactUrl(url: string): string {
  return url.replace(/^\/webhooks\/pluggy\/[^/?#]+/, "/webhooks/pluggy/[removido]");
}

// Monta a aplicação sem iniciar o servidor. Separar "montar" de "iniciar"
// permite que os testes criem a aplicação e façam requisições sem abrir porta.
export function buildApp({ prisma, logger = true, authenticate = nobody, now, connections, auth }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: logger
      ? {
          // RNF08: logs nunca contêm tokens, credenciais ou dados bancários.
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "*.token",
              "*.refreshToken",
              "*.identityToken",
              "*.accessToken",
              "*.rawNonce",
              "*.accountNumber",
            ],
            censor: "[removido]",
          },
          serializers: {
            req: (req) => ({ method: req.method, url: redactUrl(req.url) }),
          },
        }
      : false,
  });

  registerEtag(app);

  // Verificação de saúde: usada pela hospedagem para saber se o servidor
  // está no ar e se consegue falar com o banco.
  app.get("/health", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ok", database: "ok" };
    } catch {
      return reply.code(503).send({ status: "degraded", database: "unreachable" });
    }
  });

  if (auth) registerAuthRoutes(app, { prisma, now, ...auth });
  if (connections) {
    registerConnectionRoutes(app, { prisma, authenticate, now, ...connections });
    registerAccountRoutes(app, { prisma, authenticate, ...connections });
  }
  registerTransactionRoutes(app, { prisma, authenticate, now });
  registerAlertRoutes(app, { prisma, authenticate, now });
  registerTaxRoutes(app, { prisma, authenticate, now });

  return app;
}
