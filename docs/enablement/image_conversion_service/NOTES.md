# image_conversion_service — preview stacks + OIDC migration

## Files

- `preview.yml` → `.github/workflows/preview.yml` (per-PR SAM stack on label
  `preview-lambda`, teardown on close, ARN published to PR comment + SSM
  `/preview/pr-<n>/image-conversion-arn`).

## Repo setup

- Add repo **variable** `PREVIEW_SOURCE_BUCKET` (a dev/staging S3 bucket the
  preview Lambda may read/write).
- IAM role `twizz-gha-sam-deploy` is created by twizz-idp Pulumi (Phase 2 stack);
  trust is scoped to `repo:twizz-app/image_conversion_service:*`.

## Migrate the existing deploy.yml off static keys

`.github/workflows/deploy.yml` currently uses `aws-access-key-id`/`aws-secret-access-key`
from repo secrets. Replace that step with:

```yaml
permissions:
  id-token: write
  contents: read
...
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::848281935985:role/twizz-gha-sam-deploy
          aws-region: eu-west-1
```

Then delete the static AWS keys from the repo secrets AND deactivate that IAM
user's keys in AWS (SECURITY-ROTATIONS.md gets a tick).

## Backend consumption

Moly-backend previews resolve the Lambda by env override — default is the
standing dev stack; a linked preview stack wins when present. (The values file
sets nothing today: the worker falls back to `IMAGE_CONVERSION_ARN` from the
`preview/moly-backend` secret. Point that at the dev stack function; per-PR
linkage can be added later via the same env-override mechanism.)
