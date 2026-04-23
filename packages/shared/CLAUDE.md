# @twizz-idp/shared

Shared types, Zod validators, and constants for the TWIZZ-IDP platform.

- Import: `import { createEnvironmentSchema, ENV_TIERS, CHECK_IDS } from "@twizz-idp/shared"`
- All schemas are Zod-first -- infer TS types from them with `z.infer<typeof schema>`
- Types in `src/types/`, constants in `src/constants.ts`
- Barrel export from `src/index.ts`
