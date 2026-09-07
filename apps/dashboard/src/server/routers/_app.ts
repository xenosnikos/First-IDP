import { router } from "../trpc";
import { projectRouter } from "./project";
import { environmentRouter } from "./environment";
import { pipelineRouter } from "./pipeline";
import { secretRouter } from "./secret";
import { logsRouter } from "./logs";
import { actionsRouter } from "./actions";

export const appRouter = router({
  project: projectRouter,
  environment: environmentRouter,
  pipeline: pipelineRouter,
  secret: secretRouter,
  logs: logsRouter,
  // Nebula: named-env reads + the gated write path (@twizz-idp/actions)
  actions: actionsRouter,
});

export type AppRouter = typeof appRouter;
