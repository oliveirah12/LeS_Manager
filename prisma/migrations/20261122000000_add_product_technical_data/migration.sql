-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "diameterMm" DECIMAL(30,12),
ADD COLUMN     "heightMm" DECIMAL(30,12),
ADD COLUMN     "lengthMm" DECIMAL(30,12),
ADD COLUMN     "purchaseUrl" TEXT,
ADD COLUMN     "widthMm" DECIMAL(30,12);

-- CreateTable
CREATE TABLE "ProductMeasure" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" DECIMAL(30,12) NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "ProductMeasure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductMeasure_productId_name_key" ON "ProductMeasure"("productId", "name");

-- AddForeignKey
ALTER TABLE "ProductMeasure" ADD CONSTRAINT "ProductMeasure_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

