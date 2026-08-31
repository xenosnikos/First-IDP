// File templates dropped into repos at onboarding. Kept as plain string
// builders so the CLI has zero templating dependencies.

const ECR_REGISTRY = "848281935985.dkr.ecr.eu-west-1.amazonaws.com";
const GHA_ECR_ROLE = "arn:aws:iam::848281935985:role/twizz-gha-ecr-push";

export type ProjectKind = "backend-k8s" | "frontend-vercel" | "lambda-sam";

export function twizzManifest(opts: {
  name: string;
  kind: ProjectKind;
  port?: number;
  healthPath?: string;
  secretName?: string;
}): string {
  return [
    `# Twizz IDP manifest — created by the onboarding CLI`,
    `name: ${opts.name}`,
    `kind: ${opts.kind}`,
    ...(opts.kind === "backend-k8s"
      ? [
          `port: ${opts.port ?? 8080}`,
          `healthPath: ${opts.healthPath ?? "/health"}`,
          `secretName: ${opts.secretName ?? `preview/${opts.name}`}`,
        ]
      : []),
    ``,
  ].join("\n");
}

export function previewWorkflow(opts: { name: string; ecrRepo: string }): string {
  return `name: preview

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  id-token: write
  contents: read
  pull-requests: write

env:
  ECR_REGISTRY: ${ECR_REGISTRY}
  ECR_REPO: ${opts.ecrRepo}

concurrency:
  group: preview-\${{ github.event.number }}
  cancel-in-progress: true

jobs:
  build-and-label:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${GHA_ECR_ROLE}
          aws-region: eu-west-1

      - uses: aws-actions/amazon-ecr-login@v2

      - uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: \${{ env.ECR_REGISTRY }}/\${{ env.ECR_REPO }}:pr-\${{ github.event.number }}-\${{ github.event.pull_request.head.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Add preview label
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh pr edit \${{ github.event.number }} --add-label preview --repo \${{ github.repository }}

      - name: Comment preview URL
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          URL="https://pr-\${{ github.event.number }}-${opts.name}.prv.twizz.com"
          gh pr comment \${{ github.event.number }} --repo \${{ github.repository }} \\
            --body "🚀 Preview building: $URL (live ~3 min after this comment)" \\
            --edit-last --create-if-none
`;
}

export function aiReviewWorkflow(): string {
  return `name: ai-review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Review this pull request for correctness bugs, security issues, and
            breaking API changes. Be concise: only flag findings you are
            confident about, with file:line references. End with a one-line
            verdict: APPROVE or NEEDS-CHANGES.
`;
}

export function gitopsValues(opts: {
  name: string;
  ecrRepo: string;
  port: number;
  healthPath: string;
  secretName: string;
}): string {
  return `# Preview defaults for ${opts.name}. image.tag / ingress.host / env.* per-PR
# values are injected by the ApplicationSet as Helm parameters.
nameOverride: ${opts.name}
fullnameOverride: ${opts.name}

replicaCount: 1

image:
  repository: ${ECR_REGISTRY}/${opts.ecrRepo}
  tag: dev # overridden per PR
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: ${opts.port}

ingress:
  enabled: true
  className: nginx
  host: "" # overridden per PR
  tls:
    enabled: false # wildcard *.prv.twizz.com cert on ingress-nginx

resources:
  requests: { cpu: 100m, memory: 256Mi }
  limits: { cpu: 500m, memory: 1Gi }

autoscaling:
  enabled: false

serviceAccount:
  create: true
  roleArn: arn:aws:iam::848281935985:role/twizz-nonprod-preview-pods

externalSecret:
  enabled: false

env:
  NODE_ENV: development
  HTTP_PORT: "${opts.port}"
  AWS_SECRET_NAME: ${opts.secretName}
  AWS_REGION: eu-west-1

readinessProbe:
  httpGet: { path: ${opts.healthPath}, port: http }
  initialDelaySeconds: 15
  periodSeconds: 10

livenessProbe:
  httpGet: { path: ${opts.healthPath}, port: http }
  initialDelaySeconds: 60
  periodSeconds: 30

ttl: "168h"

namespace:
  resourceQuota: { enabled: true, cpu: "2", memory: 4Gi }
  networkPolicy: { enabled: true }
`;
}

export function gitopsAppset(opts: { name: string; owner: string; repo: string }): string {
  return `# One preview environment per open PR labelled \`preview\` on ${opts.owner}/${opts.repo}.
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: ${opts.name}-preview
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - pullRequest:
        github:
          owner: ${opts.owner}
          repo: ${opts.repo}
          labels: [preview]
          tokenRef:
            secretName: github-token
            key: token
        requeueAfterSeconds: 60
  template:
    metadata:
      name: "${opts.name}-pr-{{.number}}"
      labels:
        twizz-idp/repo: ${opts.name}
        twizz-idp/pr: "{{.number}}"
    spec:
      project: previews
      sources:
        - repoURL: https://github.com/TwizzyNicky/twizz-gitops
          targetRevision: main
          ref: values
        - repoURL: https://github.com/TwizzyNicky/twizz-gitops
          targetRevision: main
          path: charts/twizz-service
          helm:
            valueFiles:
              - $values/apps/${opts.name}/values.yaml
            parameters:
              - name: image.tag
                value: "pr-{{.number}}-{{.head_sha}}"
              - name: ingress.host
                value: "pr-{{.number}}-${opts.name}.prv.twizz.com"
      destination:
        server: https://kubernetes.default.svc
        namespace: "pr-${opts.name}-{{.number}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
        managedNamespaceMetadata:
          labels:
            twizz-idp/preview: "true"
            twizz-idp/repo: ${opts.name}
`;
}
