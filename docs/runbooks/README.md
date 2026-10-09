<!-- Generated from data/runbooks.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Runbooks

What to do when an alert fires. The atlas draws each one as a flowchart.

- [Pods pending, capacity not arriving](pending-pods-capacity.md): `KubePodsPendingTooLong` (pods `Pending` for 10 minutes), a stuck rollout, or HPA at max with pending replicas.
- [Node NotReady](node-not-ready.md): `KubeNodeNotReady` (a node not Ready for 5 minutes), `KubeNodePressure`, or several nodes `NotReady` at once.
- [Load balancer 5xx](load-balancer-5xx.md): `ALBTarget5xxHigh`, `ALBUnhealthyTargets`, `ServiceWithoutEndpoints`, or an SLO burn alert for a service behind an ALB or NLB.
- [DNS degraded](dns-degraded.md): `CoreDNSLatencyHigh` (p99 above 100 ms), `CoreDNSErrorsHigh` (SERVFAIL rate), or many services logging `i/o timeout` or `no such host` at once.
- [API server degraded](api-server-degraded.md): `KubeAPIErrorsHigh`, `KubeAPILatencyHigh`, `KubeAPIPriorityAndFairnessRejecting`, `AdmissionWebhookSlow`, `AggregatedAPIUnavailable`, or many teams reporting failing `kubectl` and deploys.
- [Pod IP exhaustion](pod-ip-exhaustion.md): `SubnetFreeAddressesLow` (a cluster subnet below 10% free), `FailedCreatePodSandBox` with `failed to assign an IP address to container`, or Karpenter `InsufficientFreeAddressesInSubnet`.
- [Certificate expiry](certificate-expiry.md): `CertificateExpiringSoon` (under 21 days: ticket; under 7 days: page), `CertificateNotReady`, or `x509` errors appearing at a precise time.
- [EKS cluster upgrade](cluster-upgrade.md): planned work, roughly every four months, at least 60 days before the current version leaves standard support.
