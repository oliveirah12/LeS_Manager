-- CreateTable
CREATE TABLE "BankConnection" (
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "account" TEXT,
    "secret" TEXT NOT NULL,
    "certificate" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "certificateExpires" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT NOT NULL,

    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("provider")
);

-- AddForeignKey
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

