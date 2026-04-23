import Link from "next/link";

export function ProjectLayout({ repoName, userName, children }: {
  repoName: string;
  userName?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-xl font-bold">TWIZZ-IDP</Link>
          <span className="text-muted-foreground">/</span>
          <Link href="/projects" className="text-muted-foreground hover:text-foreground">Projects</Link>
          <span className="text-muted-foreground">/</span>
          <span>{repoName}</span>
        </div>
        <span className="text-sm text-muted-foreground">{userName}</span>
      </header>
      <main className="p-8 max-w-6xl mx-auto space-y-8">{children}</main>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold mb-4">{title}</h2>
      {children}
    </section>
  );
}

const typeColor: Record<string, string> = {
  FRONTEND: "bg-blue-500/10 text-blue-400",
  BACKEND: "bg-green-500/10 text-green-400",
  FULLSTACK: "bg-purple-500/10 text-purple-400",
  UNKNOWN: "bg-zinc-500/10 text-zinc-400",
};

export function ProjectHeader({ name, type, description, repoName }: {
  name: string;
  type: string;
  description: string | null;
  repoName: string;
}) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold">{name}</h1>
          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${typeColor[type] ?? typeColor.UNKNOWN}`}>{type}</span>
        </div>
        <p className="text-muted-foreground mt-2">{description ?? name}</p>
      </div>
      <Link href={`/projects/${repoName}/deploy`}
        className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90">
        Deploy
      </Link>
    </div>
  );
}
