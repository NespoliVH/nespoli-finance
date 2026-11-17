import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

// Uma única instância do cliente do banco para a aplicação inteira.
// O Prisma 7 conversa com o PostgreSQL por um "adaptador"; aqui usamos o
// driver oficial do Node (pg).
export function createPrisma(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

export type { PrismaClient };
