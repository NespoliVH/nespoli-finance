import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { testPrisma } from "./helpers.js";

const prisma = testPrisma();
const app = buildApp({ prisma, logger: false });

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("GET /health", () => {
  it("responde que o servidor e o banco estão no ar", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: "ok" });
  });
});
