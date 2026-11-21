-- CreateTable
CREATE TABLE "ProductType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isInput" BOOLEAN NOT NULL DEFAULT false,
    "isManufactured" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductType_name_key" ON "ProductType"("name");

-- The first type is the default of every product, so existing rows keep their balance and cost untouched.
INSERT INTO "ProductType" ("id", "name", "isInput", "isManufactured") VALUES
    ('00000000-0000-4000-8000-000000000001', 'Produto normal', false, false),
    ('00000000-0000-4000-8000-000000000002', 'Filamento', true, false),
    ('00000000-0000-4000-8000-000000000003', 'Impresso 3D', false, true);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "typeId" TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "ProductType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
