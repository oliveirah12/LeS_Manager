-- AlterTable
ALTER TABLE "ProductionConsumption" ADD COLUMN     "colorInputId" TEXT;

-- CreateTable
CREATE TABLE "ColorInput" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "groupId" TEXT,
    "colorId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,

    CONSTRAINT "ColorInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductColorInput" (
    "productId" TEXT NOT NULL,
    "colorInputId" TEXT NOT NULL,
    "quantity" DECIMAL(30,12) NOT NULL,

    CONSTRAINT "ProductColorInput_pkey" PRIMARY KEY ("productId","colorInputId")
);

-- CreateIndex
CREATE INDEX "ColorInput_colorId_idx" ON "ColorInput"("colorId");

-- CreateIndex
CREATE INDEX "ProductColorInput_colorInputId_idx" ON "ProductColorInput"("colorInputId");

-- CreateIndex
CREATE INDEX "ProductionConsumption_colorInputId_idx" ON "ProductionConsumption"("colorInputId");

-- AddForeignKey
ALTER TABLE "ColorInput" ADD CONSTRAINT "ColorInput_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "ProductType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColorInput" ADD CONSTRAINT "ColorInput_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Reference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColorInput" ADD CONSTRAINT "ColorInput_colorId_fkey" FOREIGN KEY ("colorId") REFERENCES "Reference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColorInput" ADD CONSTRAINT "ColorInput_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "UnitFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductColorInput" ADD CONSTRAINT "ProductColorInput_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductColorInput" ADD CONSTRAINT "ProductColorInput_colorInputId_fkey" FOREIGN KEY ("colorInputId") REFERENCES "ColorInput"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionConsumption" ADD CONSTRAINT "ProductionConsumption_colorInputId_fkey" FOREIGN KEY ("colorInputId") REFERENCES "ColorInput"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One color input per type, group and color. An empty group counts as one value, so it is never registered twice.
CREATE UNIQUE INDEX "ColorInput_typeId_groupId_colorId_key" ON "ColorInput"("typeId", "groupId", "colorId") NULLS NOT DISTINCT;
