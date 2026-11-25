-- CreateTable
CREATE TABLE "LifecycleSnapshot" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "LifecycleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifecycleRequest" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "runId" TEXT,
    "error" TEXT,

    CONSTRAINT "LifecycleRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LifecycleSnapshot_runId_key" ON "LifecycleSnapshot"("runId");

-- CreateIndex
CREATE INDEX "LifecycleSnapshot_job_createdAt_idx" ON "LifecycleSnapshot"("job", "createdAt");

-- CreateIndex
CREATE INDEX "LifecycleRequest_status_createdAt_idx" ON "LifecycleRequest"("status", "createdAt");
