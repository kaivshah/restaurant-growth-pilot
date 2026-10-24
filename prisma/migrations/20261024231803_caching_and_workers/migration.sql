-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'PITCH';

-- DropIndex
DROP INDEX "Lead_restaurantId_status_idx";

-- AlterTable
ALTER TABLE "DraftJob" ADD COLUMN     "payload" JSONB;

-- CreateTable
CREATE TABLE "CacheEntry" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CacheEntry_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RateSlot" (
    "key" TEXT NOT NULL,
    "next" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateSlot_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "CacheEntry_expiresAt_idx" ON "CacheEntry"("expiresAt");

-- CreateIndex
CREATE INDEX "Event_restaurantId_category_startsAt_idx" ON "Event"("restaurantId", "category", "startsAt");

-- CreateIndex
CREATE INDEX "Lead_restaurantId_status_fitScore_idx" ON "Lead"("restaurantId", "status", "fitScore");

-- CreateIndex
CREATE INDEX "Lead_restaurantId_category_distanceMiles_idx" ON "Lead"("restaurantId", "category", "distanceMiles");
