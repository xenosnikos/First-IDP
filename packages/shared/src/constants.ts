export const ENV_TIERS = ["DEV", "QA", "STAGING", "PREVIEW", "PRODUCTION"] as const;

export const DEFAULT_TTL_HOURS = 72;
export const DEFAULT_CPU = "500m";
export const DEFAULT_MEM = "512Mi";
export const DEFAULT_REPLICAS = 1;

export const URL_PATTERNS = {
  DEV: (service: string, branch: string) =>
    `${service}-${branch}.dev.twizz.app`,
  QA: (name: string) => `${name}.qa.twizz.app`,
  STAGING: (service: string) => `${service}.staging.twizz.app`,
  PREVIEW: (prNumber: number) => `pr-${prNumber}.preview.twizz.app`,
  PRODUCTION: (service: string) => `${service}.twizz.app`,
} as const;

export const CHECK_IDS = [
  { id: "CHK-01", name: "Vulnerability scan", gate: "P0" },
  { id: "CHK-02", name: "Memory leak detection", gate: "P1" },
  { id: "CHK-03", name: "Expensive operation audit", gate: "P1" },
  { id: "CHK-04", name: "Secret leak scan", gate: "P0" },
  { id: "CHK-05", name: "License compliance", gate: "P2" },
  { id: "CHK-06", name: "API contract validation", gate: "P1" },
  { id: "CHK-07", name: "DB migration safety", gate: "P0" },
  { id: "CHK-08", name: "Performance regression", gate: "P1" },
  { id: "CHK-09", name: "Container image size", gate: "P2" },
  { id: "CHK-10", name: "Test suite pass", gate: "P0" },
  { id: "CHK-11", name: "Risky operation detector", gate: "P1" },
  { id: "CHK-12", name: "Environment parity check", gate: "P2" },
] as const;

export const PIPELINE_TEMPLATES = {
  BACKEND_DEPLOY: "build-and-deploy-backend",
  FRONTEND_DEPLOY: "build-and-deploy-frontend",
  PROVISION_DB: "provision-database",
  RUN_CHECKS: "run-checks",
  PROMOTE_RELEASE: "promote-release",
} as const;

export const ECR_BASE = "848281935985.dkr.ecr.eu-west-1.amazonaws.com";
export const AWS_REGION = "eu-west-1";
