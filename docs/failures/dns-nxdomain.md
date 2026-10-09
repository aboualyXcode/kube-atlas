<!-- Generated from data/failures/dns.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# DNS — no such host (NXDOMAIN)

The name does not exist as written: a typo, the wrong namespace, or a short name expanded in the wrong search domain.

| Kind | Layer | Scope | Interactive |
|---|---|---|---|
| Cause | DNS | Any Kubernetes cluster | [Open in the atlas](../../index.html#/failures/dns-nxdomain) |

## How it propagates

```mermaid
flowchart LR
  o0["Your pod<br/>Looks up a name that does not exist as written"]:::origin
  p0["CoreDNS<br/>Answers NXDOMAIN"]:::path
  s["Your pod<br/>no such host: startup crash or failed calls"]:::symptom
  o0 --> p0
  p0 --> s
  classDef origin fill:#fde3e6,stroke:#d7263d,stroke-width:2px,color:#17212c
  classDef path fill:#fff1dc,stroke:#cf7c00,color:#17212c
  classDef symptom fill:#e9eef3,stroke:#17212c,stroke-width:2px,color:#17212c
  classDef branch fill:#ffffff,stroke:#cf7c00,stroke-dasharray:4 3,color:#17212c
```

## Symptom

An application fails to reach a dependency with `no such host`, `NXDOMAIN` or `ENOTFOUND`, immediately
rather than after a timeout. Usually it is one name in one namespace; other lookups work.

## Affected component

**CoreDNS** answered authoritatively that the name does not exist. The cause is almost always the
**name** the application uses, or the Service it expects not existing.

## Root cause

Kubernetes DNS names are scoped: `payments-api` resolves only from pods in the `payments` namespace,
because the resolver appends the pod's own namespace first (`<name>.<pod-namespace>.svc.cluster.local`).
From another namespace you need `payments-api.payments` or the full name. Other causes:

- the Service does not exist, is in another namespace, or was renamed;
- a headless Service with no ready pods has no records;
- an ExternalName or a private Route 53 zone the VPC is not associated with;
- a custom CoreDNS configuration (`coredns-custom` or a modified Corefile) that rewrites or stubs the
  domain incorrectly.

## Investigation

1. **Reproduce from a pod in the same namespace**

   ```sh
   kubectl run dnsprobe -n shop --rm -it --restart=Never --image=busybox:1.36 -- \
     sh -c 'cat /etc/resolv.conf; nslookup payments-api; nslookup payments-api.payments.svc.cluster.local'
   ```

   Look for: The short name failing and the namespaced name working.

2. **Check the Service exists where you think**

   ```sh
   kubectl get svc -A --field-selector metadata.name=payments-api
   ```

   Look for: The Service in a different namespace, or not at all.

3. **For external names, test the VPC resolver**

   ```sh
   kubectl run dnsprobe -n shop --rm -it --restart=Never --image=busybox:1.36 -- nslookup orders-db.internal.larder.example
   aws route53 list-hosted-zones-by-vpc --vpc-id <vpc-id> --vpc-region eu-west-1
   ```

   Look for: A private zone not associated with the cluster VPC.

## Resolution

Use the namespaced name (`payments-api.payments.svc.cluster.local`, or at least `payments-api.payments`)
in configuration, create or fix the Service, or associate the private hosted zone with the VPC.

## Prevention

- Put fully qualified service names in configuration for cross-namespace calls.
- Test configuration in an environment with the same namespace layout as production.
- Monitor `coredns_dns_responses_total{rcode="NXDOMAIN"}` per name with a log sample, to spot new misses after deploys.

## Related

- [DNS timeouts and intermittent resolution failures](dns-timeouts.md)
- [Service has no endpoints](service-no-endpoints.md)

## Runbooks

- [DNS degraded](../runbooks/dns-degraded.md)

## Reproduce it locally

```sh
make kind-up
make lab LAB=dns-nxdomain
make lab-clean LAB=dns-nxdomain
```

The lab is [labs/dns-nxdomain.yaml](../../labs/dns-nxdomain.yaml).
