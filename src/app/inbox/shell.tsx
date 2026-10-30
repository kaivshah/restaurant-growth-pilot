import { signOut } from "@/auth";
import { Logo } from "@/components/ui";
import { MobileMenu, NavLinks, SettingsTabs } from "./nav";

export function AppShell({
  pending,
  restaurantName,
  address,
  settings = false,
  children,
}: {
  pending: number;
  restaurantName: string;
  address?: string;
  /** Show the Settings tabs above the page */
  settings?: boolean;
  children: React.ReactNode;
}) {
  const account = (
    <div className="flex flex-col gap-2 border-t border-sand px-3.5 pt-4 text-sm text-muted">
      <span>
        <strong className="block text-ink">{restaurantName}</strong>
        {address}
      </span>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <button type="submit" className="min-h-11 font-semibold text-primary hover:text-primary-hover">
          Sign out
        </button>
      </form>
    </div>
  );

  return (
    <div className="grid min-h-screen md:grid-cols-[248px_minmax(0,1fr)]">
      <nav aria-label="Main" className="flex flex-col gap-3 border-b border-line bg-surface p-4 md:sticky md:top-0 md:h-screen md:overflow-y-auto md:border-r md:border-b-0 md:p-6">
        <div className="px-2.5 md:pb-4">
          <Logo />
        </div>
        <MobileMenu pending={pending}>
          <NavLinks pending={pending} />
          {account}
        </MobileMenu>
        <div className="hidden flex-1 flex-col gap-4 md:flex">
          <NavLinks pending={pending} />
          <div className="mt-auto">{account}</div>
        </div>
      </nav>
      <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-8">
        {settings && <SettingsTabs />}
        {children}
      </main>
    </div>
  );
}
