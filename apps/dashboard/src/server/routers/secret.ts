import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { environmentTierSchema } from "@twizz-idp/shared";
import { awsService } from "../services/aws";

export const secretRouter = router({
  list: protectedProcedure
    .input(z.object({ tier: environmentTierSchema }))
    .query(async ({ input }) => {
      const prefix = `twizz-idp/env/${input.tier.toLowerCase()}`;
      const secrets = await awsService.listSecrets(prefix);

      // For each secret, get its keys (never values)
      const withKeys = await Promise.all(
        secrets.map(async (s) => ({
          name: s.name,
          keys: await awsService.getSecretKeys(s.name),
          lastRotated: s.lastRotated,
        })),
      );

      return { tier: input.tier, secrets: withKeys };
    }),

  listKeys: protectedProcedure
    .input(z.object({ secretName: z.string() }))
    .query(async ({ input }) => {
      return awsService.getSecretKeys(input.secretName);
    }),
});
