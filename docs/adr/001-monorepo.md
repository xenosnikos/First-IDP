# ADR-001: Monorepo Strategy

**Date**: 2026-04-07 | **Status**: Accepted

## Context
IDP spans dashboard, IaC, Helm charts, Argo templates. Changes often cross layers.

## Decision
pnpm monorepo with Turborepo.

## Consequences
Atomic PRs, shared types, single CI. Larger repo over time.
