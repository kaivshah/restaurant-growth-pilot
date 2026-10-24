-- AlterTable
ALTER TABLE "DraftJob" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "runAfter" TIMESTAMP(3);
