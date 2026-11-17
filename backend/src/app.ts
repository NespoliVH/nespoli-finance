import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "./db.js";

export interface AppDeps {
  prisma: PrismaClient;
  logger?: boolean;
}

// Monta a aplicação sem iniciar o servidor. Separar "montar" de "iniciar"
// permite que os testes criem a aplicação e façam requisições sem abrir porta.
export function buildApp({ prisma, logger = true }: AppDeps): FastifyInstance {
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

  return app;
}
