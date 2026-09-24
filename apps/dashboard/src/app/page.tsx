import { auth, signIn } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Pill } from "@/components/nebula/pill";

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect("/environments");

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 32 }}>
      <div className="n-plate" style={{ width: "min(460px, 100%)", padding: 32 }}>
        <div className="n-label" style={{ marginBottom: 10 }}>twizz · internal · phase 0</div>
        <h1 className="n-display" style={{ fontSize: 44, lineHeight: 1, margin: "0 0 12px" }}>Nebula</h1>
        <p style={{ color: "var(--n-ink-muted)", margin: "0 0 20px", lineHeight: 1.6 }}>
          Preview environments from existing release images, DB-isolated, human-gated. Sign in with a GitHub account that is
          an active member of the Twizz org.
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
          <Pill word="SHIPPED" title="Environments grid + spin-up wizard + gate + release train to staging" />
          <Pill word="STUB" title="Planner / Coder / Reviewer / QA / Release / Observer agents" />
          <Pill word="PLANNED" title="Prod promotion, audit viewer" />
        </div>
        <form
          action={async () => {
            "use server";
            await signIn("github");
          }}
        >
          <button
            type="submit"
            style={{ fontFamily: "inherit", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", padding: "10px 18px", borderRadius: "var(--n-radius)", border: "1px solid var(--n-ion)", background: "var(--n-ion)", color: "var(--n-ion-ink)", cursor: "pointer" }}
          >
            Sign in with GitHub
          </button>
        </form>
      </div>
    </main>
  );
}
