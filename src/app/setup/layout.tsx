import { Logo } from "@/components/ui";
import { getRestaurant, requireUserId } from "@/lib/restaurant";
import { StepProgress, Stepper } from "./steps";

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const userId = await requireUserId();
  const restaurant = await getRestaurant(userId);

  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-4 sm:px-8">
        <Logo />
        <div className="flex items-center gap-4 text-sm text-muted">
          <StepProgress />
          {restaurant && <span className="hidden font-semibold text-ink sm:inline">{restaurant.name}</span>}
        </div>
      </header>
      <div className="mx-auto flex max-w-[1180px] flex-col gap-8 px-4 pt-8 pb-12 sm:px-8">
        <Stepper hasRestaurant={Boolean(restaurant)} />
        {children}
      </div>
    </div>
  );
}
