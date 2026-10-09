// Autoscaling failures: pods, nodes and drains
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the cluster and eks map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "cluster-autoscaler-no-scale-up",
    title: "Cluster Autoscaler does not scale up",
    kind: "symptom",
    layer: "autoscaling",
    scope: "eks",
    summary: "Pods are Pending but Cluster Autoscaler grows no node group: maximum size, node templates that do not fit, or IAM.",
    propagation: {
      map: "eks",
      origins: [
        { at: "ec2", note: "Group at max size, or capacity unavailable" },
        { at: "iam", note: "CA role cannot change desired capacity" }
      ],
      path: [{ at: "cluster-autoscaler", note: "NotTriggerScaleUp: no group fits" }],
      symptom: { at: "application", note: "Pods stay Pending" }
    },
    components: ["cluster-autoscaler", "ec2", "iam"],
    symptom: [
      "Pods stay `Pending` with `Insufficient` resources, and no nodes are added. The pod's events show",
      "`NotTriggerScaleUp` from `cluster-autoscaler`, or nothing from it at all."
    ],
    affected: [
      "**Cluster Autoscaler** simulates scheduling against node group templates and resizes **EC2 Auto Scaling",
      "groups**. It needs to discover the groups, believe a new node would fit the pod, be allowed to grow",
      "them, and have EC2 capacity."
    ],
    rootCause: [
      "Cluster Autoscaler only scales node groups it knows, and only if a node from that group would make the",
      "pod schedulable:",
      "",
      "- **Discovery:** ASGs lack the tags `k8s.io/cluster-autoscaler/enabled` and",
      "  `k8s.io/cluster-autoscaler/<cluster>`, or the autoscaler's `--node-group-auto-discovery` names another",
      "  cluster.",
      "- **Fit:** the template node lacks the labels, taints tolerations or zone the pod needs. A group scaled",
      "  to zero has no real node to copy from, so labels and taints must be declared as ASG tags",
      "  (`k8s.io/cluster-autoscaler/node-template/label/...`).",
      "- **Limits:** `max node group size reached`.",
      "- **Permissions and capacity:** IAM denies `autoscaling:SetDesiredCapacity`, or EC2 cannot launch",
      "  (insufficient capacity for the instance type, vCPU quota). The ASG's activity history shows it.",
      "- **Not running:** the autoscaler itself is crash looping or on a node that disappeared."
    ],
    investigation: [
      {
        title: "Read the autoscaler's events on the pod",
        run: "kubectl get events -n shop --field-selector involvedObject.name=<pod> | grep -i scale",
        lookFor: "The per-group reasons after `pod didn't trigger scale-up`."
      },
      {
        title: "Read its status and logs",
        run: [
          "kubectl get configmap cluster-autoscaler-status -n kube-system -o jsonpath='{.data.status}'",
          "kubectl logs -n kube-system deploy/cluster-autoscaler --tail=200 | grep -i -E \"scale|error|failed\""
        ],
        lookFor: "Discovered groups and their health, backoff after failed scale-ups, IAM errors."
      },
      {
        title: "Check the Auto Scaling group from AWS",
        run: [
          "aws autoscaling describe-auto-scaling-groups --filters Name=tag-key,Values=k8s.io/cluster-autoscaler/larder-prod \\",
          "  --query 'AutoScalingGroups[].[AutoScalingGroupName,MinSize,MaxSize,DesiredCapacity]' --output table",
          "aws autoscaling describe-scaling-activities --auto-scaling-group-name <asg> --max-items 5"
        ],
        lookFor: "Groups at max, missing groups, or `InsufficientInstanceCapacity` and quota failures."
      }
    ],
    resolution: [
      "Tag the groups for discovery, add node-template tags for labels and taints on groups that scale from",
      "zero, raise maximum sizes, fix IAM, or diversify instance types (mixed instances policy) to escape",
      "capacity shortages. Use one node group per AZ for zonal workloads with `--balance-similar-node-groups`."
    ],
    prevention: [
      "Alert on pods Pending for more than 10 minutes and on `cluster_autoscaler_unschedulable_pods_count`.",
      "Keep node groups' maximums with headroom and review them in capacity planning.",
      "Use several instance types per group so one type's capacity shortage does not block scaling."
    ],
    signals: [
      [5, "pod didn't trigger scale-up"],
      [4, "NotTriggerScaleUp"],
      [3, "max node group size reached"],
      [2, "cluster-autoscaler"]
    ],
    samples: [
      "Normal  NotTriggerScaleUp  30s (x40 over 7m)  cluster-autoscaler  pod didn't trigger scale-up: 2 node(s) didn't match Pod's node affinity/selector, 1 max node group size reached"
    ],
    related: [
      "pending-insufficient-resources",
      "karpenter-not-provisioning",
      "volume-node-affinity-conflict"
    ],
    lab: null,
    runbook: "pending-pods-capacity"
  },
  {
    id: "drain-blocked-by-pdb",
    title: "Node drain blocked by a PodDisruptionBudget",
    kind: "cause",
    layer: "autoscaling",
    scope: "any",
    summary: "A PodDisruptionBudget allows zero disruptions, so drains for upgrades and consolidation wait forever.",
    propagation: {
      map: "cluster",
      origins: [{ at: "workload-controllers", note: "PDB allows zero disruptions" }],
      path: [
        { at: "kube-apiserver", note: "Eviction API answers 429: would violate the PDB" },
        { at: "node-autoscaler", note: "Cannot drain the node" }
      ],
      symptom: { at: "client", note: "kubectl drain loops on 'Cannot evict pod'" }
    },
    components: ["workload-controllers", "kube-apiserver", "karpenter", "cluster-autoscaler"],
    symptom: [
      "`kubectl drain` loops on `Cannot evict pod as it would violate the pod's disruption budget`. A managed",
      "node group upgrade fails with `PodEvictionFailure`; Karpenter nodes past their expiry linger;",
      "consolidation never removes an idle node."
    ],
    affected: [
      "The **Eviction API** in the API server enforces **PodDisruptionBudgets**. Drains by humans, **managed",
      "node groups**, **Karpenter** and **Cluster Autoscaler** all go through it."
    ],
    rootCause: [
      "A PDB says how many pods matching a selector may be voluntarily disrupted at once. Eviction is refused",
      "when it would break that promise. Drains get stuck permanently when the promise can never be kept:",
      "",
      "- `minAvailable` equal to the replica count (or `maxUnavailable: 0`): nothing may ever be evicted;",
      "- a single-replica Deployment with `minAvailable: 1`;",
      "- pods already unhealthy, so `currentHealthy` is at the minimum and no eviction is allowed (unless",
      "  `unhealthyPodEvictionPolicy: AlwaysAllow` is set);",
      "- the replacement pod cannot schedule (no capacity), so the budget never recovers."
    ],
    investigation: [
      {
        title: "Find the PDBs that allow no disruptions",
        run: [
          "kubectl get pdb -A",
          "kubectl get pdb -A -o jsonpath='{range .items[?(@.status.disruptionsAllowed==0)]}{.metadata.namespace}/{.metadata.name}{\"\\n\"}{end}'"
        ],
        lookFor: "`ALLOWED DISRUPTIONS 0`, and why: replicas equal to `minAvailable`, or unhealthy pods."
      },
      {
        title: "Check the pods behind the budget",
        run: [
          "kubectl describe pdb orders-api -n shop",
          "kubectl get pods -n shop -l app=orders-api -o wide"
        ],
        lookFor: "Unready pods, or replacements Pending elsewhere."
      },
      {
        title: "For EKS managed node groups, read the update status",
        run: [
          "aws eks list-updates --cluster-name larder-prod --nodegroup-name system",
          "aws eks describe-update --cluster-name larder-prod --nodegroup-name system --update-id <id>"
        ],
        lookFor: "`PodEvictionFailure` and the pods named."
      }
    ],
    resolution: [
      "Make the budget satisfiable: use `maxUnavailable: 1` (or a percentage), run at least two replicas for",
      "anything with a PDB, and set `unhealthyPodEvictionPolicy: AlwaysAllow` so broken pods do not block",
      "maintenance. Ensure replacements can schedule before draining. Force (`--disable-eviction`, or the",
      "managed node group `--force` update) only with the owner's agreement: it bypasses the protection."
    ],
    prevention: [
      "Lint PDBs in CI: reject budgets that allow zero disruptions at the declared replica count.",
      "Alert on PDBs with `disruptionsAllowed == 0` for more than an hour.",
      "Run maintenance in windows with capacity headroom."
    ],
    signals: [
      [5, "would violate the pod's disruption budget"],
      [4, "PodEvictionFailure"],
      [3, "Cannot evict pod"],
      [2, "disruption budget"]
    ],
    samples: [
      "error when evicting pods/\"orders-api-7d9f8c6b5-abcde\" -n \"shop\" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.",
      "PodEvictionFailure: Reached max retries while trying to evict pods from nodes in node group system"
    ],
    related: ["pending-insufficient-resources", "pod-stuck-terminating", "karpenter-not-provisioning"],
    lab: "drain-blocked-by-pdb",
    runbook: "cluster-upgrade"
  },
  {
    id: "hpa-unknown-metrics",
    title: "HPA shows <unknown> and does not scale",
    kind: "cause",
    layer: "autoscaling",
    scope: "any",
    summary: "The HPA cannot read metrics, because metrics-server is missing or unreachable or the pods have no requests, so it cannot scale.",
    propagation: {
      map: "cluster",
      origins: [
        { at: "metrics-server", note: "Missing, not ready, or unreachable" },
        { at: "workload-controllers", note: "Pods have no CPU requests" }
      ],
      path: [{ at: "kube-controller-manager", note: "HPA controller gets no metrics" }],
      symptom: { at: "client", note: "kubectl get hpa shows <unknown>, replicas flat" }
    },
    components: ["metrics-server", "kube-controller-manager", "workload-controllers", "admission-webhooks"],
    symptom: [
      "`kubectl get hpa` shows `<unknown>` as the current value; the Deployment stays at its current replica",
      "count during load. Events on the HPA show `FailedGetResourceMetric` or `FailedComputeMetricsReplicas`."
    ],
    affected: [
      "The **HPA controller** (in the controller manager) reads the resource metrics API served by",
      "**metrics-server**, or custom and external metrics from an adapter. The cause is the metrics pipeline,",
      "or **pods without requests** for the metric used."
    ],
    rootCause: [
      "CPU and memory utilization targets are percentages **of requests**. The HPA needs:",
      "",
      "1. the `metrics.k8s.io` APIService available (metrics-server installed, running, and reachable from the",
      "   API server);",
      "2. every container in the target pods to declare a request for that resource (one sidecar without a",
      "   CPU request makes the whole calculation fail);",
      "3. enough ready pods with recent metrics.",
      "",
      "For custom metrics, the corresponding adapter (Prometheus Adapter, KEDA) must serve the metric name."
    ],
    investigation: [
      {
        title: "Read the HPA's conditions and events",
        run: "kubectl describe hpa orders-api -n shop",
        lookFor: "`ScalingActive False` with `FailedGetResourceMetric`, and the message behind it."
      },
      {
        title: "Check the metrics API",
        run: [
          "kubectl get apiservice v1beta1.metrics.k8s.io",
          "kubectl top pods -n shop",
          "kubectl get pods -n kube-system -l k8s-app=metrics-server"
        ],
        lookFor: "`Available False`, or `kubectl top` failing (see apiservice-unavailable)."
      },
      {
        title: "Check requests on every container, including injected sidecars",
        run: "kubectl get pod <pod> -n shop -o jsonpath='{range .spec.containers[*]}{.name}{\"\\t\"}{.resources.requests}{\"\\n\"}{end}'",
        lookFor: "A container with no CPU request, often a sidecar added by a mutating webhook."
      }
    ],
    resolution: [
      "Install or repair metrics-server (the EKS community add-on or the Helm chart), and set requests on every",
      "container, including sidecars (configure the injector's resource defaults). For sidecars you cannot",
      "change, use `type: ContainerResource` metrics that target only the main container."
    ],
    prevention: [
      "Require CPU and memory requests on all containers with an admission policy or LimitRange defaults.",
      "Alert on HPAs with `ScalingActive=false` and on HPAs pinned at `maxReplicas` for 15 minutes."
    ],
    signals: [
      [4, "<unknown>/\\d+%"],
      [4, "FailedGetResourceMetric"],
      [4, "missing request for (cpu|memory)"],
      [3, "unable to get metrics for resource"],
      [2, "pods\\.metrics\\.k8s\\.io"]
    ],
    samples: [
      [
        "NAME         REFERENCE               TARGETS              MINPODS   MAXPODS   REPLICAS   AGE",
        "orders-api   Deployment/orders-api   cpu: <unknown>/70%   3         30        3          4d"
      ],
      "Warning  FailedGetResourceMetric  2m (x200 over 50m)  horizontal-pod-autoscaler  failed to get cpu utilization: unable to get metrics for resource cpu: unable to fetch metrics from resource metrics API: the server could not find the requested resource (get pods.metrics.k8s.io)",
      "failed to get cpu utilization: missing request for cpu in container \"api\" of Pod \"orders-api-7d9f8c6b5-abcde\""
    ],
    related: ["apiservice-unavailable", "pending-insufficient-resources", "cpu-throttling"],
    lab: "hpa-unknown-metrics",
    runbook: null
  },
  {
    id: "karpenter-not-provisioning",
    title: "Karpenter does not launch nodes",
    kind: "symptom",
    layer: "autoscaling",
    scope: "eks",
    summary: "Pods are Pending but Karpenter launches nothing: NodePool limits or requirements, IAM, subnets or EC2 capacity stop it.",
    propagation: {
      map: "eks",
      origins: [
        { at: "iam", note: "Controller role cannot CreateFleet or PassRole" },
        { at: "vpc", note: "Subnets full or not discovered by tag" },
        { at: "ec2", note: "No capacity or quota for allowed types" }
      ],
      path: [{ at: "karpenter", note: "NodeClaim fails, or is never created" }],
      symptom: { at: "application", note: "Pods stay Pending" }
    },
    components: ["karpenter", "ec2", "iam", "vpc"],
    symptom: [
      "Pods stay `Pending` and no NodeClaims are created, or NodeClaims are created and then deleted without",
      "ever becoming nodes. Karpenter's logs show `could not schedule pod`, `incompatible with nodepool`, or EC2",
      "launch errors."
    ],
    affected: [
      "**Karpenter** matches pending pods to NodePools, picks instance types, and launches through **EC2",
      "Fleet** using its **IAM** role, into subnets and security groups discovered by its EC2NodeClass in the",
      "**VPC**."
    ],
    rootCause: [
      "Karpenter launches a node only if some NodePool can produce an instance that satisfies the pod. It",
      "fails when:",
      "",
      "- **No NodePool fits:** the pod's requirements (arch, capacity type, zone, labels, taints) exclude every",
      "  NodePool, or the pod is larger than any allowed instance type (`no instance type satisfied resources`).",
      "- **Limits:** the NodePool's `spec.limits` for CPU or memory is reached.",
      "- **The EC2NodeClass is not ready:** subnet, security group or AMI selectors match nothing, or the",
      "  instance profile cannot be created. Check its status conditions.",
      "- **EC2 says no:** insufficient capacity for every allowed type in the allowed zones, vCPU quota, or a",
      "  subnet out of addresses.",
      "- **Permissions:** the controller role cannot `ec2:RunInstances`, `ec2:CreateFleet` or `iam:PassRole`",
      "  the node role, or a service control policy denies it.",
      "- **Launched but never registered:** the node cannot join (see eks-node-join-failure); the NodeClaim is",
      "  deleted after its registration timeout."
    ],
    investigation: [
      {
        title: "Read Karpenter's decision for the pod",
        run: [
          "kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter --tail=300 | grep -i -E \"could not schedule|incompatible|error\"",
          "kubectl get events -n shop --field-selector involvedObject.name=<pod>"
        ],
        lookFor: "Which NodePool rejected the pod and why, or the EC2 error."
      },
      {
        title: "Check NodePools, limits and NodeClass readiness",
        run: [
          "kubectl get nodepools",
          "kubectl describe nodepool general | sed -n '/Limits/,/Events/p'",
          "kubectl get ec2nodeclass general -o jsonpath='{range .status.conditions[*]}{.type}{\"=\"}{.status}{\" \"}{.message}{\"\\n\"}{end}'"
        ],
        lookFor: "Resources at limits, or `Ready=False` with subnets, security groups or AMIs not found."
      },
      {
        title: "Follow NodeClaims through their lifecycle",
        run: [
          "kubectl get nodeclaims -o wide",
          "kubectl describe nodeclaim <name> | sed -n '/Conditions/,$p'"
        ],
        lookFor: "`Launched=False` (EC2 or IAM), or `Launched=True` but `Registered=False` (node join)."
      }
    ],
    resolution: [
      "Widen the NodePool (more instance families and sizes, more zones, Spot and On-Demand), raise limits, fix",
      "the EC2NodeClass selectors (tag subnets and security groups with `karpenter.sh/discovery`), fix the",
      "controller's IAM, or create the node role's access entry. Very large pods may need a dedicated NodePool."
    ],
    prevention: [
      "Allow broad instance diversity in NodePools; narrow requirements are the main cause of capacity errors.",
      "Alert on pods Pending more than 10 minutes, on EC2NodeClass `Ready=False`, and on NodeClaims that fail to register.",
      "Keep Karpenter on a small managed node group or Fargate, never on nodes it manages."
    ],
    signals: [
      [5, "incompatible with nodepool"],
      [4, "no instance type satisfied resources"],
      [4, "InsufficientInstanceCapacity|InsufficientCapacityError"],
      [3, "exceed limits for nodepool|all available instance types exceed limits"],
      [2, "nodeclaim"]
    ],
    samples: [
      "ERROR controller.provisioner could not schedule pod, incompatible with nodepool \"general\", daemonset overhead={\"cpu\":\"210m\",\"memory\":\"340Mi\",\"pods\":\"5\"}, no instance type satisfied resources {\"cpu\":\"18\",\"memory\":\"80Gi\",\"pods\":\"1\"} and requirements karpenter.sh/capacity-type In [on-demand spot], kubernetes.io/arch In [amd64 arm64]",
      "launching nodeclaim, creating instance, insufficient capacity, with fleet error(s), InsufficientInstanceCapacity: We currently do not have sufficient c7g.4xlarge capacity in the Availability Zone you requested (eu-west-1a)."
    ],
    related: [
      "pending-insufficient-resources",
      "eks-node-join-failure",
      "pod-ip-exhaustion",
      "exec-format-error",
      "volume-node-affinity-conflict"
    ],
    lab: null,
    runbook: "pending-pods-capacity"
  }
]);
