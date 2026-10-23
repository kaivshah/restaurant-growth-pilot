import { ButtonLink, Card } from "@/components/ui";
import { requireRestaurant } from "@/lib/restaurant";

export default async function MenuStep() {
  await requireRestaurant();
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-extrabold leading-tight tracking-tight">Your menu and catering packages</h1>
        <p className="max-w-[62ch] text-muted">
          Catering pitches will use your real catering menu and prices, so the AI never invents items.
        </p>
      </div>
      <Card className="flex flex-col gap-4 p-6 sm:p-8">
        <h2 className="text-lg font-bold">Menu upload is coming in the next update</h2>
        <p className="max-w-[62ch] text-ink-2">
          You&apos;ll be able to upload a menu photo or PDF, and pick platters, boxed meals and giant subs with your local prices. For now, you can skip this step.
        </p>
        <div className="flex flex-wrap justify-between gap-3 border-t border-sand pt-6">
          <ButtonLink href="/setup/reports" variant="quiet">
            Back
          </ButtonLink>
          <ButtonLink href="/setup/rules">Skip for now</ButtonLink>
        </div>
      </Card>
    </>
  );
}
