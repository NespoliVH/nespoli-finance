import { loadEnv } from "./config/env.js";
import { createPrisma } from "./db.js";
import { buildApp } from "./app.js";
import { PgBossQueue } from "./jobs/queue.js";
import { buildHandlers } from "./jobs/workers.js";
import { keyFromBase64 } from "./lib/crypto.js";
import { PluggyClient } from "./pluggy/client.js";

const env = loadEnv();
const prisma = createPrisma(env.DATABASE_URL);
const fieldKey = keyFromBase64(env.FIELD_ENCRYPTION_KEY);
const blindKey = keyFromBase64(env.BLIND_INDEX_KEY);

const pluggyApi =
  env.PLUGGY_CLIENT_ID && env.PLUGGY_CLIENT_SECRET
    ? new PluggyClient({ baseUrl: env.PLUGGY_API_URL, clientId: env.PLUGGY_CLIENT_ID, clientSecret: env.PLUGGY_CLIENT_SECRET })
    : null;
const pluggy =
  pluggyApi && env.PLUGGY_WEBHOOK_SECRET
    ? {
        api: pluggyApi,
        webhookSecret: env.PLUGGY_WEBHOOK_SECRET,
        webhookUrl: env.PUBLIC_BASE_URL
          ? new URL(`/webhooks/pluggy/${env.PLUGGY_WEBHOOK_SECRET}`, env.PUBLIC_BASE_URL).toString()
          : undefined,
      }
    : null;

const queue = await PgBossQueue.start(env.DATABASE_URL);
if (pluggy) await queue.work(buildHandlers({ prisma, pluggy: pluggy.api, fieldKey }));

const app = buildApp({
  prisma,
  connections: {
    queue,
    fieldKey,
    blindKey,
    pluggy,
    // O login com a Apple chega no módulo 3. Até lá nenhuma requisição é
    // reconhecida como de um usuário, e as rotas de conexão respondem 401.
    authenticate: async () => null,
  },
});
if (!pluggy) app.log.warn("Pluggy não configurado: as rotas de conexão respondem 503");

const shutdown = async () => {
  await app.close();
  await queue.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
