CREATE TABLE "BankReconciliation" (
    "provider" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "reference" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "BankReconciliation_pkey" PRIMARY KEY ("provider", "date", "key"),
    CONSTRAINT "BankReconciliation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
