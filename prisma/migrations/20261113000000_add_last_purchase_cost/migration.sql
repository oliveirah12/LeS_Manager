ALTER TABLE "Product" ADD COLUMN "lastPurchaseCost" DECIMAL(30,12);

-- Preserve the latest purchase cost already recorded. The current cost becomes the starting average.
UPDATE "Product" AS p
SET "lastPurchaseCost" = (
  SELECT m."unitCost" FROM "Movement" AS m
  WHERE m."productId" = p."id" AND m."kind" = 'PURCHASE'
  ORDER BY m."createdAt" DESC, m."id" DESC
  LIMIT 1
);
