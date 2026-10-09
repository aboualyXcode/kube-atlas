// Scheduling failures: why a pod gets no node
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the cluster and eks map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "pending-insufficient-resources",
    title: "Pending — Insufficient cpu, memory or pods",
    kind: "cause",
    layer: "scheduling",
    scope: "any",
    summary: "No node has enough unrequested CPU, memory or pod slots for the pod's requests, and no new node arrives in time.",
    propagation: {
      map: "cluster",
      origins: [{ at: "workload-controllers", note: "Requests exceed free capacity on every node" }],
      path: [{ at: "kube-scheduler", note: "Resource filter rejects every node" }],
      symptom: { at: "application", note: "Pending: Insufficient cpu or memory" },
      branches: [
        {
          from: "kube-scheduler",
          at: "node-autoscaler",
          note: "Asked for a node; limits or config may stop it"
        }
      ]
    },
    components: ["kube-scheduler", "workload-controllers", "karpenter", "cluster-autoscaler"],
    symptom: [
      "Pods stay `Pending` with a `FailedScheduling` event whose message lists `Insufficient cpu`,",
      "`Insufficient memory` or `Too many pods`. If an autoscaler is installed, it may or may not be adding",
      "nodes, and the pods may wait minutes before scheduling."
    ],
    affected: [
      "The **scheduler**'s `NodeResourcesFit` filter found no node with enough **allocatable** capacity for the",
      "pod's **requests**. Whether that is a problem depends on the **autoscaler** (Karpenter or Cluster",
      "Autoscaler) and on the requests in your **workload**."
    ],
    rootCause: [
      "The scheduler places pods by **requests**, never by actual usage. A node fits when the sum of requests of",
      "the pods already on it, plus this pod's requests, stays within the node's allocatable (capacity minus",
      "system and kubelet reservations). So a cluster can look idle in `kubectl top` and still have no room.",
      "",
      "`Too many pods` is the per-node pod limit (`max-pods`). On EKS with the VPC CNI that limit derives from",
      "how many IPs the instance's ENIs can hold, so small instances run out of pod slots long before CPU.",
      "",
      "Common causes: requests inflated far beyond use; one huge pod that fits no instance type; a burst",
      "(deploy surge, HPA scale-out) larger than headroom; an autoscaler that cannot or will not add nodes."
    ],
    investigation: [
      {
        title: "Read the scheduler's full message",
        run: "kubectl get events -n shop --field-selector reason=FailedScheduling --sort-by=.lastTimestamp | tail -5",
        lookFor: "The breakdown: `3 Insufficient cpu` means three nodes failed on CPU. Every node is accounted for exactly once across the reasons."
      },
      {
        title: "Compare the pod's requests with node allocatable",
        run: [
          "kubectl get pod <pod> -n shop -o jsonpath='{range .spec.containers[*]}{.name}{\" \"}{.resources.requests}{\"\\n\"}{end}'",
          "kubectl describe nodes | grep -A8 \"Allocated resources\""
        ],
        lookFor: "Requests larger than any node's free allocatable, or nodes at 95% requested and 30% used."
      },
      {
        title: "Check whether the autoscaler is responding",
        run: [
          "kubectl get events -n shop --field-selector involvedObject.name=<pod> | grep -i -E \"karpenter|TriggeredScaleUp|NotTriggerScaleUp|Nominated\"",
          "kubectl get nodeclaims"
        ],
        lookFor: "No autoscaler event at all (see karpenter-not-provisioning or cluster-autoscaler-no-scale-up)."
      },
      {
        title: "For Too many pods, check max-pods",
        run: "kubectl get nodes -o custom-columns=NAME:.metadata.name,TYPE:.metadata.labels.node\\\\.kubernetes\\\\.io/instance-type,PODS:.status.allocatable.pods",
        lookFor: "Low pod limits (an `m5.large` allows 29 without prefix delegation)."
      }
    ],
    resolution: [
      "- Right-size requests from observed usage; that is the cheapest capacity you will ever add.",
      "- Make sure an autoscaler can add the right kind of node (instance types big enough for the largest pod,",
      "  limits not exhausted, quotas available).",
      "- For `Too many pods`, enable VPC CNI prefix delegation or use larger instances.",
      "- Use PriorityClasses so critical pods preempt batch work instead of waiting."
    ],
    prevention: [
      "Alert on pods `Pending` for more than 10 minutes (`kube_pod_status_phase{phase=\"Pending\"}`), not on single scheduling failures.",
      "Track requested versus allocatable per node pool, and requested versus used per workload.",
      "Keep a small capacity buffer of low-priority placeholder pods for fast scale-out."
    ],
    signals: [
      [
        4,
        "Insufficient (cpu|memory|pods|ephemeral-storage|nvidia\\.com/gpu|vpc\\.amazonaws\\.com/pod-eni)"
      ],
      [3, "Too many pods"],
      [1, "\\d+/\\d+ nodes are available"],
      [1, "FailedScheduling"]
    ],
    samples: [
      "Warning  FailedScheduling  2m  default-scheduler  0/6 nodes are available: 3 Insufficient cpu, 3 Insufficient memory. preemption: 0/6 nodes are available: 6 No preemption victims found for incoming pod.",
      "0/4 nodes are available: 4 Too many pods. preemption: 0/4 nodes are available: 4 No preemption victims found for incoming pod."
    ],
    related: [
      "karpenter-not-provisioning",
      "cluster-autoscaler-no-scale-up",
      "pending-taint-affinity",
      "pod-ip-exhaustion",
      "resource-quota-exceeded"
    ],
    lab: "pending-insufficient-resources",
    runbook: "pending-pods-capacity"
  },
  {
    id: "pending-taint-affinity",
    title: "Pending — untolerated taint, affinity or topology spread",
    kind: "cause",
    layer: "scheduling",
    scope: "any",
    summary: "Nodes with room exist, but the pod's tolerations, node affinity or spread rules exclude every one of them.",
    propagation: {
      map: "cluster",
      origins: [{ at: "workload-controllers", note: "Selector, affinity or tolerations match no node" }],
      path: [{ at: "kube-scheduler", note: "Filters out every node: taint, affinity, spread" }],
      symptom: { at: "application", note: "Pending: didn't match node affinity, untolerated taint" }
    },
    components: ["kube-scheduler", "workload-controllers"],
    symptom: [
      "Pods stay `Pending` although nodes have free capacity. The `FailedScheduling` message names taints,",
      "node affinity or selectors, pod (anti-)affinity or topology spread constraints rather than resources."
    ],
    affected: [
      "The **scheduler**'s `TaintToleration`, `NodeAffinity`, `InterPodAffinity` and `PodTopologySpread`",
      "filters. The cause is the **workload's** placement rules disagreeing with the nodes that exist."
    ],
    rootCause: [
      "Each filter removes nodes for a reason that has nothing to do with capacity:",
      "",
      "- **Taints:** a node tainted `NoSchedule` accepts only pods that tolerate it. Node pressure also taints",
      "  nodes automatically (`node.kubernetes.io/disk-pressure`), so a node can become untolerated by itself.",
      "- **Node affinity and `nodeSelector`:** the pod requires a label no node has (a typo, a label that only",
      "  exists on a node pool that is scaled to zero, or an AZ with no nodes).",
      "- **Required pod anti-affinity:** \"never two replicas on the same node\" with more replicas than nodes.",
      "- **Topology spread with `whenUnsatisfiable: DoNotSchedule`:** placing the pod would exceed `maxSkew`,",
      "  typically because one AZ has no eligible nodes.",
      "- `Preemption is not helpful` means evicting lower-priority pods would not fix it, which confirms a rule,",
      "  not capacity, blocks it."
    ],
    investigation: [
      {
        title: "Read which filter excluded which nodes",
        run: "kubectl describe pod <pod> -n shop | sed -n '/Events/,$p'",
        lookFor: "Counts per reason; they add up to the number of nodes."
      },
      {
        title: "Compare the pod's rules with node labels and taints",
        run: [
          "kubectl get pod <pod> -n shop -o jsonpath='{.spec.nodeSelector}{\"\\n\"}{.spec.affinity}{\"\\n\"}{.spec.tolerations}{\"\\n\"}{.spec.topologySpreadConstraints}{\"\\n\"}'",
          "kubectl get nodes -L topology.kubernetes.io/zone,karpenter.sh/nodepool,larder.example/pool",
          "kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints"
        ],
        lookFor: "The label the pod needs, missing from every node; a taint without a matching toleration; one zone without nodes."
      },
      {
        title: "For topology spread, count pods per zone",
        run: [
          "kubectl get pods -n shop -l app=orders-api -o custom-columns=NODE:.spec.nodeName --no-headers | \\",
          "  xargs -I{} kubectl get node {} -o jsonpath='{.metadata.labels.topology\\.kubernetes\\.io/zone}{\"\\n\"}' | sort | uniq -c"
        ],
        lookFor: "A zone at zero because no node pool covers it."
      }
    ],
    resolution: [
      "Fix whichever side is wrong: add the toleration or label, correct the selector, or make sure the node pool",
      "(and its subnets) covers every zone the spread constraint expects. Use `whenUnsatisfiable:",
      "ScheduleAnyway` for best-effort spreading and preferred (not required) anti-affinity unless co-location",
      "is truly unacceptable."
    ],
    prevention: [
      "Keep placement rules in shared templates, not hand-written per service.",
      "Ensure each NodePool or node group spans every AZ your workloads spread across.",
      "Alert on pods Pending for more than 10 minutes, and inspect taints added by node pressure."
    ],
    signals: [
      [4, "untolerated taint"],
      [4, "didn't match Pod's node affinity/selector"],
      [4, "didn't match pod topology spread constraints"],
      [3, "didn't match pod affinity rules|didn't match pod anti-affinity rules"],
      [1, "\\d+/\\d+ nodes are available"]
    ],
    samples: [
      "0/6 nodes are available: 2 node(s) had untolerated taint {dedicated: batch}, 4 node(s) didn't match Pod's node affinity/selector. preemption: 0/6 nodes are available: 6 Preemption is not helpful for scheduling.",
      "0/3 nodes are available: 3 node(s) didn't match pod topology spread constraints. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling."
    ],
    related: [
      "pending-insufficient-resources",
      "volume-node-affinity-conflict",
      "node-pressure-eviction",
      "karpenter-not-provisioning"
    ],
    lab: "pending-taint-affinity",
    runbook: "pending-pods-capacity"
  },
  {
    id: "pending-unbound-pvc",
    title: "Pending — pod has unbound immediate PersistentVolumeClaims",
    kind: "symptom",
    layer: "scheduling",
    scope: "any",
    summary: "The pod is waiting for a PersistentVolumeClaim that has no volume yet, so the scheduler cannot place it.",
    propagation: {
      map: "eks",
      origins: [{ at: "ebs-csi-driver", note: "Provisioner cannot create the volume, or wrong class" }],
      path: [
        { at: "kube-controller-manager", note: "Claim stays unbound" },
        { at: "kube-scheduler", note: "Cannot place a pod whose claim is unbound" }
      ],
      symptom: { at: "application", note: "Pending: unbound immediate PersistentVolumeClaims" }
    },
    components: ["kube-scheduler", "kube-controller-manager", "ebs-csi-driver"],
    symptom: [
      "A pod that mounts a PVC stays `Pending`. The scheduler says the pod has unbound immediate",
      "PersistentVolumeClaims, and the PVC itself is `Pending`."
    ],
    affected: [
      "The **scheduler** refuses to place a pod whose claim is not bound, when the claim's StorageClass uses",
      "`Immediate` binding (or names a class that does not exist). The cause lies with the **PVC** and its",
      "provisioner."
    ],
    rootCause: [
      "With `volumeBindingMode: Immediate`, a PVC must be bound to a PV before its pod can be scheduled. If the",
      "claim cannot be bound, the scheduler waits. That happens when the StorageClass does not exist, the",
      "provisioner fails to create a volume, or no pre-created PV matches the claim's size, access mode and",
      "class. A claim that names a non-existent class is treated as immediate, so the pod waits forever.",
      "",
      "With `WaitForFirstConsumer` (recommended for EBS), the scheduler picks the node first and the volume is",
      "created in that node's zone; you would instead see the PVC waiting for the consumer, which is normal."
    ],
    investigation: [
      {
        title: "Look at the claim, not the pod",
        run: [
          "kubectl get pvc -n catalog",
          "kubectl describe pvc search-data-search-indexer-0 -n catalog | sed -n '/Events/,$p'"
        ],
        lookFor: "The PVC's own events say why it is unbound (see pvc-pending-provisioning)."
      },
      {
        title: "Check the class it asks for",
        run: [
          "kubectl get pvc search-data-search-indexer-0 -n catalog -o jsonpath='{.spec.storageClassName}'; echo",
          "kubectl get storageclass"
        ],
        lookFor: "A class that does not exist, or no default class when the claim names none."
      }
    ],
    resolution: [
      "Fix the claim's class (claims are immutable in that field, so recreate the PVC, or edit the",
      "StatefulSet's `volumeClaimTemplates` and recreate its pods), or fix provisioning as described in",
      "pvc-pending-provisioning. Prefer StorageClasses with `WaitForFirstConsumer` for zonal storage."
    ],
    prevention: [
      "Define a default StorageClass explicitly; on EKS 1.30 and later, new clusters no longer mark `gp2` as default.",
      "Alert on `kube_persistentvolumeclaim_status_phase{phase=\"Pending\"}` for more than 5 minutes."
    ],
    signals: [
      [5, "unbound immediate PersistentVolumeClaims"],
      [2, "persistentvolumeclaim \"[^\"]+\" not found"],
      [1, "\\d+/\\d+ nodes are available"]
    ],
    samples: [
      "Warning  FailedScheduling  30s  default-scheduler  0/6 nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/6 nodes are available: 6 Preemption is not helpful for scheduling."
    ],
    related: ["pvc-pending-provisioning", "volume-node-affinity-conflict"],
    lab: "pending-unbound-pvc",
    runbook: null
  },
  {
    id: "resource-quota-exceeded",
    title: "Pods never created — exceeded quota or LimitRange",
    kind: "cause",
    layer: "scheduling",
    scope: "any",
    summary: "A ResourceQuota or LimitRange rejects pods at admission, so they are never created and there is nothing to describe.",
    propagation: {
      map: "cluster",
      origins: [{ at: "workload-controllers", note: "Namespace quota used up, or pod lacks requests" }],
      path: [
        { at: "kube-apiserver", note: "Quota admission rejects the pod (exceeded quota)" },
        { at: "kube-controller-manager", note: "ReplicaSet controller records FailedCreate" }
      ],
      symptom: { at: "client", note: "Fewer replicas than desired, no pending pods" }
    },
    components: ["kube-apiserver", "kube-controller-manager", "workload-controllers"],
    symptom: [
      "A Deployment shows `READY 2/5` but there are no Pending pods to inspect: the missing replicas do not",
      "exist at all. `kubectl get pods` looks healthy, and the scheduler has nothing to say."
    ],
    affected: [
      "The **ResourceQuota** and **LimitRanger** admission plugins in the **API server** reject the pod at",
      "creation, and the **ReplicaSet controller** records `FailedCreate` on the ReplicaSet, not on any pod."
    ],
    rootCause: [
      "A ResourceQuota caps the sum of requests, limits or object counts in a namespace. Once the namespace is",
      "at its cap, every new pod is rejected at admission. When a quota covers `limits.memory` (or any compute",
      "resource), every pod must also declare that resource, so a pod without limits is rejected even if the",
      "namespace has room. A LimitRange rejects pods outside its min and max.",
      "",
      "Because the rejection happens before the pod exists, the evidence lives on the ReplicaSet (or Job,",
      "StatefulSet) events."
    ],
    investigation: [
      {
        title: "Read the owner's events, not the pods'",
        run: "kubectl describe rs -n shop -l app=orders-api | sed -n '/Events/,$p'",
        lookFor: "`FailedCreate ... is forbidden: exceeded quota` or `must specify`."
      },
      {
        title: "Compare quota usage with the hard limits",
        run: [
          "kubectl describe resourcequota -n shop",
          "kubectl describe limitrange -n shop"
        ],
        lookFor: "`Used` equal to `Hard` for the resource named in the event."
      }
    ],
    resolution: [
      "Free quota (scale down something else, right-size requests) or raise the quota through whatever process",
      "owns it. If the error is `must specify`, add the missing requests or limits to the pod template, or add a",
      "LimitRange that supplies defaults."
    ],
    prevention: [
      "Alert when quota usage exceeds 85% (`kube_resourcequota{type=\"used\"} / kube_resourcequota{type=\"hard\"}`).",
      "Ship a LimitRange with defaults alongside every ResourceQuota.",
      "Size quotas for rollouts: `maxSurge` pods need room during every deploy."
    ],
    signals: [
      [5, "exceeded quota"],
      [4, "failed quota: .* must specify"],
      [3, "maximum (cpu|memory) usage per (Container|Pod) is"],
      [2, "FailedCreate"]
    ],
    samples: [
      "Warning  FailedCreate  1m (x12 over 3m)  replicaset-controller  Error creating: pods \"orders-api-7d9f8c6b5-\" is forbidden: exceeded quota: shop-quota, requested: requests.cpu=500m, used: requests.cpu=3800m, limited: requests.cpu=4",
      "Error creating: pods \"dispatch-worker-6c5d-\" is forbidden: failed quota: fulfilment-quota: must specify limits.memory for: worker"
    ],
    related: ["rollout-stuck", "pending-insufficient-resources", "webhook-unavailable"],
    lab: "resource-quota-exceeded",
    runbook: null
  }
]);
