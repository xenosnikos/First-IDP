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
          { rulePriority: 1, description: "Keep last 20", selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 20 }, action: { type: "expire" } },
          { rulePriority: 2, description: "Expire untagged 7d", selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 7 }, action: { type: "expire" } },
        ],
      }),
    });

    return { name, url: repo.repositoryUrl };
  });

  return { idpRepoUrl: repos[0].url, servicesRepoUrl: repos[1].url, cacheRepoUrl: repos[2].url };
}
