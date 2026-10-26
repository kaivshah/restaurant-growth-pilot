import { Card, Logo } from "@/components/ui";
import { db } from "@/lib/db";
import { readUnsubscribeToken, suppress } from "@/lib/outreach";

/** The unsubscribe link in every email. Public: no sign-in needed. */
export default async function UnsubscribePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const { done } = await searchParams;
  const who = readUnsubscribeToken(token);
  const restaurant = who ? await db.restaurant.findUnique({ where: { id: who.restaurantId }, select: { name: true } }) : null;
  const already = who ? await db.suppression.findUnique({ where: { restaurantId_email: { restaurantId: who.restaurantId, email: who.email } } }) : null;

  async function confirm() {
    "use server";
    if (who) await suppress(who.restaurantId, who.email, "unsubscribed");
    const { redirect } = await import("next/navigation");
    redirect(`/u/${token}?done=1`);
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="flex w-full max-w-md flex-col gap-5 p-8">
        <Logo />
        {!who || !restaurant ? (
          <p className="text-ink-2">This unsubscribe link isn&apos;t valid. If you keep getting emails, reply &ldquo;unsubscribe&rdquo; and we&apos;ll stop.</p>
        ) : done || already ? (
          <>
            <h1 className="text-2xl font-extrabold">You&apos;re unsubscribed</h1>
            <p className="text-ink-2">
              {restaurant.name} won&apos;t email {who.email} again.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-extrabold">Unsubscribe from {restaurant.name}?</h1>
            <p className="text-ink-2">We&apos;ll stop emailing {who.email} about catering. This takes effect right away.</p>
            <form action={confirm}>
              <button type="submit" className="min-h-12 w-full rounded-field bg-primary px-5 font-bold text-white hover:bg-primary-hover">
                Unsubscribe
              </button>
            </form>
          </>
        )}
      </Card>
    </main>
  );
}
