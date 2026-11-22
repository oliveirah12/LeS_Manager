-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "feePercent" DECIMAL(5,2),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ProductionOrder"
ADD COLUMN "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN "paymentMethodId" TEXT,
ADD COLUMN "feePercent" DECIMAL(5,2),
ADD COLUMN "paymentName" TEXT,
ADD COLUMN "saleGross" DECIMAL(30,12),
ADD COLUMN "saleDiscount" DECIMAL(30,12),
ADD COLUMN "saleTotal" DECIMAL(30,12),
ADD COLUMN "saleFee" DECIMAL(30,12),
ADD COLUMN "saleNet" DECIMAL(30,12);

-- AlterTable
ALTER TABLE "ProductionItem"
ADD COLUMN "salePrice" DECIMAL(30,12),
ADD COLUMN "marginPercent" DECIMAL(5,2);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_name_key" ON "PaymentMethod"("name");

-- CreateIndex
CREATE INDEX "ProductionOrder_paymentMethodId_idx" ON "ProductionOrder"("paymentMethodId");

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
