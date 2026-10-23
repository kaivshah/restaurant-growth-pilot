-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "facts" TEXT[],
ADD COLUMN     "needsCode" BOOLEAN NOT NULL DEFAULT false;
