import type { TwizzYamlV2 } from "@twizz-idp/shared";
import type { AgentCtxBase, AgentEvent } from "../agent";

/** The read-only slice of GitHub the Configurator sees, injected with the
 * HUMAN's session token so it can only read what they can already read. */
export type RepoReader = {
  listTree(): Promise<{ entries: Array<{ path: string; type: "blob" | "tree"; size?: number }>; truncated: boolean }>;
  getFile(path: string): Promise<string | null>;
};

export type Proposal = {
  twizzYaml: TwizzYamlV2;
  dockerfile?: { path: string; content: string; reason: string };
  notes: string[];
  basedOn: string[];
  confidence: "high" | "medium" | "low";
  needsHuman: string[];
};

export type ConfiguratorCtx = AgentCtxBase & {
  repo: string;
  ref: string;
  sha: string;
  reader: RepoReader;
  /** Per-run scratch: cached tree, files read, the accepted proposal. */
  notes: Record<string, unknown>;
  redactions: Record<string, number>;
  proposal?: Proposal;
  /** How many times propose_config was rejected (schema issues). */
  rejected: number;
};

export type ConfiguratorEvent = AgentEvent | { type: "proposal"; word: "PASS"; proposal: Proposal };
