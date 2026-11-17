import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TaxYearConfig } from "../../rules/tax.js";

// As tabelas ficam em arquivos JSON por ano (RN06). Adicionar um ano novo é
// criar um arquivo, sem mudar código nem publicar nova versão do app.
export function loadTaxConfig(year: number): TaxYearConfig {
  const path = fileURLToPath(new URL(`./${year}.json`, import.meta.url));
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TaxYearConfig;
  } catch {
    throw new Error(`Tabela do IR de ${year} não configurada`);
  }
}
