-- IR para autônomos (seção 4.8.1): tipo de renda e plano de INSS no perfil fiscal,
-- origem do rendimento (pessoa física ou empresa) e despesa de livro-caixa.
-- CreateEnum
CREATE TYPE "IncomeSource" AS ENUM ('individual', 'company');

-- CreateEnum
CREATE TYPE "IncomeType" AS ENUM ('salaried', 'self_employed', 'both');

-- CreateEnum
CREATE TYPE "InssPlan" AS ENUM ('standard', 'simplified', 'none');

-- AlterEnum
ALTER TYPE "DeductibleType" ADD VALUE 'business';

-- AlterTable
ALTER TABLE "tax_profiles" ADD COLUMN     "income_type" "IncomeType" NOT NULL DEFAULT 'salaried',
ADD COLUMN     "inss_plan" "InssPlan" NOT NULL DEFAULT 'standard';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "income_source" "IncomeSource";
