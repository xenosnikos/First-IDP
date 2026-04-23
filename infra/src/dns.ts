import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export function createDnsRecords(
  albDnsName: pulumi.Output<string>,
  nlbDnsName: pulumi.Output<string>,
) {
  const zone = aws.route53.getZone({ name: "twizz.app" });

  new aws.route53.Record("idp-record", {
    zoneId: zone.then(z => z.zoneId),
    name: "idp.twizz.app",
    type: "CNAME",
    ttl: 300,
    records: [albDnsName],
  });

  const tiers = ["dev", "qa", "staging", "preview"];
  tiers.forEach(tier =>
    new aws.route53.Record(`${tier}-wildcard`, {
      zoneId: zone.then(z => z.zoneId),
      name: `*.${tier}.twizz.app`,
      type: "CNAME",
      ttl: 300,
      records: [nlbDnsName],
    })
  );

  return { idpDomain: "idp.twizz.app", wildcardDomains: tiers.map(t => `*.${t}.twizz.app`) };
}
