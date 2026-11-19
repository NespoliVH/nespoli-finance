import { generateKeyPairSync, randomBytes, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { APPLE_ISSUER, hashNonce, verifyAppleIdentityToken, appleKeysFromNetwork } from "../../src/auth/apple.js";
import { signHs256, verifyHs256 } from "../../src/auth/jwt.js";
import { ACCESS_TTL_SECONDS, hashRefreshToken, sessionAuthenticate } from "../../src/auth/session.js";
import { BlindIndexContext, blindIndex } from "../../src/lib/crypto.js";
import { testKey, testPrisma } from "../helpers.js";

// A Apple de mentira: um par de chaves RSA gerado no teste faz o papel das
// chaves da Apple, e os tokens são assinados com ele do mesmo jeito.
const AUDIENCE = "br.com.nespoli.finance";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "teste-1", alg: "RS256" };
const appleKeys = async (kid: string) => (kid === "teste-1" ? jwk : null);

function appleToken(claims: Record<string, unknown>, key: KeyObject = privateKey, kid = "teste-1") {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${b64({ alg: "RS256", kid })}.${b64(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}

const RAW_NONCE = "nonce-do-app-1234567890";
const nowSec = () => Math.floor(Date.now() / 1000);
const validClaims = (over: Record<string, unknown> = {}) => ({
  iss: APPLE_ISSUER,
  aud: AUDIENCE,
  exp: nowSec() + 600,
  iat: nowSec(),
  sub: `000123.${randomBytes(6).toString("hex")}`,
  nonce: hashNonce(RAW_NONCE),
  email: "pessoa@privaterelay.appleid.com",
  email_verified: "true",
  is_private_email: "true",
  ...over,
});

const prisma = testPrisma();
const blindKey = testKey();
const signingKey = testKey();
const app = buildApp({
  prisma,
  logger: false,
  auth: { blindKey, signingKey, appleAudience: AUDIENCE, appleKeys },
  authenticate: sessionAuthenticate({ prisma, signingKey }),
});

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const login = (identityToken: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/auth/apple", payload: { identityToken, rawNonce: RAW_NONCE, ...extra } });

describe("verificação do token da Apple", () => {
  const verify = (token: string, rawNonce = RAW_NONCE) =>
    verifyAppleIdentityToken(token, { keys: appleKeys, audience: AUDIENCE, rawNonce });

  it("aceita um token válido e devolve o usuário", async () => {
    const claims = validClaims();
    await expect(verify(appleToken(claims))).resolves.toMatchObject({ sub: claims.sub, isPrivateEmail: true, emailVerified: true });
  });

  it.each([
    ["emissor diferente", { iss: "https://outro.com" }],
    ["emitido para outro app", { aud: "com.outro.app" }],
    ["vencido", { exp: nowSec() - 3600 }],
    ["nonce de outro login", { nonce: hashNonce("outro-nonce-qualquer-123") }],
    ["sem usuário", { sub: "" }],
  ])("recusa token %s", async (_nome, over) => {
    await expect(verify(appleToken(validClaims(over)))).rejects.toThrow();
  });

  it("recusa assinatura de outra chave e chave desconhecida", async () => {
    const outra = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(verify(appleToken(validClaims(), outra))).rejects.toThrow("assinatura");
    await expect(verify(appleToken(validClaims(), privateKey, "kid-x"))).rejects.toThrow("desconhecida");
  });

  it("recusa token com o algoritmo trocado para HS256", async () => {
    const forjado = signHs256(validClaims(), randomBytes(32));
    await expect(verify(forjado)).rejects.toThrow();
  });

  it("busca as chaves de novo quando aparece um kid novo", async () => {
    let chamadas = 0;
    const fakeFetch = (async () => {
      chamadas++;
      return new Response(JSON.stringify({ keys: chamadas === 1 ? [] : [jwk] }));
    }) as typeof fetch;
    const keys = appleKeysFromNetwork(fakeFetch);
    expect(await keys("teste-1")).toEqual(jwk);
    expect(chamadas).toBe(2);
    expect(await keys("teste-1")).toEqual(jwk);
    expect(chamadas).toBe(2); // segunda vez veio do cache
  });
});

describe("POST /auth/apple", () => {
  it("no primeiro login cria o usuário com nome e e-mail, e guarda o id da Apple só como índice cego", async () => {
    const claims = validClaims();
    const res = await login(appleToken(claims), { fullName: { givenName: "Vitória", familyName: "Nespoli" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ isNewUser: true, expiresIn: ACCESS_TTL_SECONDS, user: { name: "Vitória Nespoli", email: claims.email } });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
    expect(user.appleUserId).toBe(blindIndex(claims.sub, blindKey, BlindIndexContext.appleUser));
    expect(user.appleUserId).not.toContain(claims.sub);

    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.refreshTokenHash).toBe(hashRefreshToken(body.refreshToken));
    expect(session.refreshTokenHash).not.toBe(body.refreshToken);
  });

  it("no segundo login acha o mesmo usuário e não apaga o nome (a Apple não manda de novo)", async () => {
    const claims = validClaims();
    const primeiro = (await login(appleToken(claims), { fullName: { givenName: "Ana" } })).json();
    const segundo = await login(appleToken(claims));
    expect(segundo.statusCode).toBe(200);
    expect(segundo.json()).toMatchObject({ isNewUser: false, user: { id: primeiro.user.id, name: "Ana" } });
  });

  it("token inválido responde 401 e corpo errado responde 400", async () => {
    expect((await login(appleToken(validClaims({ aud: "outro" })))).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/apple", payload: { identityToken: "x" } })).statusCode).toBe(400);
  });

  it("se as chaves da Apple não respondem, devolve 503 para tentar de novo", async () => {
    const semApple = buildApp({
      prisma,
      logger: false,
      auth: { blindKey, signingKey, appleAudience: AUDIENCE, appleKeys: async () => { throw new Error("rede"); } },
    });
    const res = await semApple.inject({ method: "POST", url: "/auth/apple", payload: { identityToken: appleToken(validClaims()), rawNonce: RAW_NONCE } });
    expect(res.statusCode).toBe(503);
    await semApple.close();
  });
});

describe("sessão: acesso, renovação e saída", () => {
  async function newSession() {
    return (await login(appleToken(validClaims()))).json() as { accessToken: string; refreshToken: string; user: { id: string } };
  }
  const me = (token: string) => app.inject({ method: "GET", url: "/alerts", headers: { authorization: `Bearer ${token}` } });

  it("o token de acesso libera as rotas de usuário; sem ele, 401", async () => {
    const s = await newSession();
    expect((await me(s.accessToken)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/alerts" })).statusCode).toBe(401);
    expect((await me("abc.def.ghi")).statusCode).toBe(401);
  });

  it("token de acesso vencido ou assinado com outra chave não vale", async () => {
    const s = await newSession();
    const claims = verifyHs256(s.accessToken, signingKey);
    expect((await me(signHs256({ ...claims, exp: nowSec() - 1 }, signingKey))).statusCode).toBe(401);
    expect((await me(signHs256(claims, randomBytes(32)))).statusCode).toBe(401);
  });

  it("renovar troca o token de renovação: o antigo deixa de valer", async () => {
    const s = await newSession();
    const r1 = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const novo = r1.json();
    expect(novo.refreshToken).not.toBe(s.refreshToken);
    expect((await me(novo.accessToken)).statusCode).toBe(200);

    const reuso = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(reuso.statusCode).toBe(401);
  });

  it("duas renovações ao mesmo tempo com o mesmo token: só uma vale", async () => {
    const s = await newSession();
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: s.refreshToken } }),
      app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: s.refreshToken } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);
  });

  it("sair revoga a sessão: o acesso e a renovação param de valer na hora", async () => {
    const s = await newSession();
    const out = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${s.accessToken}` } });
    expect(out.statusCode).toBe(204);
    expect((await me(s.accessToken)).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: s.refreshToken } })).statusCode).toBe(401);
  });

  it("sessão vencida não renova", async () => {
    const s = await newSession();
    await prisma.session.updateMany({ where: { userId: s.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: s.refreshToken } })).statusCode).toBe(401);
  });
});
