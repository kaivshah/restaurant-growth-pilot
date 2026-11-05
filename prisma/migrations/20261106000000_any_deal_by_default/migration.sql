-- Any deal is allowed by default: no brand approval needed, price cuts and
-- buy-one-get-one allowed. The owner can still restrict this in Offer rules.
ALTER TABLE "Restaurant" ALTER COLUMN "promoApproval" SET DEFAULT 'YES';
ALTER TABLE "Restaurant" ALTER COLUMN "maxDiscountPct" SET DEFAULT 25;
ALTER TABLE "Restaurant" ALTER COLUMN "allowBogo" SET DEFAULT true;

-- Existing stores move to the new defaults too (their discount limit is kept).
UPDATE "Restaurant" SET "promoApproval" = 'YES', "allowFreeExtra" = true, "allowFreeDelivery" = true, "allowPercentOff" = true, "allowBogo" = true;
