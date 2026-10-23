-- CreateEnum
CREATE TYPE "DraftKind" AS ENUM ('CUSTOMER_OFFER', 'CATERING_PITCH');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING', 'APPROVED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "kind" "DraftKind" NOT NULL DEFAULT 'CUSTOMER_OFFER',
    "offerKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "cost" TEXT NOT NULL,
    "measure" TEXT NOT NULL,
    "checks" TEXT[],
    "evidence" JSONB,
    "copyLabel" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "writtenBy" TEXT NOT NULL,
    "factsHash" TEXT NOT NULL,
    "rewriteCount" INTEGER NOT NULL DEFAULT 0,
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftJob" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DraftJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Draft_restaurantId_status_idx" ON "Draft"("restaurantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Draft_restaurantId_factsHash_key" ON "Draft"("restaurantId", "factsHash");

-- CreateIndex
CREATE INDEX "DraftJob_status_createdAt_idx" ON "DraftJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DraftJob_restaurantId_status_idx" ON "DraftJob"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "LlmCall_restaurantId_createdAt_idx" ON "LlmCall"("restaurantId", "createdAt");

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftJob" ADD CONSTRAINT "DraftJob_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
