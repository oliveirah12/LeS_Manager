-- CreateTable
CREATE TABLE "CompanySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL DEFAULT '',
    "tagline" TEXT,
    "footer" TEXT,
    "contact" TEXT,
    "logoFileId" TEXT,
    "quoteValidityDays" INTEGER NOT NULL DEFAULT 15,

    CONSTRAINT "CompanySettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanySettings_logoFileId_key" ON "CompanySettings"("logoFileId");

-- AddForeignKey
ALTER TABLE "CompanySettings" ADD CONSTRAINT "CompanySettings_logoFileId_fkey" FOREIGN KEY ("logoFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The single settings row always exists.
INSERT INTO "CompanySettings" ("id") VALUES ('default');
