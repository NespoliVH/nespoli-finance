import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Criptografia de campo e índice cego (etapa 3, seção 4.3).
//
// encryptField/decryptField protegem dados sensíveis (identificador do item
// no Pluggy, número da conta) com AES-256-GCM. O GCM, além de esconder o
// conteúdo, detecta qualquer alteração: um byte mexido no banco faz a
// descriptografia falhar em vez de devolver lixo.
//
// Cada chamada usa um IV (vetor de inicialização) aleatório, então o mesmo
// valor gera resultados diferentes a cada gravação. Por isso não dá para
// buscar pelo valor cifrado, e existe o blindIndex.
//
// Formato gravado: [versão 1 byte][IV 12 bytes][tag 16 bytes][conteúdo cifrado]
// O byte de versão permite trocar de algoritmo ou de chave no futuro sem
// perder a leitura dos dados antigos.

const VERSION = 1;
const IV_LENGTH = 12; // tamanho recomendado para o GCM
const TAG_LENGTH = 16;

// Devolve Uint8Array (e não Buffer) porque é o tipo que o Prisma espera em
// colunas de bytes.
export function encryptField(plaintext: string, key: Buffer): Uint8Array<ArrayBuffer> {
  assertKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, tag, encrypted]));
}

export function decryptField(data: Uint8Array, key: Buffer): string {
  assertKey(key);
  const payload = Buffer.from(data);
  if (payload.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new Error("Campo cifrado com tamanho inválido");
  }
  const version = payload[0];
  if (version !== VERSION) {
    throw new Error(`Versão de criptografia desconhecida: ${version}`);
  }
  const iv = payload.subarray(1, 1 + IV_LENGTH);
  const tag = payload.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const encrypted = payload.subarray(1 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

// Índice cego: o mesmo valor sempre gera o mesmo resultado (permite busca),
// mas sem a chave não é possível voltar ao valor original nem testar
// palpites. O "contexto" separa usos diferentes: o HMAC de um item do
// Pluggy nunca coincide com o HMAC de um identificador da Apple.
export function blindIndex(value: string, key: Buffer, context: string): string {
  assertKey(key);
  return createHmac("sha256", key).update(`${context}:${value}`, "utf8").digest("hex");
}

// Comparação em tempo constante, para quem comparar hashes não vazar
// informação pelo tempo de resposta.
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function keyFromBase64(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  assertKey(key);
  return key;
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("A chave deve ter 32 bytes (256 bits)");
  }
}

export const BlindIndexContext = {
  pluggyItem: "pluggy-item",
  consentSubject: "consent-subject",
} as const;
