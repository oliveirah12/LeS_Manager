-- AlterTable
ALTER TABLE "Product" ADD COLUMN "imageFileId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Product_imageFileId_key" ON "Product"("imageFileId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_imageFileId_fkey" FOREIGN KEY ("imageFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
