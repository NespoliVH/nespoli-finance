import type { FastifyReply, FastifyRequest } from "fastify";

/** Descobre o usuário da requisição. O login com a Apple (módulo 3) fornece a implementação real. */
export type Authenticate = (req: FastifyRequest) => Promise<string | null>;

/** Até o módulo 3, ninguém é reconhecido: todas as rotas de usuário respondem 401. */
export const nobody: Authenticate = async () => null;

/** Devolve o id do usuário, ou responde 401 e devolve null. */
export function makeRequireUser(authenticate: Authenticate) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const userId = await authenticate(req);
    if (!userId) {
      await reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return userId;
  };
}
