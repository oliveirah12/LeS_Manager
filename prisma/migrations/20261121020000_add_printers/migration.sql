-- CreateTable
CREATE TABLE "Printer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "powerWatts" DECIMAL(12,2) NOT NULL,
    "hourlyCost" DECIMAL(30,12) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "energyRate" DECIMAL(30,12) NOT NULL DEFAULT 0,

    CONSTRAINT "ProductionSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Printer_name_key" ON "Printer"("name");

-- The single settings row always exists.
INSERT INTO "ProductionSettings" ("id", "energyRate") VALUES ('default', 0);
