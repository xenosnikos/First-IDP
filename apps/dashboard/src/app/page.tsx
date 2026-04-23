import { auth, signIn } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function Home() {
  const session = await auth();

  if (session?.user) {
    redirect("/projects");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8">
      <h1 className="text-4xl font-bold tracking-tight">
        TWIZZ<span className="text-primary">-IDP</span>
      </h1>
      <p className="text-muted-foreground text-lg">
        Internal Developer Platform
      </p>
      <form
        action={async () => {
          "use server";
          await signIn("github");
        }}
      >
        <button
          type="submit"
          className="rounded-lg bg-primary px-8 py-3 font-medium text-primary-foreground hover:opacity-90"
        >
          Sign in with GitHub
        </button>
      </form>
    </main>
  );
}
