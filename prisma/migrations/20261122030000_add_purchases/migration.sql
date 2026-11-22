-- CreateEnum
CREATE TYPE "PurchaseCostMode" AS ENUM ('VALUE', 'PERCENT');

-- CreateEnum
CREATE TYPE "PurchaseCostSplit" AS ENUM ('VALUE', 'QUANTITY');

-- AlterEnum
ALTER TYPE "MovementKind" ADD VALUE 'PURCHASE_REVERSAL';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "lastPurchaseAt" DATE,
ADD COLUMN     "lastPurchaseExpense" DECIMAL(30,12),
ADD COLUMN     "lastSupplierId" TEXT;

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" TEXT,
    "contact" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "supplierId" TEXT,
    "documentNumber" TEXT,
    "purchaseDate" DATE NOT NULL,
    "notes" TEXT,
    "goodsTotal" DECIMAL(30,12) NOT NULL,
    "costsTotal" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "converted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "reversedById" TEXT,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseItem" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "declaredQuantity" DECIMAL(30,12) NOT NULL,
    "declaredUnit" TEXT NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,
    "goodsTotal" DECIMAL(30,12) NOT NULL,
    "unitCost" DECIMAL(30,12),
    "expenseTotal" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "unitExpense" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "revisionAfter" INTEGER,
    "previousCost" DECIMAL(30,12),
    "previousLastCost" DECIMAL(30,12),
    "previousLastAt" DATE,
    "previousLastExpense" DECIMAL(30,12),
    "previousSupplierId" TEXT,

    CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseCost" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mode" "PurchaseCostMode" NOT NULL,
    "value" DECIMAL(30,12) NOT NULL,
    "split" "PurchaseCostSplit" NOT NULL,
    "amount" DECIMAL(30,12) NOT NULL,

    CONSTRAINT "PurchaseCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseItemCost" (
    "itemId" TEXT NOT NULL,
    "costId" TEXT NOT NULL,
    "amount" DECIMAL(30,12) NOT NULL,

    CONSTRAINT "PurchaseItemCost_pkey" PRIMARY KEY ("itemId","costId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_name_key" ON "Supplier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_document_key" ON "Supplier"("document");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_number_key" ON "Purchase"("number");

-- CreateIndex
CREATE INDEX "Purchase_createdAt_idx" ON "Purchase"("createdAt");

-- CreateIndex
CREATE INDEX "Purchase_supplierId_idx" ON "Purchase"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseItem_movementId_key" ON "PurchaseItem"("movementId");

-- CreateIndex
CREATE INDEX "PurchaseItem_productId_idx" ON "PurchaseItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseItem_purchaseId_productId_key" ON "PurchaseItem"("purchaseId", "productId");

-- CreateIndex
CREATE INDEX "PurchaseCost_purchaseId_idx" ON "PurchaseCost"("purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseItemCost_costId_idx" ON "PurchaseItemCost"("costId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_lastSupplierId_fkey" FOREIGN KEY ("lastSupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "Movement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_previousSupplierId_fkey" FOREIGN KEY ("previousSupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseCost" ADD CONSTRAINT "PurchaseCost_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItemCost" ADD CONSTRAINT "PurchaseItemCost_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PurchaseItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItemCost" ADD CONSTRAINT "PurchaseItemCost_costId_fkey" FOREIGN KEY ("costId") REFERENCES "PurchaseCost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Each old purchase movement becomes a one-item purchase. The movement id is reused so the conversion is traceable.
INSERT INTO "Purchase" ("id", "purchaseDate", "goodsTotal", "converted", "createdAt", "userId")
SELECT m."id", (m."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date,
       ROUND(m."quantity" * COALESCE(m."unitCost", 0), 12), true, m."createdAt", m."userId"
FROM "Movement" m
WHERE m."kind" = 'PURCHASE'
ORDER BY m."createdAt", m."id";

-- Quantities are stored in the base unit, so that is the unit shown on converted items.
INSERT INTO "PurchaseItem" ("id", "purchaseId", "productId", "movementId", "declaredQuantity", "declaredUnit", "quantity", "goodsTotal", "unitCost")
SELECT m."id", m."id", m."productId", m."id", m."quantity",
       (SELECT base."symbol" FROM "Unit" base WHERE base."familyId" = unit."familyId" AND base."isBase"),
       m."quantity", ROUND(m."quantity" * COALESCE(m."unitCost", 0), 12), m."unitCost"
FROM "Movement" m
JOIN "Product" p ON p."id" = m."productId"
JOIN "Unit" unit ON unit."id" = p."unitId"
WHERE m."kind" = 'PURCHASE';

UPDATE "Product" p
SET "lastPurchaseAt" = latest."purchaseDate"
FROM (
  SELECT i."productId", MAX(c."purchaseDate") AS "purchaseDate"
  FROM "PurchaseItem" i JOIN "Purchase" c ON c."id" = i."purchaseId"
  GROUP BY i."productId"
) latest
WHERE latest."productId" = p."id";

-- Profiles keep what they could do with purchases when these lived under stock.
UPDATE "Profile" SET "permissions" = array_append("permissions", 'purchases:view')
WHERE 'stock:view' = ANY("permissions") AND NOT ('purchases:view' = ANY("permissions"));

UPDATE "Profile" SET "permissions" = array_append("permissions", 'purchases:operate')
WHERE 'stock:operate' = ANY("permissions") AND NOT ('purchases:operate' = ANY("permissions"));
