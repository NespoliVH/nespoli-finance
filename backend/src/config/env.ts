import "dotenv/config";
import { z } from "zod";

// Todas as configurações vêm de variáveis de ambiente (RNF01).
// Se alguma faltar ou estiver malformada, o servidor nem inicia:
// é melhor falhar na largada do que rodar com uma chave errada.

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length === 32, {
    message: "deve ser uma chave de 32 bytes em base64 (gere com: openssl rand -base64 32)",
  });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  // Chave da criptografia de campo (AES-256-GCM), seção 4.3 da modelagem.
  FIELD_ENCRYPTION_KEY: base64Key32,
  // Chave separada para o índice cego (HMAC-SHA256), seção 4.3 da modelagem.
  BLIND_INDEX_KEY: base64Key32,

  // Pluggy (módulo 4). Opcionais para o servidor subir sem elas durante o
  // desenvolvimento; sem as três, as rotas de conexão respondem 503.
  PLUGGY_API_URL: z.url().default("https://api.pluggy.ai"),
  PLUGGY_CLIENT_ID: z.string().min(1).optional(),
  PLUGGY_CLIENT_SECRET: z.string().min(1).optional(),
  // Segredo que vai no caminho da URL do webhook, para recusar chamadas que não vêm do Pluggy.
  PLUGGY_WEBHOOK_SECRET: z.string().min(32, "deve ter pelo menos 32 caracteres (gere com: openssl rand -hex 32)").optional(),
  // Endereço público do backend, usado para montar a URL do webhook.
  PUBLIC_BASE_URL: z.url().optional(),
}).superRefine((env, ctx) => {
  const pluggy = [env.PLUGGY_CLIENT_ID, env.PLUGGY_CLIENT_SECRET, env.PLUGGY_WEBHOOK_SECRET];
  if (pluggy.some(Boolean) && !pluggy.every(Boolean)) {
    ctx.addIssue({
      code: "custom",
      path: ["PLUGGY_CLIENT_ID"],
      message: "PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_WEBHOOK_SECRET vão juntas: preencha as três ou nenhuma",
    });
  }
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuração inválida:\n${problems}`);
  }
  return parsed.data;
}
