// Networking failures: paths, endpoints, admission calls
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the cluster and eks map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "connection-timeouts",
    title: "Connection timeouts between pods or to AWS services",
    kind: "symptom",
    layer: "networking",
    scope: "eks",
    summary: "Packets are silently dropped on the way: a security group, NACL, route or NetworkPolicy blocks the path, so the client waits until it times out.",
    propagation: {
      map: "eks",
      origins: [{ at: "security-groups", note: "Rule missing: packets dropped silently" }],
      path: [],
      symptom: { at: "application", note: "dial tcp ... i/o timeout" },
      branches: [{ from: "security-groups", at: "rds", note: "The target never sees the connection" }]
    },
    components: ["cni", "security-groups", "vpc", "application"],
    symptom: [
      "Requests hang and then fail with `i/o timeout`, `connection timed out` or `ETIMEDOUT`, not with",
      "`connection refused`. Often only some pods are affected (those on new nodes, in one AZ, or with their own",
      "security groups), and only some destinations."
    ],
    affected: [
      "Something on the path silently drops packets: a **NetworkPolicy** enforced by the **CNI**, a **security",
      "group** on the node, the pod's own ENI or the destination (RDS, ElastiCache), a network ACL, or a",
      "missing route in the **VPC**."
    ],
    rootCause: [
      "A **refusal** is an answer: the packet arrived and nothing listened. A **timeout** is silence: the packet",
      "or its reply was dropped. On EKS the droppers are:",
      "",
      "- **NetworkPolicy** (the VPC CNI enforces it with eBPF when enabled): a default-deny policy without an",
      "  allow rule, or an allow rule whose labels do not match. Egress policies that forget DNS (UDP and TCP",
      "  53 to CoreDNS) make every lookup time out first.",
      "- **Security groups for pods:** pods with their own branch ENI use their security group, not the node's,",
      "  so a database security group that allows the node security group does not allow those pods.",
      "- **Destination security groups:** RDS or ElastiCache allowing only the old node security group, so pods",
      "  on Karpenter nodes with a different security group cannot connect.",
      "- **NACLs and routes:** a subnet with a restrictive NACL (forgetting ephemeral return ports), or no route",
      "  to a peered VPC or Transit Gateway."
    ],
    investigation: [
      {
        title: "Establish who can and cannot connect",
        run: [
          "kubectl debug -it <pod> -n shop --image=nicolaka/netshoot --target=api -- nc -vz -w 3 10.20.71.33 5432",
          "kubectl get pods -n shop -l app=orders-api -o wide"
        ],
        lookFor: "Failures that follow nodes, node pools, AZs or pod security groups."
      },
      {
        title: "Check NetworkPolicies in source and destination namespaces",
        run: [
          "kubectl get networkpolicy -n shop",
          "kubectl get networkpolicy -n payments -o yaml"
        ],
        lookFor: "A default deny without a matching allow, missing DNS egress, mismatched labels or namespaceSelectors."
      },
      {
        title: "Check the security groups actually in play",
        run: [
          "kubectl get securitygrouppolicies -A",
          "aws ec2 describe-instances --instance-ids <node-instance-id> --query 'Reservations[].Instances[].SecurityGroups'",
          "aws ec2 describe-security-groups --group-ids <db-sg> --query 'SecurityGroups[].IpPermissions'"
        ],
        lookFor: "A destination rule referencing a security group the failing pods do not carry."
      },
      {
        title: "Let AWS tell you where packets drop",
        run: [
          "aws ec2 create-network-insights-path --source <pod-or-node-eni> --destination <db-eni> --protocol tcp --destination-port 5432",
          "# then start-network-insights-analysis; or query VPC Flow Logs for action = REJECT"
        ],
        lookFor: "The component Reachability Analyzer names as blocking, or `REJECT` records in flow logs."
      }
    ],
    resolution: [
      "Add the missing allow: a NetworkPolicy rule (including DNS egress), a security group rule referencing",
      "the security group the pods actually use (for example the cluster or Karpenter node security group, or",
      "the pod security group), a NACL rule for ephemeral ports, or a route. Prefer rules that reference",
      "security groups over CIDRs so new nodes inherit access."
    ],
    prevention: [
      "Give every node pool the same baseline security groups, and grant databases access by security group, not by subnet.",
      "Test NetworkPolicies in CI with a connectivity matrix, and always include DNS egress in default-deny templates.",
      "Enable VPC Flow Logs for cluster subnets so rejects can be queried during incidents."
    ],
    signals: [
      [3, "connect: connection timed out"],
      [3, "dial tcp [0-9.]+:\\d+: i/o timeout"],
      [2, "Connection timed out|ETIMEDOUT"]
    ],
    samples: [
      "dial tcp 10.20.71.33:5432: connect: connection timed out",
      "orders-api: failed to connect to payments-api.payments.svc: dial tcp 172.20.14.9:8080: i/o timeout"
    ],
    related: ["readiness-probe-failing", "dns-timeouts", "service-no-endpoints", "webhook-unavailable"],
    lab: "connection-timeouts",
    runbook: null
  },
  {
    id: "pod-ip-exhaustion",
    title: "Pod IP exhaustion (failed to assign an IP address to container)",
    kind: "cause",
    layer: "networking",
    scope: "eks",
    summary: "The subnet has no free addresses (or no contiguous /28 prefixes), so the VPC CNI cannot give new pods an IP.",
    propagation: {
      map: "eks",
      origins: [{ at: "vpc", note: "Subnet out of free addresses, or fragmented" }],
      path: [
        { at: "ec2", note: "IP or prefix assignment fails" },
        { at: "cni", note: "ipamd has no address to hand out" },
        { at: "kubelet", note: "FailedCreatePodSandBox" }
      ],
      symptom: { at: "application", note: "Pods stuck in ContainerCreating" },
      branches: [
        {
          from: "vpc",
          at: "karpenter",
          note: "Node launches fail: InsufficientFreeAddressesInSubnet"
        }
      ]
    },
    components: ["cni", "vpc", "ec2", "karpenter"],
    symptom: [
      "Pods are scheduled but stay in `ContainerCreating` with `FailedCreatePodSandBox` and `failed to assign",
      "an IP address to container`. Karpenter may fail to launch nodes with `InsufficientFreeAddressesInSubnet`.",
      "It often starts during a scale-out or deploy and affects one AZ first."
    ],
    affected: [
      "The **VPC CNI** (`ipamd` on each node) cannot obtain another IP or prefix from the **subnet**, or the",
      "node has used all the ENI slots its **instance type** allows."
    ],
    rootCause: [
      "With the VPC CNI every pod gets a real VPC address from the node's subnet. `ipamd` keeps a warm pool of",
      "addresses on attached ENIs. Two different limits run out:",
      "",
      "- **The subnet:** a `/24` has 251 usable addresses. Nodes, pods, warm pools (by default a whole spare",
      "  ENI's worth per node), load balancers and endpoints all draw on it. With prefix delegation, each",
      "  allocation is a contiguous `/28`, so a fragmented subnet can fail (`InsufficientCidrBlocks`) while",
      "  still showing free addresses.",
      "- **The instance:** each instance type has a maximum number of ENIs and addresses per ENI. When the",
      "  node is full, the CNI cannot add more, and pods beyond that fail (normally the scheduler prevents",
      "  this through `max-pods`, unless `max-pods` was set higher than the ENI capacity)."
    ],
    investigation: [
      {
        title: "Confirm the sandbox error on the pod",
        run: "kubectl describe pod <pod> -n shop | sed -n '/Events/,$p'",
        lookFor: "`failed to assign an IP address to container`."
      },
      {
        title: "Check free addresses in the cluster subnets",
        run: [
          "aws ec2 describe-subnets --filters Name=tag:karpenter.sh/discovery,Values=larder-prod \\",
          "  --query 'Subnets[].[SubnetId,AvailabilityZone,CidrBlock,AvailableIpAddressCount]' --output table"
        ],
        lookFor: "Subnets with tens of addresses left, often one AZ lower than the others."
      },
      {
        title: "Read ipamd's view on the node",
        run: [
          "kubectl logs -n kube-system <aws-node-pod-on-node> -c aws-node | grep -i -E \"insufficient|cidr|no available\"",
          "kubectl get ds aws-node -n kube-system -o jsonpath='{.spec.template.spec.containers[0].env}' | jq '.[] | select(.name|test(\"WARM|MINIMUM|PREFIX|CUSTOM\"))'"
        ],
        lookFor: "Subnet exhaustion versus ENI limits, and warm pool settings that hoard addresses."
      }
    ],
    resolution: [
      "Short term: reduce hoarding by setting `WARM_IP_TARGET` and `MINIMUM_IP_TARGET` instead of the default",
      "warm ENI, and spread new capacity to subnets that still have room.",
      "",
      "Durable fixes:",
      "",
      "- add a secondary VPC CIDR (for example from `100.64.0.0/16`) and use VPC CNI custom networking so pods",
      "  draw from large dedicated subnets;",
      "- enable prefix delegation for density, with subnet CIDR reservations to keep `/28` blocks contiguous;",
      "- move to IPv6 for clusters where that is an option."
    ],
    prevention: [
      "Size pod subnets for peak pods plus warm pools plus surge, per AZ (a `/19` per AZ is a common starting point).",
      "Alert when any cluster subnet falls below 20% free addresses.",
      "Include IP capacity in capacity reviews alongside CPU and memory."
    ],
    signals: [
      [5, "failed to assign an IP address to container"],
      [5, "InsufficientFreeAddressesInSubnet"],
      [4, "InsufficientCidrBlocks"],
      [2, "plugin type=\"aws-cni\""],
      [1, "FailedCreatePodSandBox"]
    ],
    samples: [
      "Warning  FailedCreatePodSandBox  41s  kubelet  Failed to create pod sandbox: rpc error: code = Unknown desc = failed to setup network for sandbox \"4f2a9c\": plugin type=\"aws-cni\" name=\"aws-cni\" failed (add): add cmd: failed to assign an IP address to container",
      "InsufficientFreeAddressesInSubnet: The specified subnet does not have enough free addresses to satisfy the request.",
      "InsufficientCidrBlocks: There are not enough free cidr blocks in the specified subnet to satisfy the request."
    ],
    related: ["pending-insufficient-resources", "cni-not-ready", "karpenter-not-provisioning"],
    lab: null,
    runbook: "pod-ip-exhaustion"
  },
  {
    id: "service-no-endpoints",
    title: "Service has no endpoints",
    kind: "symptom",
    layer: "networking",
    scope: "any",
    summary: "The Service selects no ready pods, so there is nowhere to send its traffic.",
    propagation: {
      map: "cluster",
      origins: [
        { at: "workload-controllers", note: "Selector does not match pod labels" },
        { at: "application", note: "Pods exist but none are Ready" }
      ],
      path: [
        { at: "kube-controller-manager", note: "EndpointSlice controller finds no ready match" },
        { at: "service", note: "Endpoints: <none>" },
        { at: "kube-proxy", note: "No backend to forward to" }
      ],
      symptom: { at: "users", note: "503 from the load balancer, connection refused inside" }
    },
    components: ["kube-controller-manager", "kube-proxy", "workload-controllers"],
    symptom: [
      "Calls to the Service fail with `connection refused` (from kube-proxy's reject rule) or time out; an",
      "ingress returns 503; `kubectl describe svc` shows `Endpoints: <none>`. The pods themselves may be",
      "perfectly healthy."
    ],
    affected: [
      "The **EndpointSlice controller** builds the Service's endpoints from pods that match its selector and are",
      "Ready; **kube-proxy** programs only those. The cause is a mismatch between the **Service** and the",
      "**pods**, or pods that are not Ready."
    ],
    rootCause: [
      "A Service is a selector plus ports. It has endpoints only if pods exist that:",
      "",
      "1. carry **every** label in the selector (a Service selecting `tier: backend` excludes pods without it);",
      "2. are in the **same namespace**;",
      "3. are **Ready** (unready pods are listed as not ready and get no traffic);",
      "4. expose the **targetPort**: a named targetPort must match a `containerPort` name in the pod.",
      "",
      "A rename of labels in the Deployment, or a selector copied from another service, is the usual cause."
    ],
    investigation: [
      {
        title: "Compare the Service selector with pod labels",
        run: [
          "kubectl get svc orders-api -n shop -o jsonpath='{.spec.selector}'; echo",
          "kubectl get pods -n shop --show-labels | grep orders-api",
          "kubectl get pods -n shop -l app=orders-api,tier=backend"
        ],
        lookFor: "An empty result for the full selector while pods exist with a subset of the labels."
      },
      {
        title: "Check readiness and ports in the EndpointSlices",
        run: [
          "kubectl get endpointslices -n shop -l kubernetes.io/service-name=orders-api -o yaml | grep -E \"ready:|port:|name:\"",
          "kubectl get pods -n shop -l app=orders-api -o jsonpath='{.items[0].spec.containers[0].ports}'"
        ],
        lookFor: "`ready: false` endpoints (see readiness-probe-failing), or a targetPort name absent from the pod."
      }
    ],
    resolution: [
      "Make the selector match the pod template's labels (selectors on Deployments are immutable, so change the",
      "Service), correct the targetPort, or fix readiness. Endpoints appear within seconds once pods match."
    ],
    prevention: [
      "Generate Services and Deployments from one template so selectors and labels cannot drift.",
      "Alert on Services with zero ready endpoints (`kube_endpoint_address{ready=\"true\"}` absent, or blackbox probes through the Service)."
    ],
    signals: [
      [5, "Endpoints:\\s*<none>"],
      [4, "no endpoints available for service"],
      [2, "connection refused"]
    ],
    samples: [
      [
        "Name:              orders-api",
        "Namespace:         shop",
        "Selector:          app=orders-api,tier=backend",
        "Type:              ClusterIP",
        "IP:                172.20.118.40",
        "Port:              http  80/TCP",
        "TargetPort:        http/TCP",
        "Endpoints:         <none>"
      ]
    ],
    related: ["readiness-probe-failing", "alb-targets-unhealthy", "dns-nxdomain"],
    lab: "service-no-endpoints",
    runbook: "load-balancer-5xx"
  },
  {
    id: "webhook-unavailable",
    title: "failed calling webhook (admission webhook unavailable)",
    kind: "cause",
    layer: "networking",
    scope: "any",
    summary: "The API server calls a webhook for every matching request; when the webhook cannot answer, those requests fail.",
    propagation: {
      map: "cluster",
      origins: [
        {
          at: "admission-webhooks",
          note: "Webhook down: no endpoints, expired cert, blocked port"
        }
      ],
      path: [{ at: "kube-apiserver", note: "Call fails or times out (failurePolicy: Fail)" }],
      symptom: { at: "client", note: "failed calling webhook: deploys fail" },
      branches: [
        {
          from: "kube-apiserver",
          at: "kube-controller-manager",
          note: "ReplicaSets and HPA cannot create pods either"
        }
      ]
    },
    components: [
      "admission-webhooks",
      "kube-apiserver",
      "security-groups",
      "aws-load-balancer-controller",
      "cert-manager"
    ],
    symptom: [
      "Creating or updating unrelated objects fails with `Internal error occurred: failed calling webhook`.",
      "Deploys break across many teams at once; ReplicaSets cannot create pods (`FailedCreate`); controllers",
      "log errors. Reads keep working."
    ],
    affected: [
      "The **API server** calls an **admission webhook** for every matching request. With `failurePolicy:",
      "Fail`, when the webhook backend is down or unreachable, the API server rejects the request. The webhook",
      "belongs to an add-on such as the **AWS Load Balancer Controller**, cert-manager or a policy engine."
    ],
    rootCause: [
      "Admission webhooks run in your cluster but sit in the control plane's request path. The request fails",
      "when:",
      "",
      "- **the webhook pods are not running or not ready:** `no endpoints available for service` (scaled to",
      "  zero, crash looping, evicted, or scheduled on nodes that do not exist yet; a classic chicken-and-egg",
      "  during cluster bootstrap);",
      "- **the API server cannot reach them:** `context deadline exceeded`. On EKS the control plane reaches",
      "  webhooks through ENIs in your VPC, governed by the **cluster security group**; a webhook listening on a",
      "  port other than 443 needs an inbound rule for that port on the nodes;",
      "- **TLS fails:** the `caBundle` does not match the serving certificate (expired, rotated by cert-manager",
      "  without injection), seen as `x509` errors;",
      "- the webhook matches far more than it needs (all namespaces including `kube-system`, all resources)."
    ],
    investigation: [
      {
        title: "Identify the webhook from the error",
        run: [
          "kubectl get mutatingwebhookconfigurations,validatingwebhookconfigurations",
          "kubectl get validatingwebhookconfiguration <name> -o jsonpath='{range .webhooks[*]}{.name}{\"\\t\"}{.failurePolicy}{\"\\t\"}{.clientConfig.service.namespace}/{.clientConfig.service.name}:{.clientConfig.service.port}{\"\\n\"}{end}'"
        ],
        lookFor: "The service behind the failing webhook name, its port, and `failurePolicy`."
      },
      {
        title: "Check the backend pods and endpoints",
        run: [
          "kubectl get endpointslices -n kube-system -l kubernetes.io/service-name=aws-load-balancer-webhook-service",
          "kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller -o wide"
        ],
        lookFor: "No ready endpoints, crash loops, Pending pods."
      },
      {
        title: "For timeouts on EKS, check the security group path",
        run: [
          "aws eks describe-cluster --name larder-prod --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId'",
          "aws ec2 describe-security-groups --group-ids <node-sg> --query 'SecurityGroups[].IpPermissions'"
        ],
        lookFor: "No inbound rule from the cluster security group to the webhook's target port (for example 9443) on the nodes."
      },
      {
        title: "Check the API server's view in the audit or API logs",
        run: [
          "aws logs filter-log-events --log-group-name /aws/eks/larder-prod/cluster \\",
          "  --filter-pattern '\"failed calling webhook\"' --max-items 20"
        ],
        lookFor: "Which webhook, how often, and since when."
      }
    ],
    resolution: [
      "Restore the webhook backend: scale it up, fix its crash, give it capacity, or open the security group",
      "port. If it cannot be restored quickly and the webhook is not security-critical, unblock the cluster by",
      "setting `failurePolicy: Ignore` or deleting the webhook configuration temporarily, and restore it after.",
      "Note what admission you skip meanwhile."
    ],
    prevention: [
      "Run webhook backends with at least two replicas, a PDB, a PriorityClass and topology spread.",
      "Scope webhooks with `namespaceSelector` and `objectSelector`; exclude `kube-system` and the webhook's own namespace.",
      "Keep `timeoutSeconds` short (2 to 5 seconds) so a slow webhook does not stall the API server.",
      "Alert on `apiserver_admission_webhook_admission_duration_seconds` p99 and on webhook rejection rates."
    ],
    signals: [
      [5, "failed calling webhook"],
      [3, "failed to call webhook"],
      [2, "no endpoints available for service"],
      [1, "context deadline exceeded"]
    ],
    samples: [
      "Error from server (InternalError): error when creating \"orders-api.yaml\": Internal error occurred: failed calling webhook \"mservice.elbv2.k8s.aws\": failed to call webhook: Post \"https://aws-load-balancer-webhook-service.kube-system.svc:443/mutate-v1-service?timeout=10s\": no endpoints available for service \"aws-load-balancer-webhook-service\"",
      "Internal error occurred: failed calling webhook \"validate.kyverno.svc-fail\": failed to call webhook: Post \"https://kyverno-svc.kyverno.svc:443/validate/fail?timeout=10s\": context deadline exceeded"
    ],
    related: [
      "x509-certificate-errors",
      "resource-quota-exceeded",
      "rollout-stuck",
      "connection-timeouts",
      "api-throttling"
    ],
    lab: null,
    runbook: "api-server-degraded"
  }
]);
