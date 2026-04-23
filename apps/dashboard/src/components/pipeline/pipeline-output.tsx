"use client";

export function PipelineOutput({ outputs }: { outputs: Record<string, string> }) {
  const url = outputs.serviceHost || outputs.url || outputs.endpoint;

  if (!url) return null;

  const fullUrl = url.startsWith("http") ? url : `https://${url}`;

  return (
    <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p className="text-sm font-medium text-green-400">Deployment Successful</p>
          <a
            href={fullUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-mono text-primary hover:underline"
          >
            {url}
          </a>
        </div>
      </div>
      <button
        onClick={() => navigator.clipboard.writeText(fullUrl)}
        className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-accent transition-colors text-muted-foreground"
      >
        Copy URL
      </button>
    </div>
  );
}
