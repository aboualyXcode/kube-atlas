<!-- Generated from data/runbooks.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Runbook: DNS degraded

**Trigger:** `CoreDNSLatencyHigh` (p99 above 100 ms), `CoreDNSErrorsHigh` (SERVFAIL rate), or many services logging `i/o timeout` or `no such host` at once.

**Impact:** DNS sits under every connection. Degradation shows up as timeouts and 5-second latency spikes across unrelated services, often SEV1 in effect even when the cluster looks healthy.

[Open as a flowchart](../../index.html#/operations/runbooks/dns-degraded)

## Triage (5 minutes)

```sh
kubectl get deploy coredns -n kube-system
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
kubectl top pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=100 | grep -E "ERROR|timeout|SERVFAIL"
tools/dns-check.sh <affected-namespace>
```

| If you see | Then |
|---|---|
| one name fails with `NXDOMAIN`, others fine | wrong name or namespace: [dns-nxdomain](../failures/dns-nxdomain.md) |
| CoreDNS logs `i/o timeout` to the VPC resolver (`.2` address) | upstream drops: link-local allowance, VPC resolver limits: [dns-timeouts](../failures/dns-timeouts.md) |
| CoreDNS pods at their CPU limit or few replicas | CoreDNS saturated |
| CoreDNS pods not running or not ready | scheduling, node or configuration problem |
| failures only from pods in some namespaces | NetworkPolicy blocking UDP/TCP 53: [connection-timeouts](../failures/connection-timeouts.md) |

## Diagnose

**Allowance drops on CoreDNS nodes.** 

```sh
for n in $(kubectl get pods -n kube-system -l k8s-app=kube-dns -o jsonpath='{.items[*].spec.nodeName}'); do
  echo "$n"; kubectl debug node/"$n" -q -it --image=nicolaka/netshoot -- ethtool -S eth0 | grep allowance_exceeded
done
```

**Query volume and amplification.** compare `coredns_dns_requests_total` with last week; check `NXDOMAIN` share; inspect `resolv.conf` of the noisiest clients.

**Recent changes.** CoreDNS configuration (`kubectl get cm coredns coredns-custom -n kube-system -o yaml`), add-on version, NetworkPolicies, a new high-volume workload.

## Mitigate

Scale CoreDNS out and spread it: (On the managed add-on, prefer enabling its autoscaling configuration; manual scaling may be reverted.)

```sh
kubectl scale deploy coredns -n kube-system --replicas=6
```

If replicas share a node, delete one pod at a time so they reschedule elsewhere (check topology spread or anti-affinity first).

Remove or raise CPU limits on CoreDNS if throttled.

Restore a known-good Corefile if a configuration change preceded the incident.

## Resolve

Deploy NodeLocal DNSCache; set topology spread on CoreDNS; reduce amplification in the noisiest workloads (FQDNs with trailing dots, `ndots: 2`); fix NetworkPolicies to allow DNS.

## Verify

CoreDNS p99 below 50 ms, SERVFAIL near zero, allowance counters flat, client error rates back to baseline.

## Escalate

Page the platform lead if scaling CoreDNS does not help within 15 minutes, or if the VPC resolver itself appears degraded (AWS support case, include ENI IDs and timestamps).

## Follow up

Track DNS queries per pod per service; add the allowance counters to node monitoring if they are not exported yet.
