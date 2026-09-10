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
});

export type AppRouter = typeof appRouter;
