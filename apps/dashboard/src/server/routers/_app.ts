import { router } from "../trpc";
import { projectRouter } from "./project";
import { environmentRouter } from "./environment";
import { pipelineRouter } from "./pipeline";
import { secretRouter } from "./secret";
import { releaseRouter } from "./release";
import { logsRouter } from "./logs";

export const appRouter = router({
  project: projectRouter,
  environment: environmentRouter,
  pipeline: pipelineRouter,
  secret: secretRouter,
  release: releaseRouter,
  logs: logsRouter,
});

export type AppRouter = typeof appRouter;
