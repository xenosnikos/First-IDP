-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('FRONTEND', 'BACKEND', 'FULLSTACK', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EnvironmentTier" AS ENUM ('DEV', 'QA', 'STAGING', 'PREVIEW', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "EnvironmentStatus" AS ENUM ('PROVISIONING', 'RUNNING', 'FAILED', 'DESTROYING', 'DESTROYED');

-- CreateEnum
CREATE TYPE "DbStrategy" AS ENUM ('CLONE', 'SHARED', 'NONE');

-- CreateEnum
CREATE TYPE "PipelineStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "githubId" TEXT,
    "name" TEXT,
    "email" TEXT,
    "avatarUrl" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "githubRepoUrl" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProjectType" NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "detectedDeps" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Environment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tier" "EnvironmentTier" NOT NULL,
    "namespace" TEXT NOT NULL,
    "status" "EnvironmentStatus" NOT NULL DEFAULT 'PROVISIONING',
    "serviceUrl" TEXT,
    "ttlExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeployConfig" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "imageUri" TEXT,
    "replicas" INTEGER NOT NULL DEFAULT 1,
    "cpuLimit" TEXT NOT NULL DEFAULT '500m',
    "memLimit" TEXT NOT NULL DEFAULT '512Mi',
    "secretSetName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeployConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatabaseConfig" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "strategy" "DbStrategy" NOT NULL,
    "atlasClusterId" TEXT,
    "connectionStringSecretRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatabaseConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "argoWorkflowName" TEXT NOT NULL,
    "status" "PipelineStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "logsUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_githubLogin_key" ON "User"("githubLogin");

-- CreateIndex
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

-- CreateIndex
CREATE INDEX "AuditLog_actor_createdAt_idx" ON "AuditLog"("actor", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Project_githubRepoUrl_key" ON "Project"("githubRepoUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_namespace_key" ON "Environment"("namespace");

-- CreateIndex
CREATE UNIQUE INDEX "DeployConfig_environmentId_key" ON "DeployConfig"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "DatabaseConfig_environmentId_key" ON "DatabaseConfig"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineRun_argoWorkflowName_key" ON "PipelineRun"("argoWorkflowName");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Environment" ADD CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeployConfig" ADD CONSTRAINT "DeployConfig_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatabaseConfig" ADD CONSTRAINT "DatabaseConfig_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineRun" ADD CONSTRAINT "PipelineRun_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

