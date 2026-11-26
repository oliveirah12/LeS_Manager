-- CreateEnum
CREATE TYPE "CostBase" AS ENUM ('COST', 'SALE');

-- CreateTable
CREATE TABLE "CostItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "PurchaseCostMode" NOT NULL,
    "base" "CostBase" NOT NULL DEFAULT 'COST',
    "value" DECIMAL(30,12) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CostItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CostItem_name_key" ON "CostItem"("name");

-- AlterTable
ALTER TABLE "PurchaseCost" ADD COLUMN "costItemId" TEXT;

-- CreateIndex
CREATE INDEX "PurchaseCost_costItemId_idx" ON "PurchaseCost"("costItemId");

-- AddForeignKey
ALTER TABLE "PurchaseCost" ADD CONSTRAINT "PurchaseCost_costItemId_fkey" FOREIGN KEY ("costItemId") REFERENCES "CostItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
