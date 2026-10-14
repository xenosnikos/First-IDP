import * as aws from "@pulumi/aws";

export function createEcrRepos(tags: Record<string, string>) {
  const repos = ["twizz-idp", "twizz-services", "twizz-cache"].map(name => {
    const repo = new aws.ecr.Repository(name, {
      name,
      imageTagMutability: "MUTABLE",
      imageScanningConfiguration: { scanOnPush: true },
      tags,
    });

    new aws.ecr.LifecyclePolicy(`${name}-lifecycle`, {
      repository: repo.name,
      policy: JSON.stringify({
        rules: [
          { rulePriority: 1, description: "Expire untagged 7d", selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 7 }, action: { type: "expire" } },
          // Per-target retention: each build pushes 3 targets x (index + image + attestation),
          // so the old global "keep last 20" was ~2 builds and expired the tags gitops
          // pins (the 2026-09 Nebula 503). 30 builds per target is weeks of rollback room.
          ...["dashboard-", "migrate-", "reaper-"].map((prefix, i) => ({
            rulePriority: 2 + i,
            description: `Keep last 30 ${prefix}*`,
            selection: { tagStatus: "tagged", tagPrefixList: [prefix], countType: "imageCountMoreThan", countNumber: 30 },
            action: { type: "expire" },
          })),
          // tagStatus=any must be the lowest-priority (highest number) rule
          { rulePriority: 9, description: "Backstop: keep last 400", selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 400 }, action: { type: "expire" } },
        ],
      }),
      // one lifecycle policy per repo: a create-before-delete replace would delete the new one
    }, { deleteBeforeReplace: true });

    return { name, url: repo.repositoryUrl };
  });

  return { idpRepoUrl: repos[0].url, servicesRepoUrl: repos[1].url, cacheRepoUrl: repos[2].url };
}
