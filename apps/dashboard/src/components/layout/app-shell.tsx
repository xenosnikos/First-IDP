import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "./sidebar";
import { TRPCProvider } from "@/lib/trpc-provider";
import { ThemeToggle } from "@/components/nebula/theme-toggle";
import { Pill } from "@/components/nebula/pill";
import { isOperator } from "@/lib/nebula/operators";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const login = (session as { login?: string }).login;
  const operator = isOperator(login);

  return (
    <TRPCProvider>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <Sidebar />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          <header style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 14, padding: "0 24px", borderBottom: "1px solid var(--n-hairline)" }}>
            <ThemeToggle />
            <span style={{ width: 1, height: 18, background: "var(--n-hairline)" }} />
            {/* Role is shown as a word, never inferred from colour */}
            {operator ? (
              <span className="n-label" title="Nebula operator: writes are gated + audited" style={{ color: "var(--n-ion-soft)" }}>operator</span>
            ) : (
              <Pill word="READ-ONLY" title={`Not in NEBULA_OPERATORS — actions are disabled`} />
            )}
            {session.user.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={session.user.image} alt="" style={{ width: 24, height: 24, borderRadius: 3, border: "1px solid var(--n-hairline)" }} />
            )}
            <span style={{ fontSize: 12, color: "var(--n-ink-muted)" }}>{login ?? session.user.name}</span>
          </header>
          <main style={{ flex: 1, overflowY: "auto" }}>{children}</main>
        </div>
      </div>
    </TRPCProvider>
  );
}
