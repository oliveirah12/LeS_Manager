-- CreateEnum
CREATE TYPE "ProductionExpenseSource" AS ENUM ('INPUT', 'MANUAL');

-- AlterTable
ALTER TABLE "ProductionOrder" ADD COLUMN "expenseCost" DECIMAL(30,12);

-- AlterTable
ALTER TABLE "ProductionItem" ADD COLUMN "expenseCost" DECIMAL(30,12);

-- CreateTable
CREATE TABLE "ProductionExpense" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "source" "ProductionExpenseSource" NOT NULL,
    "inputId" TEXT,
    "title" TEXT NOT NULL,
    "value" DECIMAL(30,12) NOT NULL,
    "edited" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductionExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionExpense_inputId_idx" ON "ProductionExpense"("inputId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionExpense_orderId_inputId_key" ON "ProductionExpense"("orderId", "inputId");

-- AddForeignKey
ALTER TABLE "ProductionExpense" ADD CONSTRAINT "ProductionExpense_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionExpense" ADD CONSTRAINT "ProductionExpense_inputId_fkey" FOREIGN KEY ("inputId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
