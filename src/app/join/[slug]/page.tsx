import { notFound } from "next/navigation";
import { Card, Logo } from "@/components/ui";
import { welcomeOffer } from "@/lib/customers";
import { db } from "@/lib/db";
import { JoinForm } from "./join-form";

export const metadata = { title: "Join our email list" };

/** Public: where the counter QR code leads. No sign-in. */
export default async function JoinPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const restaurant = await db.restaurant.findUnique({ where: { joinSlug: slug }, select: { id: true, name: true, outlets: { select: { address: true }, take: 1 } } });
  if (!restaurant) notFound();
  const welcome = await welcomeOffer(restaurant.id);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="flex w-full max-w-md flex-col gap-5 p-7">
        <Logo />
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-extrabold">Join {restaurant.name}&apos;s email list</h1>
          <p className="text-ink-2">{welcome ? `${welcome.title}. Your code arrives by email and shows on the next screen.` : "Get our offers by email, a few times a month at most."}</p>
        </div>
        <JoinForm slug={slug} restaurantName={restaurant.name} />
        <p className="text-[13px] text-muted">
          {restaurant.name}
          {restaurant.outlets[0] ? ` · ${restaurant.outlets[0].address}` : ""}. We only use your email to send our offers. Every email has an unsubscribe link.
        </p>
      </Card>
    </main>
  );
}
