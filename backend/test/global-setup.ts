import { execSync } from "node:child_process";
import "dotenv/config";
import pg from "pg";

// Antes da suíte: esvazia o banco de TESTE e aplica todas as migrações,
// para os testes rodarem sobre o esquema real. Por segurança, só aceita
// bancos cujo nome termina em "_test".
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Defina TEST_DATABASE_URL no .env para rodar os testes");
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(`Recusado: o banco de testes precisa terminar em _test (recebido: ${dbName})`);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
}
