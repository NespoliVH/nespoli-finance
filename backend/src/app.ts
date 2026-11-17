import Fastify, { type FastifyInstance } from "fastify";
import { registerConnectionRoutes, type ConnectionDeps } from "./connections/routes.js";
import type { PrismaClient } from "./db.js";

export interface AppDeps {
  prisma: PrismaClient;
  logger?: boolean;
  connections?: Omit<ConnectionDeps, "prisma">;
}

/** Tira o segredo do webhook da URL antes de ela ir para o log. */
export function redactUrl(url: string): string {
  return url.replace(/^\/webhooks\/pluggy\/[^/?#]+/, "/webhooks/pluggy/[removido]");
}

// Monta a aplicação sem iniciar o servidor. Separar "montar" de "iniciar"
// permite que os testes criem a aplicação e façam requisições sem abrir porta.
export function buildApp({ prisma, logger = true, connections }: AppDeps): FastifyInstance {
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

  if (connections) registerConnectionRoutes(app, { prisma, ...connections });

  return app;
}
