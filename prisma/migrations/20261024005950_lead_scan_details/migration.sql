-- DropIndex
DROP INDEX "AnalysisRun_restaurantId_createdAt_idx";

-- AlterTable
ALTER TABLE "AnalysisRun" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'offers';

-- AlterTable
ALTER TABLE "DraftJob" ADD COLUMN     "force" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "venueLeadId" TEXT;

-- CreateIndex
CREATE INDEX "AnalysisRun_restaurantId_purpose_createdAt_idx" ON "AnalysisRun"("restaurantId", "purpose", "createdAt");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_venueLeadId_fkey" FOREIGN KEY ("venueLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
