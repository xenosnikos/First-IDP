import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";

export type Overview = inferRouterOutputs<AppRouter>["clusters"]["overview"];
export type Cluster = Overview["clusters"][number];
export type ClusterName = Cluster["name"];
export type LogsOutput = inferRouterOutputs<AppRouter>["clusters"]["logs"];
export type LogLine = LogsOutput["lines"][number];

export type Selection = { cluster: ClusterName; namespace: string; pod?: string };

/** The committed query (what the Query button applied). */
export type AppliedQuery = Selection & { minutesBack: number; filter: string; errorsOnly: boolean };
