// DNS failures
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the cluster and eks map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "dns-nxdomain",
    title: "DNS — no such host (NXDOMAIN)",
    kind: "cause",
    layer: "dns",
    scope: "any",
    summary: "The name does not exist as written: a typo, the wrong namespace, or a short name expanded in the wrong search domain.",
    propagation: {
      map: "cluster",
      origins: [{ at: "application", note: "Looks up a name that does not exist as written" }],
      path: [{ at: "coredns", note: "Answers NXDOMAIN" }],
      symptom: { at: "application", note: "no such host: startup crash or failed calls" }
    },
    components: ["coredns", "application", "workload-controllers"],
    symptom: [
      "An application fails to reach a dependency with `no such host`, `NXDOMAIN` or `ENOTFOUND`, immediately",
      "rather than after a timeout. Usually it is one name in one namespace; other lookups work."
    ],
    affected: [
      "**CoreDNS** answered authoritatively that the name does not exist. The cause is almost always the",
      "**name** the application uses, or the Service it expects not existing."
    ],
    rootCause: [
      "Kubernetes DNS names are scoped: `payments-api` resolves only from pods in the `payments` namespace,",
      "because the resolver appends the pod's own namespace first (`<name>.<pod-namespace>.svc.cluster.local`).",
      "From another namespace you need `payments-api.payments` or the full name. Other causes:",
      "",
      "- the Service does not exist, is in another namespace, or was renamed;",
      "- a headless Service with no ready pods has no records;",
      "- an ExternalName or a private Route 53 zone the VPC is not associated with;",
      "- a custom CoreDNS configuration (`coredns-custom` or a modified Corefile) that rewrites or stubs the",
      "  domain incorrectly."
    ],
    investigation: [
      {
        title: "Reproduce from a pod in the same namespace",
        run: [
          "kubectl run dnsprobe -n shop --rm -it --restart=Never --image=busybox:1.36 -- \\",
          "  sh -c 'cat /etc/resolv.conf; nslookup payments-api; nslookup payments-api.payments.svc.cluster.local'"
        ],
        lookFor: "The short name failing and the namespaced name working."
      },
      {
        title: "Check the Service exists where you think",
        run: "kubectl get svc -A --field-selector metadata.name=payments-api",
        lookFor: "The Service in a different namespace, or not at all."
      },
      {
        title: "For external names, test the VPC resolver",
        run: [
          "kubectl run dnsprobe -n shop --rm -it --restart=Never --image=busybox:1.36 -- nslookup orders-db.internal.larder.example",
          "aws route53 list-hosted-zones-by-vpc --vpc-id <vpc-id> --vpc-region eu-west-1"
        ],
        lookFor: "A private zone not associated with the cluster VPC."
      }
    ],
    resolution: [
      "Use the namespaced name (`payments-api.payments.svc.cluster.local`, or at least `payments-api.payments`)",
      "in configuration, create or fix the Service, or associate the private hosted zone with the VPC."
    ],
    prevention: [
      "Put fully qualified service names in configuration for cross-namespace calls.",
      "Test configuration in an environment with the same namespace layout as production.",
      "Monitor `coredns_dns_responses_total{rcode=\"NXDOMAIN\"}` per name with a log sample, to spot new misses after deploys."
    ],
    signals: [
      [5, "no such host"],
      [4, "NXDOMAIN"],
      [4, "getaddrinfo ENOTFOUND"],
      [3, "Name or service not known|Temporary failure in name resolution"],
      [1, "lookup \\S+ on [0-9.]+:53"]
    ],
    samples: [
      "dial tcp: lookup orders-db.shop.svc.cluster.local on 172.20.0.10:53: no such host",
      "Error: getaddrinfo ENOTFOUND payments-api",
      "** server can't find payments-api.shop.svc.cluster.local: NXDOMAIN"
    ],
    related: ["dns-timeouts", "service-no-endpoints"],
    lab: "dns-nxdomain",
    runbook: "dns-degraded"
  },
  {
    id: "dns-timeouts",
    title: "DNS timeouts and intermittent resolution failures",
    kind: "cause",
    layer: "dns",
    scope: "eks",
    summary: "DNS queries are dropped or slow: CoreDNS is overloaded, ndots:5 multiplies queries, or a node exceeds its per-ENI packet limit to the VPC resolver.",
    propagation: {
      map: "eks",
      origins: [{ at: "application", note: "ndots:5 turns one lookup into up to ten queries" }],
      path: [
        { at: "coredns", note: "Overloaded, or both replicas on one node" },
        { at: "vpc-dns", note: "Per-ENI packet limit drops queries" }
      ],
      symptom: { at: "application", note: "5 s stalls, intermittent no such host" }
    },
    components: ["coredns", "ec2", "kube-proxy", "cni", "application"],
    symptom: [
      "Requests are intermittently slow by about five seconds, or fail with DNS `i/o timeout` and `SERVFAIL`.",
      "Failures cluster at traffic peaks, affect many services at once, and look random from any single pod."
    ],
    affected: [
      "The path from the pod through **CoreDNS** to the **VPC resolver**: CoreDNS capacity, the",
      "**EC2 network allowances** on CoreDNS nodes, conntrack on nodes (**kube-proxy**), and the",
      "**application**'s query volume."
    ],
    rootCause: [
      "Several mechanisms produce the same symptom:",
      "",
      "- **Query amplification (`ndots: 5`):** pods resolve any name with fewer than five dots by trying each",
      "  search domain first. A lookup of `api.stripe.com` becomes up to five lookups, each for A and AAAA,",
      "  most of them `NXDOMAIN`. Traffic to CoreDNS and the VPC resolver grows several-fold.",
      "- **The VPC resolver's per-ENI limit:** each ENI may send 1024 packets per second to link-local",
      "  services, including the Amazon DNS resolver. CoreDNS pods on one node share that node's ENIs; beyond",
      "  the limit, packets are dropped. The counter `linklocal_allowance_exceeded` in `ethtool -S` on the",
      "  node proves it.",
      "- **Too few CoreDNS replicas** for the cluster's size and query rate, or CoreDNS throttled by its CPU",
      "  limit.",
      "- **conntrack races on UDP:** parallel A and AAAA queries from the same socket can collide in the",
      "  kernel's NAT table and one is dropped, which costs a five-second resolver retry."
    ],
    investigation: [
      {
        title: "Check CoreDNS health, errors and latency",
        run: [
          "kubectl get deploy coredns -n kube-system; kubectl top pods -n kube-system -l k8s-app=kube-dns",
          "kubectl logs -n kube-system -l k8s-app=kube-dns --tail=200 | grep -E \"ERROR|timeout\"",
          "# PromQL: histogram_quantile(0.99, sum by (le) (rate(coredns_dns_request_duration_seconds_bucket[5m])))"
        ],
        lookFor: "Upstream timeouts in CoreDNS logs (the VPC resolver side) versus CoreDNS itself saturated or throttled."
      },
      {
        title: "Check the link-local allowance on CoreDNS nodes",
        run: [
          "kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide",
          "kubectl debug node/<coredns-node> -it --image=nicolaka/netshoot -- ethtool -S eth0 | grep -E \"allowance_exceeded\""
        ],
        lookFor: "A non-zero and growing `linklocal_allowance_exceeded`."
      },
      {
        title: "Measure amplification",
        run: [
          "kubectl exec deploy/orders-api -n shop -- cat /etc/resolv.conf",
          "# PromQL: sum by (rcode) (rate(coredns_dns_responses_total[5m]))"
        ],
        lookFor: "`ndots:5`, and NXDOMAIN rates several times higher than NOERROR."
      }
    ],
    resolution: [
      "- Scale CoreDNS (enable the EKS add-on's autoscaling, or more replicas) and spread replicas across nodes.",
      "- Deploy NodeLocal DNSCache so each node caches answers and CoreDNS traffic drops sharply; it also uses",
      "  TCP upstream, which avoids the conntrack race.",
      "- Cut amplification: use fully qualified names with a trailing dot for external hosts, or set",
      "  `dnsConfig.options: [{name: ndots, value: \"2\"}]` on workloads that call external APIs.",
      "- Remove CPU limits from CoreDNS, or raise them well above the request."
    ],
    prevention: [
      "Alert on CoreDNS p99 latency above 100 ms and on SERVFAIL rate; export `ethtool` allowance counters from nodes.",
      "Size CoreDNS with the cluster (autoscaling), keep replicas spread with topology constraints, and protect it with a PDB.",
      "Make NodeLocal DNSCache part of the cluster baseline for large clusters."
    ],
    signals: [
      [5, ":53: (read udp \\S+: )?i/o timeout"],
      [4, "connection timed out; no servers could be reached"],
      [4, "linklocal_allowance_exceeded"],
      [3, "plugin/errors: .* i/o timeout"],
      [2, "SERVFAIL"]
    ],
    samples: [
      "lookup api.stripe.com on 172.20.0.10:53: read udp 10.20.33.17:41245->172.20.0.10:53: i/o timeout",
      "[ERROR] plugin/errors: 2 api.stripe.com. AAAA: read udp 10.20.40.12:51234->10.20.0.2:53: i/o timeout",
      ";; connection timed out; no servers could be reached",
      "linklocal_allowance_exceeded: 18234"
    ],
    related: ["dns-nxdomain", "connection-timeouts", "cpu-throttling"],
    lab: null,
    runbook: "dns-degraded"
  }
]);
