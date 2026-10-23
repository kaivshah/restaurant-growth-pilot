-- CreateEnum
CREATE TYPE "DraftSource" AS ENUM ('RULES', 'AI_ANALYST');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "analysisRunId" TEXT,
ADD COLUMN     "confidence" TEXT,
ADD COLUMN     "source" "DraftSource" NOT NULL DEFAULT 'RULES';

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'RUNNING',
    "dataHash" TEXT NOT NULL,
    "findings" JSONB,
    "accepted" JSONB,
    "rejected" JSONB,
    "baselineDecisions" JSONB,
    "toolLog" JSONB,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DOUBLE PRECISION,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalysisRun_restaurantId_createdAt_idx" ON "AnalysisRun"("restaurantId", "createdAt");

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
