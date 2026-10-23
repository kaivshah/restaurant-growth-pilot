import { redirect } from "next/navigation";
import { currentUserId, devLoginEnabled, googleEnabled, signIn } from "@/auth";
import { Button, Card, Logo, Notice } from "@/components/ui";

export default async function LoginPage() {
  if (await currentUserId()) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="flex w-full max-w-md flex-col gap-6 p-8">
        <Logo />
        <div className="flex flex-col gap-2">
          <h1 className="text-[28px] font-extrabold leading-tight tracking-tight">Grow your restaurant, one approved message at a time</h1>
          <p className="text-muted">
            We find nearby offices for catering and suggest offers from your sales reports. Nothing is sent until you approve it.
          </p>
        </div>

        {googleEnabled && (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <Button type="submit" className="w-full">
              Continue with Google
            </Button>
          </form>
        )}

        {devLoginEnabled && (
          <form
            action={async () => {
              "use server";
              await signIn("demo", { redirectTo: "/" });
            }}
          >
            <Button type="submit" variant="secondary" className="w-full">
              Continue as demo owner
            </Button>
          </form>
        )}

        {!googleEnabled && !devLoginEnabled && (
          <Notice title="Sign-in isn't set up yet">
            Add AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET to the environment to turn on Google sign-in.
          </Notice>
        )}
      </Card>
    </main>
  );
}
