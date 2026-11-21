-- AlterTable
ALTER TABLE "Product" ADD COLUMN "wastePercent" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ProductInput" (
    "productId" TEXT NOT NULL,
    "inputId" TEXT NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,

    CONSTRAINT "ProductInput_pkey" PRIMARY KEY ("productId","inputId")
);

-- CreateIndex
CREATE INDEX "ProductInput_inputId_idx" ON "ProductInput"("inputId");

-- AddForeignKey
ALTER TABLE "ProductInput" ADD CONSTRAINT "ProductInput_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductInput" ADD CONSTRAINT "ProductInput_inputId_fkey" FOREIGN KEY ("inputId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
