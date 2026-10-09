// Node failures: kubelet, runtime, network plugin, instance
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the cluster and eks map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "cni-not-ready",
    title: "Network plugin not ready (cni plugin not initialized)",
    kind: "cause",
    layer: "node",
    scope: "eks",
    summary: "The VPC CNI (aws-node) is not running or cannot call EC2, so the node cannot give pods network interfaces.",
    propagation: {
      map: "eks",
      origins: [{ at: "iam", note: "CNI role lacks EC2 networking permissions" }],
      path: [
        { at: "cni", note: "aws-node fails to start ipamd" },
        { at: "kubelet", note: "Reports NetworkReady=false" }
      ],
      symptom: { at: "application", note: "Node NotReady, pods stuck ContainerCreating" }
    },
    components: ["cni", "kubelet", "iam", "pod-identity-agent"],
    symptom: [
      "A new node stays `NotReady` with `NetworkPluginNotReady`. Pods scheduled to it stick in",
      "`ContainerCreating`. On EKS the `aws-node` pod on that node is crashing, not ready, or missing."
    ],
    affected: [
      "The **kubelet** reports the node not ready because the **CNI** has not written its configuration. On EKS",
      "the CNI is the `aws-node` DaemonSet (Amazon VPC CNI), which needs **IAM** permissions to manage ENIs."
    ],
    rootCause: [
      "The kubelet considers the network ready once a CNI configuration exists in `/etc/cni/net.d`. The VPC CNI",
      "writes it when its `aws-node` pod starts successfully. It does not when:",
      "",
      "- `aws-node` cannot call EC2 (`ec2:AssignPrivateIpAddresses`, `ec2:CreateNetworkInterface`...): its",
      "  IRSA role or Pod Identity association is missing or wrong, or `AmazonEKS_CNI_Policy` was removed from",
      "  the node role without giving it to the service account;",
      "- its image cannot be pulled (private subnet without ECR endpoints or NAT);",
      "- the add-on version is incompatible with the cluster version, or a custom configuration (custom",
      "  networking `ENIConfig`, prefix delegation) is invalid for that node;",
      "- the node's subnet has no free addresses at all."
    ],
    investigation: [
      {
        title: "Find the aws-node pod on the affected node",
        run: [
          "kubectl get pods -n kube-system -l k8s-app=aws-node -o wide --field-selector spec.nodeName=<node-name>",
          "kubectl describe pod -n kube-system <aws-node-pod> | sed -n '/Events/,$p'"
        ],
        lookFor: "Image pull errors, readiness failures, crash loops."
      },
      {
        title: "Read its logs",
        run: [
          "kubectl logs -n kube-system <aws-node-pod> -c aws-node --tail=100",
          "# on the node: /var/log/aws-routed-eni/ipamd.log and plugin.log"
        ],
        lookFor: "`AccessDenied`/`UnauthorizedOperation` (IAM), `InsufficientFreeAddressesInSubnet`, or ENIConfig errors."
      },
      {
        title: "Check how aws-node gets AWS credentials",
        run: [
          "kubectl get sa aws-node -n kube-system -o jsonpath='{.metadata.annotations}'; echo",
          "aws eks list-pod-identity-associations --cluster-name larder-prod --namespace kube-system",
          "aws eks describe-addon --cluster-name larder-prod --addon-name vpc-cni --query 'addon.[addonVersion,status,serviceAccountRoleArn]'"
        ],
        lookFor: "No role annotation, no association and no CNI policy on the node role."
      }
    ],
    resolution: [
      "Give the VPC CNI its permissions (an IRSA role or Pod Identity association with `AmazonEKS_CNI_Policy`),",
      "update the add-on to a version supported for your cluster version, and fix image pull paths. Once",
      "`aws-node` is ready, the node becomes Ready on its own."
    ],
    prevention: [
      "Manage the VPC CNI as an EKS add-on with its IAM role in the same code.",
      "Check add-on versions against the cluster version before every upgrade.",
      "Alert on DaemonSets with unavailable pods (`kube_daemonset_status_number_unavailable > 0`)."
    ],
    signals: [
      [5, "NetworkPluginNotReady"],
      [5, "cni plugin not initialized"],
      [3, "container runtime network not ready"],
      [2, "aws-node"]
    ],
    samples: [
      "Ready  False  KubeletNotReady  container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized"
    ],
    related: ["node-not-ready", "pod-ip-exhaustion", "eks-node-join-failure"],
    lab: null,
    runbook: "node-not-ready"
  },
  {
    id: "eks-node-join-failure",
    title: "EKS nodes fail to join the cluster",
    kind: "symptom",
    layer: "node",
    scope: "eks",
    summary: "Instances launch but never register as nodes: their identity, their network path to the cluster endpoint, or their bootstrap configuration is wrong.",
    propagation: {
      map: "eks",
      origins: [
        { at: "iam", note: "Node role has no access entry" },
        { at: "security-groups", note: "Port 443 to the cluster endpoint blocked" },
        { at: "vpc", note: "No route or DNS to a private endpoint" }
      ],
      path: [{ at: "kubelet", note: "Cannot authenticate to, or reach, the API server" }],
      symptom: { at: "ec2", note: "Instances running, no Node objects appear" }
    },
    components: ["kubelet", "iam", "vpc", "security-groups", "ec2", "kube-apiserver"],
    symptom: [
      "EC2 instances launch and run, but never appear in `kubectl get nodes`. A managed node group goes to",
      "`CREATE_FAILED` or `DEGRADED` with `NodeCreationFailure`; Karpenter NodeClaims stay not `Registered` and",
      "are eventually deleted; pods stay Pending despite new instances."
    ],
    affected: [
      "The **kubelet** cannot register with the **API server**. The cause is identity (**IAM** role not",
      "authorized in the cluster), connectivity (**security groups**, routes, endpoint access, DNS), or the",
      "node's bootstrap configuration."
    ],
    rootCause: [
      "To join, a node must: reach the cluster endpoint on 443; authenticate with a token derived from its IAM",
      "role; be authorized as a node; and start its kubelet with the right cluster name, endpoint and CA.",
      "",
      "- **Not authorized:** the node role has no access entry of type `EC2_LINUX` (or `EC2_WINDOWS`), or in",
      "  `CONFIG_MAP` mode no `aws-auth` mapping to `system:bootstrappers` and `system:nodes`. Logs say",
      "  `Unauthorized`. This often happens with a new Karpenter node role that was never registered.",
      "- **No path:** the private endpoint is enabled with public access off, and the VPC lacks DNS hostnames",
      "  or resolution, or the node security group cannot reach the cluster security group on 443.",
      "- **Bootstrap:** wrong cluster name or endpoint in user data (AL2023 uses `nodeadm` with a `NodeConfig`),",
      "  an AMI for the wrong Kubernetes version, or user data that fails before the kubelet starts.",
      "- **Image pulls at boot:** in private subnets without NAT or endpoints, add-on images such as the VPC CNI",
      "  cannot be pulled, so the node registers but never becomes Ready."
    ],
    investigation: [
      {
        title: "Read the node group or NodeClaim health",
        run: [
          "aws eks describe-nodegroup --cluster-name larder-prod --nodegroup-name system --query 'nodegroup.health'",
          "kubectl get nodeclaims -o wide",
          "kubectl describe nodeclaim <name> | sed -n '/Conditions/,$p'"
        ],
        lookFor: "`NodeCreationFailure` with instance ids; NodeClaims `Launched` but not `Registered`."
      },
      {
        title: "Check the node role is authorized",
        run: [
          "aws eks list-access-entries --cluster-name larder-prod",
          "aws eks describe-access-entry --cluster-name larder-prod \\",
          "  --principal-arn arn:aws:iam::111122223333:role/KarpenterNodeRole-larder-prod",
          "kubectl get configmap aws-auth -n kube-system -o yaml   # CONFIG_MAP or API_AND_CONFIG_MAP mode"
        ],
        lookFor: "No entry for the role, or an entry of type `STANDARD` instead of `EC2_LINUX`."
      },
      {
        title: "Read the bootstrap and kubelet logs on an instance",
        run: [
          "aws ssm start-session --target i-0abc123def4567890",
          "sudo journalctl -u nodeadm-config -u nodeadm-run -u kubelet --no-pager | tail -100"
        ],
        lookFor: "`Unauthorized`, `x509`, `dial tcp ...:443: i/o timeout`, or a NodeConfig parse error."
      },
      {
        title: "Check the network path and DNS",
        run: [
          "aws eks describe-cluster --name larder-prod --query 'cluster.resourcesVpcConfig'",
          "aws ec2 describe-vpc-attribute --vpc-id <vpc-id> --attribute enableDnsHostnames"
        ],
        lookFor: "`endpointPublicAccess: false` with DNS hostnames disabled, or security groups that do not allow 443 from nodes."
      }
    ],
    resolution: [
      "Create the missing access entry for the node role:",
      "",
      "```sh",
      "aws eks create-access-entry --cluster-name larder-prod \\",
      "  --principal-arn arn:aws:iam::111122223333:role/KarpenterNodeRole-larder-prod --type EC2_LINUX",
      "```",
      "",
      "Then fix connectivity (enable VPC DNS hostnames and resolution, allow 443 from the node security group to",
      "the cluster security group) or the bootstrap configuration, and replace the failed instances."
    ],
    prevention: [
      "Create node roles and their access entries in the same infrastructure-as-code change.",
      "Use the API authentication mode and manage access entries as code; avoid hand-edited `aws-auth`.",
      "Run a canary node through any change to AMIs, user data, subnets or security groups."
    ],
    signals: [
      [5, "Instances failed to join the kubernetes cluster"],
      [4, "NodeCreationFailure"],
      [4, "Unable to register node with API server"],
      [2, "err=\"Unauthorized\""]
    ],
    samples: [
      "NodeCreationFailure: Instances failed to join the kubernetes cluster. ResourceIds: i-0abc123def4567890",
      "kubelet[2211]: E1006 09:31:02.112 kubelet_node_status.go:96] \"Unable to register node with API server\" err=\"Unauthorized\" node=\"ip-10-20-52-9.eu-west-1.compute.internal\""
    ],
    related: ["node-not-ready", "cni-not-ready", "kubectl-unauthorized", "karpenter-not-provisioning"],
    lab: null,
    runbook: "node-not-ready"
  },
  {
    id: "node-not-ready",
    title: "Node NotReady",
    kind: "symptom",
    layer: "node",
    scope: "any",
    summary: "The node stopped reporting healthy: the kubelet, the container runtime, the network plugin or the instance itself failed.",
    propagation: {
      map: "cluster",
      origins: [
        { at: "ec2", note: "Instance impaired, stopped or reclaimed" },
        { at: "container-runtime", note: "containerd hung or crashed" },
        { at: "cni", note: "Network plugin not ready" }
      ],
      path: [
        { at: "kubelet", note: "Stops renewing its Lease, or reports NotReady" },
        { at: "kube-controller-manager", note: "Taints the node; evicts its pods after 5 min" }
      ],
      symptom: { at: "client", note: "kubectl get nodes shows NotReady" },
      branches: [
        {
          from: "kube-controller-manager",
          at: "service",
          note: "Its pods leave Service endpoints"
        }
      ]
    },
    components: ["kubelet", "container-runtime", "cni", "kube-controller-manager", "ec2"],
    symptom: [
      "`kubectl get nodes` shows `NotReady`. New pods are not scheduled there. After about five minutes, pods on",
      "the node are marked for eviction and recreated elsewhere (Deployments), while StatefulSet pods wait.",
      "Pods may show `Terminating` or `Unknown`."
    ],
    affected: [
      "The **node lifecycle controller** sets the condition when the **kubelet** stops renewing its heartbeat",
      "(`Unknown`) or reports itself unhealthy (`False`). The cause is on the node: the kubelet, the",
      "**container runtime**, the **CNI**, resources, or the **EC2 instance** itself."
    ],
    rootCause: [
      "The kubelet renews a Lease every 10 seconds and posts node status. Two very different situations both",
      "show `NotReady`:",
      "",
      "- **`Unknown` — \"Kubelet stopped posting node status\":** the control plane cannot hear the kubelet.",
      "  The instance crashed or was terminated, the kubelet process died, the node is frozen by memory",
      "  exhaustion, or the network between node and control plane broke (security group, route, endpoint).",
      "- **`False` — the kubelet reports a problem:** `container runtime is down`, `PLEG is not healthy`",
      "  (the runtime is too slow to report container states, often due to disk I/O or too many containers),",
      "  or `container runtime network not ready` (the CNI is not initialized; see cni-not-ready).",
      "",
      "After the grace period the node gets the `node.kubernetes.io/unreachable` or `not-ready` taint with",
      "`NoExecute`; pods tolerate it for 300 seconds by default and are then evicted."
    ],
    investigation: [
      {
        title: "Read the Ready condition's status, reason and message",
        run: "kubectl describe node ip-10-20-44-17.eu-west-1.compute.internal | sed -n '/Conditions/,/Addresses/p'",
        lookFor: "`Unknown` (cannot hear the node) versus `False` with a reason (the node reports a fault)."
      },
      {
        title: "Check the instance from AWS",
        run: [
          "aws ec2 describe-instance-status --instance-ids i-0abc123def4567890 --include-all-instances",
          "aws ec2 get-console-output --instance-id i-0abc123def4567890 --latest --output text | tail -50"
        ],
        lookFor: "Failed status checks, `stopping` or `terminated` (Spot interruption, scale-in), kernel OOM or panics in the console."
      },
      {
        title: "Get onto the node and read kubelet and runtime logs",
        run: [
          "aws ssm start-session --target i-0abc123def4567890",
          "sudo journalctl -u kubelet --since \"30 min ago\" --no-pager | tail -100",
          "sudo systemctl status containerd kubelet",
          "df -h / /var/lib/containerd; free -m"
        ],
        lookFor: "Certificate or authentication errors, runtime timeouts, a full disk, memory exhaustion."
      },
      {
        title: "Check node-to-control-plane connectivity",
        run: "curl -sk -m 5 \"$(aws eks describe-cluster --name larder-prod --query cluster.endpoint --output text)/healthz\"",
        lookFor: "A timeout points to security groups, routes or the endpoint access configuration."
      }
    ],
    resolution: [
      "- **Instance gone or impaired:** let the node group or Karpenter replace it; delete the Node object if it",
      "  lingers so pods move immediately.",
      "- **kubelet or runtime crashed:** restart them (`systemctl restart containerd kubelet`) to restore",
      "  service, then find out why (logs, disk, memory) before the next node does the same.",
      "- **Resource exhaustion:** set `kubeReserved`/`systemReserved` and eviction thresholds so the kubelet",
      "  keeps headroom, and fix the workload that consumed it.",
      "- For many nodes at once, suspect a shared cause: a bad AMI, a DaemonSet rollout, a security group or",
      "  network ACL change, or an expired credential."
    ],
    prevention: [
      "Run nodes from managed node groups or Karpenter with health-based replacement, and enable the EC2 auto-recovery or node repair features available to you.",
      "Alert on `kube_node_status_condition{condition=\"Ready\",status=\"true\"} == 0` for 5 minutes, and page when more than one node is affected.",
      "Roll DaemonSet and AMI changes through a canary node pool first."
    ],
    signals: [
      [3, "NotReady"],
      [4, "Kubelet stopped posting node status"],
      [4, "PLEG is not healthy"],
      [3, "container runtime is down|ContainerRuntimeUnhealthy"],
      [1, "NodeStatusUnknown"]
    ],
    samples: [
      [
        "NAME                                         STATUS     ROLES    AGE   VERSION",
        "ip-10-20-44-17.eu-west-1.compute.internal    NotReady   <none>   12d   v1.35.2-eks-1a2b3c4"
      ],
      "Ready   Unknown   Tue, 06 Oct 2026 10:02:11 +0000   NodeStatusUnknown   Kubelet stopped posting node status.",
      "Ready   False     Tue, 06 Oct 2026 10:04:51 +0000   KubeletNotReady    PLEG is not healthy: pleg was last seen active 3m10s ago; threshold is 3m0s"
    ],
    related: ["cni-not-ready", "node-pressure-eviction", "eks-node-join-failure", "pod-stuck-terminating"],
    lab: null,
    runbook: "node-not-ready"
  },
  {
    id: "node-pressure-eviction",
    title: "Evicted — node low on memory, disk or PIDs",
    kind: "cause",
    layer: "node",
    scope: "any",
    summary: "The node ran low on memory, disk or process IDs, so the kubelet evicted pods to keep the node alive.",
    propagation: {
      map: "cluster",
      origins: [{ at: "application", note: "Uses memory, disk or PIDs beyond its requests" }],
      path: [{ at: "kubelet", note: "Eviction threshold crossed: memory, nodefs or pid" }],
      symptom: { at: "application", note: "Pods Evicted, node under pressure" },
      branches: [{ from: "kubelet", at: "kube-scheduler", note: "Pressure taint keeps new pods away" }]
    },
    components: ["kubelet", "application"],
    symptom: [
      "Pods end up in `Failed` with reason `Evicted` and a message naming memory, ephemeral storage or PIDs. The",
      "node shows `MemoryPressure`, `DiskPressure` or `PIDPressure`, carries a matching `NoSchedule` taint, and",
      "other pods may become Pending because of that taint. Evicted pod objects pile up in `kubectl get pods`."
    ],
    affected: [
      "The **kubelet**'s eviction manager reclaims node resources when a signal crosses its threshold. The",
      "cause is usually a **workload** using more than it requested, or node sizing and reservations."
    ],
    rootCause: [
      "The kubelet watches node-level signals against eviction thresholds (Linux defaults: `memory.available",
      "< 100Mi`, `nodefs.available < 10%`, `imagefs.available < 15%`, `nodefs.inodesFree < 5%`). When one is",
      "crossed, it first reclaims node resources (deletes unused images and dead containers), then evicts pods.",
      "It ranks victims by whether they exceed their **requests**, then by priority, then by usage above",
      "requests. So BestEffort pods and pods using far more than they requested go first.",
      "",
      "Typical causes:",
      "",
      "- **Memory:** pods with requests far below their real use, overcommitting the node.",
      "- **Disk:** container logs written to files instead of stdout, apps writing to the container filesystem",
      "  or `emptyDir`, images that are very large, or a small root volume.",
      "- **PIDs:** a process that forks without reaping, or a thread explosion."
    ],
    investigation: [
      {
        title: "Read the eviction message",
        run: "kubectl get pods -A --field-selector status.phase=Failed -o custom-columns=NS:.metadata.namespace,POD:.metadata.name,REASON:.status.reason,MSG:.status.message | grep Evicted",
        lookFor: "Which resource, the threshold, and which container used the most relative to its request."
      },
      {
        title: "Check node conditions and pressure taints",
        run: "kubectl describe node <node-name> | sed -n '/Conditions/,/Addresses/p;/Taints/p'",
        lookFor: "Pressure conditions currently `True`, and `node.kubernetes.io/*-pressure` taints."
      },
      {
        title: "For disk, find what fills it",
        run: [
          "kubectl debug node/<node-name> -it --image=busybox:1.36 -- sh -c \\",
          "  'chroot /host sh -c \"df -h / /var/lib/containerd; du -xsh /var/log/pods/* 2>/dev/null | sort -h | tail; du -xsh /var/lib/kubelet/pods/*/volumes/kubernetes.io~empty-dir/* 2>/dev/null | sort -h | tail\"'"
        ],
        lookFor: "A pod's log directory or `emptyDir` growing without bound."
      },
      {
        title: "For memory, compare usage with requests",
        run: "kubectl top pods -A --sort-by=memory | head -20",
        lookFor: "Pods using several times their request."
      }
    ],
    resolution: [
      "Raise requests of the pods that overcommit (so the scheduler stops overpacking), cap `emptyDir` with",
      "`sizeLimit` and set `ephemeral-storage` requests and limits, log to stdout, and give nodes enough root",
      "volume. Clean up evicted pod objects once understood:",
      "",
      "```sh",
      "kubectl delete pods -A --field-selector status.phase=Failed",
      "```"
    ],
    prevention: [
      "Requests close to real usage for memory; never run critical workloads as BestEffort.",
      "Set `ephemeral-storage` requests and limits and `emptyDir.sizeLimit`.",
      "Alert on node conditions and on node filesystem usage above 80%.",
      "Reserve resources for the system (`kubeReserved`, `systemReserved`) in node configuration."
    ],
    signals: [
      [5, "The node was low on resource"],
      [3, "Evicted"],
      [3, "MemoryPressure|DiskPressure|PIDPressure"],
      [2, "disk-pressure|memory-pressure"]
    ],
    samples: [
      "Status: Failed  Reason: Evicted  Message: The node was low on resource: memory. Threshold quantity: 100Mi, available: 84Mi. Container api was using 1302Mi, request is 512Mi, has larger consumption of memory.",
      "Message: The node was low on resource: ephemeral-storage. Threshold quantity: 10%, available: 7%. Container worker was using 18Gi, request is 0, has larger consumption of ephemeral-storage.",
      "DiskPressure   True    Tue, 06 Oct 2026 11:20:00 +0000   KubeletHasDiskPressure   kubelet has disk pressure"
    ],
    related: ["oomkilled", "node-not-ready", "pending-taint-affinity"],
    lab: null,
    runbook: "node-not-ready"
  }
]);
