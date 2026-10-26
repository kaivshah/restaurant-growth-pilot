-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'UNSUBSCRIBED');

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "sentAudience" TEXT;

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "customerDailyCap" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "joinSlug" TEXT;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "source" TEXT NOT NULL,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "consentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferCode" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEmail" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "gmailMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_restaurantId_status_idx" ON "Customer"("restaurantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_restaurantId_email_key" ON "Customer"("restaurantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "OfferCode_code_key" ON "OfferCode"("code");

-- CreateIndex
CREATE INDEX "OfferCode_restaurantId_redeemedAt_idx" ON "OfferCode"("restaurantId", "redeemedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OfferCode_draftId_customerId_key" ON "OfferCode"("draftId", "customerId");

-- CreateIndex
CREATE INDEX "CustomerEmail_status_scheduledFor_idx" ON "CustomerEmail"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEmail_draftId_customerId_key" ON "CustomerEmail"("draftId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Restaurant_joinSlug_key" ON "Restaurant"("joinSlug");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferCode" ADD CONSTRAINT "OfferCode_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferCode" ADD CONSTRAINT "OfferCode_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferCode" ADD CONSTRAINT "OfferCode_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEmail" ADD CONSTRAINT "CustomerEmail_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEmail" ADD CONSTRAINT "CustomerEmail_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEmail" ADD CONSTRAINT "CustomerEmail_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

