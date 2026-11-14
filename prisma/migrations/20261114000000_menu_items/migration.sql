-- CreateEnum
CREATE TYPE "MenuSource" AS ENUM ('SEED', 'READ', 'OWNER');

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN "menuConfirmedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT '',
    "price" DOUBLE PRECISION,
    "cost" DOUBLE PRECISION,
    "isCatering" BOOLEAN NOT NULL DEFAULT false,
    "servesMin" INTEGER,
    "servesMax" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" "MenuSource" NOT NULL DEFAULT 'SEED',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "inventoryNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_restaurantId_category_name_size_key" ON "MenuItem"("restaurantId", "category", "name", "size");
CREATE INDEX "MenuItem_restaurantId_isCatering_active_idx" ON "MenuItem"("restaurantId", "isCatering", "active");

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
