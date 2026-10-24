-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'SUGGEST';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "description" TEXT;
