import type { EksClusterInfo } from "@/server/services/aws";
import { InfoCard } from "./stack-detection";

export function EksClusterOverview({ cluster, nodes }: {
  cluster: EksClusterInfo;
  nodes: Array<{ name: string; cpu: number; mem: number; pods: number }>;
}) {
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <InfoCard label="Cluster" value={cluster.name} />
        <InfoCard label="Version" value={`K8s ${cluster.version}`} />
        <InfoCard label="Status" value={cluster.status} />
        <InfoCard label="Node Groups" value={String(cluster.nodeGroups.length)} />
      </div>
      {nodes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Nodes</h3>
          {nodes.map((n) => (
            <div key={n.name} className="flex items-center justify-between rounded-md border border-border/50 px-4 py-3 text-sm">
              <span className="font-mono text-xs">{n.name}</span>
              <div className="flex items-center gap-6 text-xs">
                <Metric label="CPU" value={n.cpu} warn={70} crit={90} />
                <Metric label="Mem" value={n.mem} warn={70} crit={90} />
                <span className="text-muted-foreground">{n.pods} pods</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, warn, crit }: { label: string; value: number; warn: number; crit: number }) {
  const color = value >= crit ? "text-red-400" : value >= warn ? "text-yellow-400" : "text-green-400";
  return <span className={color}>{label}: {value.toFixed(1)}%</span>;
}
