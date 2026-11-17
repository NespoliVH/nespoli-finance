-- As quatro categorias fixas do app (RF15). Não são editáveis pelo usuário.
INSERT INTO "categories" ("id", "name", "display_order", "icon") VALUES
  ('contas_fixas', 'Contas fixas', 1, 'house.fill'),
  ('comida',       'Comida',       2, 'fork.knife'),
  ('imprevistos',  'Imprevistos',  3, 'exclamationmark.triangle.fill'),
  ('outros',       'Outros',       4, 'square.grid.2x2.fill');

-- Regras que o Prisma não expressa no esquema, garantidas pelo próprio banco.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount_cents" > 0);
ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_dependents_non_negative" CHECK ("dependents_count" >= 0);
ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_salary_non_negative" CHECK ("gross_monthly_salary_cents" >= 0);
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_reference_month_first_day" CHECK (EXTRACT(DAY FROM "reference_month") = 1);
