import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";

// Apoio ao modo offline (RNF15).
//
// O app guarda no aparelho a última resposta de cada tela e mostra essa cópia
// quando está sem internet. Com internet, ele pergunta "mudou alguma coisa?"
// mandando a etiqueta (ETag) da cópia que tem. Se nada mudou, o backend
// responde 304 sem corpo: a tela abre na hora e quase nada trafega.
//
// A etiqueta é o hash da própria resposta, então não precisa guardar nada.
// Cache-Control "private, no-cache" diz que só o aparelho do usuário pode
// guardar a resposta, e que ele sempre confere antes de usar.

export function registerEtag(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET" || reply.statusCode !== 200) return payload;
    if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return payload;
    const etag = `W/"${createHash("sha256").update(payload).digest("base64url").slice(0, 27)}"`;
    void reply.header("etag", etag).header("cache-control", "private, no-cache");
    const sent = req.headers["if-none-match"];
    if (sent && sent.split(",").some((t) => t.trim() === etag)) {
      void reply.code(304);
      return "";
    }
    return payload;
  });
}
