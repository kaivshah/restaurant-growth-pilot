-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('NONE', 'SCHEDULED', 'CONTACTED', 'REPLIED', 'QUOTE', 'WON', 'LOST', 'UNSUBSCRIBED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "EmailStep" AS ENUM ('FIRST', 'FOLLOWUP_1', 'FOLLOWUP_2');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'FOLLOWUPS';

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "followUps" JSONB,
ADD COLUMN     "repliedAt" TIMESTAMP(3),
ADD COLUMN     "replyHandled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replySnippet" TEXT,
ADD COLUMN     "stage" "PipelineStage" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "stageUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "sendDailyCap" INTEGER NOT NULL DEFAULT 20;

-- CreateTable
CREATE TABLE "GmailAccount" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "accessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT NOT NULL,
    "error" TEXT,
    "lastReplyCheckAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundEmail" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "step" "EmailStep" NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "gmailMessageId" TEXT,
    "gmailThreadId" TEXT,
    "rfcMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailAccount_restaurantId_key" ON "GmailAccount"("restaurantId");

-- CreateIndex
CREATE INDEX "OutboundEmail_status_scheduledFor_idx" ON "OutboundEmail"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "OutboundEmail_restaurantId_sentAt_idx" ON "OutboundEmail"("restaurantId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEmail_draftId_step_key" ON "OutboundEmail"("draftId", "step");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_restaurantId_email_key" ON "Suppression"("restaurantId", "email");

-- AddForeignKey
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEmail" ADD CONSTRAINT "OutboundEmail_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEmail" ADD CONSTRAINT "OutboundEmail_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
