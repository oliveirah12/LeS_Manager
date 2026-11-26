-- AlterTable
ALTER TABLE "Product" ADD COLUMN "printMinutes" DECIMAL(12,2),
ADD COLUMN "printerId" TEXT;

-- CreateTable
CREATE TABLE "ProductCost" (
    "productId" TEXT NOT NULL,
    "costItemId" TEXT NOT NULL,

    CONSTRAINT "ProductCost_pkey" PRIMARY KEY ("productId","costItemId")
);

-- CreateIndex
CREATE INDEX "ProductCost_costItemId_idx" ON "ProductCost"("costItemId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCost" ADD CONSTRAINT "ProductCost_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCost" ADD CONSTRAINT "ProductCost_costItemId_fkey" FOREIGN KEY ("costItemId") REFERENCES "CostItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
