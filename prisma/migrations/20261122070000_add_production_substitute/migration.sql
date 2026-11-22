-- AlterTable
ALTER TABLE "ProductionConsumption" ADD COLUMN "originalInputId" TEXT;

-- CreateIndex
CREATE INDEX "ProductionConsumption_originalInputId_idx" ON "ProductionConsumption"("originalInputId");

-- AddForeignKey
ALTER TABLE "ProductionConsumption" ADD CONSTRAINT "ProductionConsumption_originalInputId_fkey" FOREIGN KEY ("originalInputId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
