# ADR-002: ECS Fargate for IDP Dashboard

**Date**: 2026-04-07 | **Status**: Accepted

## Context
Dashboard must survive EKS outages and access RDS directly.

## Decision
ECS Fargate (standalone), not EKS or Vercel.

## Consequences
Survives EKS crashes, direct VPC to RDS, ~$15/mo, separate deploy pipeline.
