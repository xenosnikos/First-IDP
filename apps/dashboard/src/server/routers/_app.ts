import { router } from "../trpc";
import { projectRouter } from "./project";
import { environmentRouter } from "./environment";
import { pipelineRouter } from "./pipeline";
import { secretRouter } from "./secret";
import { logsRouter } from "./logs";
import { actionsRouter } from "./actions";
import { clustersRouter } from "./clusters";
import { nebulaRouter } from "./nebula";
import { observerRouter } from "./observer";
import { capacityRouter } from "./capacity";
import { monitorRouter } from "./monitor";

export const appRouter = router({
  project: projectRouter,
  environment: environmentRouter,
  pipeline: pipelineRouter,
  secret: secretRouter,
  logs: logsRouter,
  // Nebula: named-env reads + the gated write path (@twizz-idp/actions)
  actions: actionsRouter,
  // N3: read-only cluster/environment/project views (docs/NEBULA.md §N3.4)
  clusters: clustersRouter,
  nebula: nebulaRouter,
  // Observer phase 1: read-only log assistant status (runs stream via /api/observer)
  observer: observerRouter,
  // §N5: capacity presets, plans and the traffic calculator (queries; writes are in `actions`)
  capacity: capacityRouter,
  // §N6: consolidated near-real-time view of the Moly clusters (queries only)
  monitor: monitorRouter,
});

export type AppRouter = typeof appRouter;
