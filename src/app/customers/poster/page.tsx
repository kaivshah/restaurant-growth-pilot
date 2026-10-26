import QRCode from "qrcode";
import { ensureJoinSlug, joinUrl, welcomeOffer } from "@/lib/customers";
import { requireRestaurant } from "@/lib/restaurant";
import { PrintButton } from "./print-button";

/** A sheet for the counter: scan to join, with the welcome gift if there is one. */
export default async function PosterPage() {
  const restaurant = await requireRestaurant();
  const url = joinUrl(await ensureJoinSlug(restaurant));
  const [svg, welcome] = await Promise.all([QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }), welcomeOffer(restaurant.id)]);

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 bg-white px-4 py-10 text-center text-ink print:py-0">
      <div className="flex gap-3 print:hidden">
        <PrintButton />
        <a href="/customers" className="flex min-h-11 items-center rounded-field border border-field px-4 font-bold no-underline">
          Back
        </a>
      </div>
      <section className="flex w-full max-w-[640px] flex-col items-center gap-6 rounded-card border-4 border-primary p-10 print:border-2">
        <p className="text-xl font-bold text-primary">{restaurant.name}</p>
        <h1 className="text-[44px] leading-tight font-extrabold tracking-tight">{welcome ? welcome.headline || welcome.title : "Get our offers by email"}</h1>
        <p className="text-xl text-ink-2">Scan to join our email list{welcome ? " and get your code" : ""}.</p>
        <div className="w-full max-w-[340px]" role="img" aria-label="QR code to join the email list" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="text-sm break-all text-muted">{url}</p>
        <p className="text-sm text-muted">One per customer. Unsubscribe any time.</p>
      </section>
    </main>
  );
}
