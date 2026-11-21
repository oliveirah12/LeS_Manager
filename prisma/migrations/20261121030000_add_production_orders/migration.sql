-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('PLANNED', 'PRINTING', 'DONE', 'CANCELED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MovementKind" ADD VALUE 'PRODUCTION_IN';
ALTER TYPE "MovementKind" ADD VALUE 'PRODUCTION_OUT';

-- AlterTable
ALTER TABLE "Movement" ADD COLUMN     "productionOrderId" TEXT;

-- CreateTable
CREATE TABLE "ProductionOrder" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "status" "ProductionStatus" NOT NULL DEFAULT 'PLANNED',
    "printerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plannedStart" TIMESTAMP(3) NOT NULL,
    "estimatedMinutes" INTEGER NOT NULL,
    "expectedEnd" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "printMinutes" INTEGER,
    "powerWatts" DECIMAL(12,2),
    "energyRate" DECIMAL(30,12),
    "hourlyCost" DECIMAL(30,12),
    "machineCost" DECIMAL(30,12),
    "totalCost" DECIMAL(30,12),
    "lossCost" DECIMAL(30,12),
    "absorbLoss" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductionOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionItem" (
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "planned" DECIMAL(30,12) NOT NULL,
    "good" DECIMAL(30,12),
    "lost" DECIMAL(30,12),
    "unitCost" DECIMAL(30,12),
    "totalCost" DECIMAL(30,12),
    "lossCost" DECIMAL(30,12),

    CONSTRAINT "ProductionItem_pkey" PRIMARY KEY ("orderId","productId")
);

-- CreateTable
CREATE TABLE "ProductionConsumption" (
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "inputId" TEXT NOT NULL,
    "planned" DECIMAL(30,12) NOT NULL,
    "used" DECIMAL(30,12),
    "unitCost" DECIMAL(30,12),

    CONSTRAINT "ProductionConsumption_pkey" PRIMARY KEY ("orderId","productId","inputId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOrder_number_key" ON "ProductionOrder"("number");

-- CreateIndex
CREATE INDEX "ProductionOrder_status_idx" ON "ProductionOrder"("status");

-- CreateIndex
CREATE INDEX "ProductionOrder_printerId_idx" ON "ProductionOrder"("printerId");

-- CreateIndex
CREATE INDEX "ProductionItem_productId_idx" ON "ProductionItem"("productId");

-- CreateIndex
CREATE INDEX "ProductionConsumption_inputId_idx" ON "ProductionConsumption"("inputId");

-- CreateIndex
CREATE INDEX "Movement_productionOrderId_idx" ON "Movement"("productionOrderId");

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionItem" ADD CONSTRAINT "ProductionItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProductionOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionItem" ADD CONSTRAINT "ProductionItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionConsumption" ADD CONSTRAINT "ProductionConsumption_orderId_productId_fkey" FOREIGN KEY ("orderId", "productId") REFERENCES "ProductionItem"("orderId", "productId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionConsumption" ADD CONSTRAINT "ProductionConsumption_inputId_fkey" FOREIGN KEY ("inputId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
