import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// twizz.com DNS is hosted at Cloudflare, so we own a DELEGATED subdomain zone here:
// prv.twizz.com. One-time manual step after the first `pulumi up`: add the
// exported `previewZoneNameservers` as NS records for `prv` (DNS-only / grey
// cloud) in the twizz.com zone at Cloudflare. After that, wildcard + DNS-01 are fully automated.
export function createDnsRecords(nlbDnsName: pulumi.Output<string>, tags: Record<string, string>) {
  const zone = new aws.route53.Zone("prv-twizz-com", {
    name: "prv.twizz.com",
    comment: "Delegated preview-environment zone (IDP-managed)",
    tags,
  });

  new aws.route53.Record("preview-wildcard", {
    zoneId: zone.zoneId,
    name: "*.prv.twizz.com",
    type: "CNAME",
    ttl: 300,
    records: [nlbDnsName],
  });

  return {
    zoneId: zone.zoneId,
    nameservers: zone.nameServers, // add these at OVH as NS records for "preview"
    wildcardDomain: "*.prv.twizz.com",
  };
}
