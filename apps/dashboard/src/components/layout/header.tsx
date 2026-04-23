export function Header({ userName }: { userName?: string }) {
  return (
    <header className="h-14 border-b border-border bg-card flex items-center justify-between px-6">
      <div />
      <div className="text-sm text-muted-foreground">
        {userName ? `Signed in as ${userName}` : "Not signed in"}
      </div>
    </header>
  );
}
