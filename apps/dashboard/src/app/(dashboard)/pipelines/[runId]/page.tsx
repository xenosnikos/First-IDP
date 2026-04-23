import Link from "next/link";
import { PipelineRunView } from "@/components/pipeline/pipeline-run-view";

export default async function PipelineRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
        <Link href="/pipelines" className="hover:text-foreground">Pipelines</Link>
        <span>/</span>
        <span className="text-foreground font-mono">{runId.slice(0, 8)}</span>
      </div>

      <PipelineRunView runId={runId} />
    </div>
  );
}
