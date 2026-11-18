import { randomBytes } from "node:crypto";
import { createPrisma } from "../src/db.js";

export const testKey = () => randomBytes(32);

export function testPrisma() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL ausente");
  return createPrisma(url);
}
