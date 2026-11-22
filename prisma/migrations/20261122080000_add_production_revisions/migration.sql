-- AlterEnum
ALTER TYPE "MovementKind" ADD VALUE 'PRODUCTION_ADJUST_IN';
ALTER TYPE "MovementKind" ADD VALUE 'PRODUCTION_ADJUST_OUT';

-- AlterTable
ALTER TABLE "ProductionOrder" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ProductionRevision" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "costInStock" DECIMAL(30,12) NOT NULL,
    "costIssued" DECIMAL(30,12) NOT NULL,

    CONSTRAINT "ProductionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionRevision_userId_idx" ON "ProductionRevision"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRevision_orderId_number_key" ON "ProductionRevision"("orderId", "number");

-- AddForeignKey
ALTER TABLE "ProductionRevision" ADD CONSTRAINT "ProductionRevision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProductionOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionRevision" ADD CONSTRAINT "ProductionRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
