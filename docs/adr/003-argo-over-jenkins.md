# ADR-003: Argo over Jenkins/Spinnaker

**Date**: 2026-04-07 | **Status**: Accepted

## Context
Need pipeline engine for CI/CD and GitOps.

## Decision
Argo Workflows (pipelines) + Argo CD (GitOps).

## Consequences
K8s-native CRDs, DAG support, low overhead (2 controllers vs Jenkins JVM or Spinnaker 6+ services).
