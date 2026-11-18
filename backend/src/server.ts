import { loadEnv } from "./config/env.js";
import { createPrisma } from "./db.js";
import { buildApp } from "./app.js";

const env = loadEnv();
const prisma = createPrisma(env.DATABASE_URL);
const app = buildApp({ prisma });

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
