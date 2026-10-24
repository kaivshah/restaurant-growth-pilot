-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('OFFERS', 'LEADS');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'DRAFTED', 'APPROVED', 'EXCLUDED');

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "contactId" TEXT,
ADD COLUMN     "eventId" TEXT,
ADD COLUMN     "leadId" TEXT;

-- AlterTable
ALTER TABLE "DraftJob" ADD COLUMN     "kind" "JobKind" NOT NULL DEFAULT 'OFFERS';

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "geocodedAddress" TEXT;

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "types" TEXT[],
    "address" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "distanceMiles" DOUBLE PRECISION NOT NULL,
    "website" TEXT,
    "phone" TEXT,
    "ratingCount" INTEGER,
    "businessStatus" TEXT,
    "fitScore" INTEGER NOT NULL,
    "scoreReasons" TEXT[],
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "excludeReason" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "contactsCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT,
    "email" TEXT NOT NULL,
    "confidence" INTEGER,
    "verification" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadScan" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'RUNNING',
    "placesProvider" TEXT NOT NULL,
    "contactsProvider" TEXT NOT NULL,
    "eventsProvider" TEXT NOT NULL,
    "leadsFound" INTEGER NOT NULL DEFAULT 0,
    "contactsFound" INTEGER NOT NULL DEFAULT 0,
    "eventsFound" INTEGER NOT NULL DEFAULT 0,
    "pitchesDrafted" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "LeadScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "venueName" TEXT,
    "venueAddress" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "distanceMiles" DOUBLE PRECISION,
    "attendance" INTEGER,
    "organizer" TEXT,
    "url" TEXT,
    "fitScore" INTEGER NOT NULL,
    "scoreReasons" TEXT[],
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lead_restaurantId_status_idx" ON "Lead"("restaurantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_restaurantId_placeId_key" ON "Lead"("restaurantId", "placeId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_leadId_email_key" ON "Contact"("leadId", "email");

-- CreateIndex
CREATE INDEX "LeadScan_restaurantId_createdAt_idx" ON "LeadScan"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "Event_restaurantId_startsAt_idx" ON "Event"("restaurantId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Event_restaurantId_source_externalId_key" ON "Event"("restaurantId", "source", "externalId");

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadScan" ADD CONSTRAINT "LeadScan_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
