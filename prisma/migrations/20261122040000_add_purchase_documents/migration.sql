-- CreateEnum
CREATE TYPE "PurchaseDocumentType" AS ENUM ('PAYMENT_PROOF', 'INVOICE', 'QUOTE', 'OTHER', 'RECEIPT');

-- CreateTable
CREATE TABLE "PurchaseDocument" (
    "fileId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "type" "PurchaseDocumentType" NOT NULL,

    CONSTRAINT "PurchaseDocument_pkey" PRIMARY KEY ("fileId")
);

-- CreateIndex
CREATE INDEX "PurchaseDocument_purchaseId_idx" ON "PurchaseDocument"("purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseDocument_type_idx" ON "PurchaseDocument"("type");

-- CreateIndex
CREATE INDEX "Purchase_purchaseDate_idx" ON "Purchase"("purchaseDate");

-- AddForeignKey
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

