// On-call runbooks as phases and steps. The atlas draws each one as a flowchart;
// `when`/`then`/`to` items are decision branches that lead to failure entries.
KA.define("runbooks", [
  {
    id: "pending-pods-capacity",
    title: "Pods pending, capacity not arriving",
    trigger: "`KubePodsPendingTooLong` (pods `Pending` for 10 minutes), a stuck rollout, or HPA at max with pending replicas.",
    impact: "new replicas do not start: rollouts stall, scale-out does not happen, and a traffic peak may outgrow running capacity.",
    phases: [
      {
        title: "Triage",
        hint: "5 minutes",
        items: [
          {
            run: [
              "kubectl get pods -A --field-selector=status.phase=Pending -o wide",
              "kubectl get events -A --field-selector reason=FailedScheduling --sort-by=.lastTimestamp | tail -10"
            ]
          },
          { text: "Read the scheduler message and classify it:" },
          {
            when: "`Insufficient cpu`, `Insufficient memory`, `Too many pods`",
            then: "[pending-insufficient-resources](#/failures/pending-insufficient-resources); then why the autoscaler did not add nodes",
            to: ["pending-insufficient-resources"]
          },
          {
            when: "`untolerated taint`, `node affinity/selector`, `topology spread`",
            then: "[pending-taint-affinity](#/failures/pending-taint-affinity): a rule, not capacity",
            to: ["pending-taint-affinity"]
          },
          {
            when: "`volume node affinity conflict`",
            then: "[volume-node-affinity-conflict](#/failures/volume-node-affinity-conflict): capacity needed in one specific zone",
            to: ["volume-node-affinity-conflict"]
          },
          {
            when: "`unbound immediate PersistentVolumeClaims`",
            then: "[pending-unbound-pvc](#/failures/pending-unbound-pvc)",
            to: ["pending-unbound-pvc"]
          },
          {
            when: "no pods exist, ReplicaSet shows `FailedCreate`",
            then: "[resource-quota-exceeded](#/failures/resource-quota-exceeded) or [webhook-unavailable](#/failures/webhook-unavailable)",
            to: ["resource-quota-exceeded", "webhook-unavailable"]
          }
        ]
      },
      {
        title: "Diagnose",
        hint: "why no new nodes",
        items: [
          {
            title: "Karpenter",
            run: [
              "kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter --tail=300 | grep -i -E \"could not schedule|incompatible|error|insufficient\"",
              "kubectl get nodepools; kubectl get nodeclaims -o wide",
              "kubectl get ec2nodeclass -o jsonpath='{range .items[*]}{.metadata.name}{\": \"}{range .status.conditions[*]}{.type}={.status} {end}{\"\\n\"}{end}'"
            ]
          },
          {
            when: "`incompatible with nodepool`, `no instance type satisfied`",
            then: "[karpenter-not-provisioning](#/failures/karpenter-not-provisioning): requirements too narrow, pod too big",
            to: ["karpenter-not-provisioning"]
          },
          {
            when: "NodePool at its limits",
            then: "raise `spec.limits` if the growth is legitimate",
            to: []
          },
          {
            when: "`InsufficientInstanceCapacity`",
            then: "widen instance families, sizes and zones; allow On-Demand fallback",
            to: []
          },
          {
            when: "`InsufficientFreeAddressesInSubnet`",
            then: "[pod-ip-exhaustion runbook](#/operations/runbooks/pod-ip-exhaustion)",
            to: ["runbook:pod-ip-exhaustion"]
          },
          {
            when: "NodeClaims launched but not registered",
            then: "[eks-node-join-failure](#/failures/eks-node-join-failure)",
            to: ["eks-node-join-failure"]
          },
          {
            title: "Cluster Autoscaler",
            text: "see [cluster-autoscaler-no-scale-up](#/failures/cluster-autoscaler-no-scale-up).",
            run: "kubectl get configmap cluster-autoscaler-status -n kube-system -o jsonpath='{.data.status}' | head -40"
          }
        ]
      },
      {
        title: "Mitigate",
        hint: null,
        items: [
          {
            text: "Free room for what matters: scale down batch workloads; check that tier-1 pods have a higher PriorityClass so they preempt."
          },
          {
            text: "Remove capacity-buffer placeholder pods if present: their space is immediately available."
          },
          {
            text: "If one NodePool is blocked, temporarily allow another (On-Demand, other families) by adjusting requirements."
          },
          {
            text: "For a stalled rollout, `kubectl rollout undo` to stop asking for surge capacity."
          }
        ]
      },
      {
        title: "Resolve",
        hint: null,
        items: [
          {
            text: "Fix the blocker the diagnosis found, then let pending pods schedule. Do not raise limits blindly: confirm that the demand is real (an HPA reacting to genuine load, not a crash-looping pod inflating CPU)."
          }
        ]
      },
      {
        title: "Verify",
        hint: null,
        items: [
          {
            run: [
              "kubectl get pods -A --field-selector=status.phase=Pending",
              "kubectl get hpa -A"
            ]
          },
          { text: "No pods pending longer than a minute; HPAs below max; rollouts complete." }
        ]
      },
      {
        title: "Escalate",
        hint: null,
        items: [
          {
            text: "Page the platform lead if capacity cannot be added within 15 minutes ahead of a known peak, or if EC2 capacity or quota errors persist (request a quota increase; open an AWS support case for capacity)."
          }
        ]
      },
      {
        title: "Follow up",
        hint: null,
        items: [
          {
            text: "Review requested versus allocatable trends, NodePool limits, instance diversity and subnet sizing in the next capacity review ([chapter 13](#/operations))."
          }
        ]
      }
    ]
  },
  {
    id: "node-not-ready",
    title: "Node NotReady",
    trigger: "`KubeNodeNotReady` (a node not Ready for 5 minutes), `KubeNodePressure`, or several nodes `NotReady` at once.",
    impact: "pods on the node stop receiving traffic within a minute and are evicted after about five; StatefulSet pods and their volumes may be stuck for longer. One node is usually harmless for well-spread services. **Several nodes at once is a shared cause and a potential SEV1.**",
    phases: [
      {
        title: "Triage",
        hint: "5 minutes",
        items: [
          {
            run: [
              "kubectl get nodes -o wide -L topology.kubernetes.io/zone,karpenter.sh/nodepool,node.kubernetes.io/instance-type",
              "kubectl describe node <node> | sed -n '/Conditions/,/Addresses/p'"
            ]
          },
          {
            when: "one node, `Ready=Unknown` (`Kubelet stopped posting node status`)",
            then: "instance or kubelet failure, below",
            to: []
          },
          {
            when: "one node, `Ready=False` with a reason",
            then: "[node-not-ready](#/failures/node-not-ready), [cni-not-ready](#/failures/cni-not-ready)",
            to: ["node-not-ready", "cni-not-ready"]
          },
          {
            when: "`MemoryPressure`, `DiskPressure`, `PIDPressure`",
            then: "[node-pressure-eviction](#/failures/node-pressure-eviction)",
            to: ["node-pressure-eviction"]
          },
          {
            when: "many nodes in one AZ",
            then: "zonal issue: check AWS Health, subnets, NACLs",
            to: []
          },
          {
            when: "many nodes of one pool or AMI",
            then: "a bad AMI, user data or DaemonSet rollout",
            to: []
          },
          {
            when: "new nodes never appear",
            then: "[eks-node-join-failure](#/failures/eks-node-join-failure)",
            to: ["eks-node-join-failure"]
          }
        ]
      },
      {
        title: "Diagnose",
        hint: null,
        items: [
          {
            title: "Is the instance alive?",
            text: "Terminated or stopping means a Spot interruption, scale-in or manual action; failed status checks mean hardware or OS trouble.",
            run: [
              "aws ec2 describe-instance-status --instance-ids <instance-id> --include-all-instances",
              "aws ec2 get-console-output --instance-id <instance-id> --latest --output text | tail -40"
            ]
          },
          {
            title: "What does the node say?",
            run: [
              "aws ssm start-session --target <instance-id>",
              "sudo journalctl -u kubelet -u containerd --since \"30 min ago\" --no-pager | tail -150",
              "df -h /; free -m; sudo crictl ps -a | head"
            ]
          },
          {
            title: "What changed?",
            text: "DaemonSet rollouts (`kubectl rollout history ds -n kube-system`), EC2NodeClass or node group changes, security group or NACL changes in CloudTrail."
          }
        ]
      },
      {
        title: "Mitigate",
        hint: null,
        items: [
          {
            title: "One node",
            text: "cordon it so nothing new lands there; if pods matter now, drain it.",
            run: [
              "kubectl cordon <node>",
              "kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --timeout=5m"
            ]
          },
          {
            title: "Instance gone",
            text: "delete the Node object so pods are rescheduled immediately: `kubectl delete node <node>`."
          },
          {
            title: "Stateful pods stuck on a dead node",
            text: "confirm the instance is stopped, then `kubectl taint node <node> node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` to release volumes."
          },
          {
            title: "Many nodes from one change",
            text: "revert the change (DaemonSet, AMI pin, security group) before investigating further."
          }
        ]
      },
      {
        title: "Resolve",
        hint: null,
        items: [
          {
            text: "Let Karpenter or the node group replace the instance. For kubelet or runtime crashes, restart them (`sudo systemctl restart containerd kubelet`) only to restore service; capture logs first and fix the cause (disk, memory reservation, configuration)."
          }
        ]
      },
      {
        title: "Verify",
        hint: null,
        items: [
          {
            run: [
              "kubectl get nodes",
              "kubectl get pods -A -o wide --field-selector spec.nodeName=<replacement-node> | head",
              "kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded"
            ]
          },
          {
            text: "All nodes Ready, displaced pods Running elsewhere, no pods left `Terminating` on the old node."
          }
        ]
      },
      {
        title: "Escalate",
        hint: null,
        items: [
          {
            text: "Page the platform lead if more than 20% of nodes are affected, if replacements also fail, or if an AZ-wide AWS event is suspected (open an AWS support case with instance IDs and times)."
          }
        ]
      },
      {
        title: "Follow up",
        hint: null,
        items: [
          {
            text: "Record the cause. Repeated single-node failures of one instance type or AMI deserve a ticket; repeated pressure evictions mean requests are wrong somewhere."
          }
        ]
      }
    ]
  },
  {
    id: "load-balancer-5xx",
    title: "Load balancer 5xx",
    trigger: "`ALBTarget5xxHigh`, `ALBUnhealthyTargets`, `ServiceWithoutEndpoints`, or an SLO burn alert for a service behind an ALB or NLB.",
    impact: "users see errors directly. Who generated the error decides where to look.",
    phases: [
      {
        title: "Triage",
        hint: "5 minutes",
        items: [
          { text: "Which component produced the 5xx?" },
          {
            when: "`HTTPCode_Target_5XX_Count`",
            then: "the app returned 5xx: application or dependency problem",
            to: []
          },
          {
            when: "`HTTPCode_ELB_503_Count`, body from `awselb`",
            then: "no healthy targets: [alb-targets-unhealthy](#/failures/alb-targets-unhealthy), [service-no-endpoints](#/failures/service-no-endpoints)",
            to: ["alb-targets-unhealthy", "service-no-endpoints"]
          },
          {
            when: "`HTTPCode_ELB_502_Count`",
            then: "the target closed or reset the connection: [alb-5xx-during-deploys](#/failures/alb-5xx-during-deploys)",
            to: ["alb-5xx-during-deploys"]
          },
          {
            when: "`HTTPCode_ELB_504_Count`",
            then: "the target did not answer within the idle timeout: slow app or dependency",
            to: []
          },
          {
            when: "no ADDRESS on the Ingress / `<pending>`",
            then: "[ingress-no-address](#/failures/ingress-no-address), [loadbalancer-pending](#/failures/loadbalancer-pending)",
            to: ["ingress-no-address", "loadbalancer-pending"],
            run: [
              "kubectl get ingress,svc -n <ns>",
              "kubectl get targetgroupbindings -n <ns>",
              "aws elbv2 describe-target-health --target-group-arn <tg-arn> \\",
              "  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State,TargetHealth.Reason]' --output table"
            ]
          }
        ]
      },
      {
        title: "Diagnose",
        hint: null,
        items: [
          {
            title: "Targets unhealthy?",
            text: "Read the reason (`Target.Timeout`, `Target.ResponseCodeMismatch`) and compare the health check path with the readiness probe."
          },
          {
            title: "Endpoints empty?",
            text: "Unready pods: [readiness-probe-failing](#/failures/readiness-probe-failing). No matching pods: selector mismatch.",
            run: [
              "kubectl get endpointslices -n <ns> -l kubernetes.io/service-name=<svc> -o wide",
              "kubectl get pods -n <ns> -l <selector> -o wide"
            ]
          },
          {
            title: "Correlated with deploys or scale-in?",
            text: "Compare 5xx minutes with `kubectl get events -n <ns> --field-selector reason=Killing` and rollout times."
          },
          {
            title: "Target 5xx?",
            text: "Read application logs and traces for the failing route; check dependencies."
          }
        ]
      },
      {
        title: "Mitigate",
        hint: null,
        items: [
          { text: "Bad deploy: `kubectl rollout undo deployment/<name> -n <ns>`." },
          {
            text: "Too few healthy targets: scale out; if a readiness check on a shared dependency removed everything, consider temporarily relaxing it."
          },
          {
            text: "502s at every deploy: pause deploys of that service until graceful shutdown is fixed."
          },
          {
            text: "Controller not reconciling: check `kubectl logs -n kube-system deploy/aws-load-balancer-controller`; restart it if wedged."
          }
        ]
      },
      {
        title: "Resolve",
        hint: null,
        items: [
          {
            text: "Align health checks with readiness; fix selectors and ports; add `preStop` delay, SIGTERM handling and keep-alive settings; enable pod readiness gates on the namespace."
          }
        ]
      },
      {
        title: "Verify",
        hint: null,
        items: [
          {
            text: "ELB 5xx back to baseline, all targets healthy, a test rollout with synthetic traffic produces no errors."
          }
        ]
      },
      {
        title: "Escalate",
        hint: null,
        items: [
          {
            text: "SEV1 if checkout or order placement is affected for more than 5 minutes; involve the owning service team for target 5xx."
          }
        ]
      },
      {
        title: "Follow up",
        hint: null,
        items: [
          {
            text: "Make graceful shutdown and health check settings part of the service template; add a synthetic check through the ALB."
          }
        ]
      }
    ]
  },
  {
    id: "dns-degraded",
    title: "DNS degraded",
    trigger: "`CoreDNSLatencyHigh` (p99 above 100 ms), `CoreDNSErrorsHigh` (SERVFAIL rate), or many services logging `i/o timeout` or `no such host` at once.",
    impact: "DNS sits under every connection. Degradation shows up as timeouts and 5-second latency spikes across unrelated services, often SEV1 in effect even when the cluster looks healthy.",
    phases: [
      {
        title: "Triage",
        hint: "5 minutes",
        items: [
          {
            run: [
              "kubectl get deploy coredns -n kube-system",
              "kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide",
              "kubectl top pods -n kube-system -l k8s-app=kube-dns",
              "kubectl logs -n kube-system -l k8s-app=kube-dns --tail=100 | grep -E \"ERROR|timeout|SERVFAIL\"",
              "tools/dns-check.sh <affected-namespace>"
            ]
          },
          {
            when: "one name fails with `NXDOMAIN`, others fine",
            then: "wrong name or namespace: [dns-nxdomain](#/failures/dns-nxdomain)",
            to: ["dns-nxdomain"]
          },
          {
            when: "CoreDNS logs `i/o timeout` to the VPC resolver (`.2` address)",
            then: "upstream drops: link-local allowance, VPC resolver limits: [dns-timeouts](#/failures/dns-timeouts)",
            to: ["dns-timeouts"]
          },
          {
            when: "CoreDNS pods at their CPU limit or few replicas",
            then: "CoreDNS saturated",
            to: []
          },
          {
            when: "CoreDNS pods not running or not ready",
            then: "scheduling, node or configuration problem",
            to: []
          },
          {
            when: "failures only from pods in some namespaces",
            then: "NetworkPolicy blocking UDP/TCP 53: [connection-timeouts](#/failures/connection-timeouts)",
            to: ["connection-timeouts"]
          }
        ]
      },
      {
        title: "Diagnose",
        hint: null,
        items: [
          {
            title: "Allowance drops on CoreDNS nodes",
            run: [
              "for n in $(kubectl get pods -n kube-system -l k8s-app=kube-dns -o jsonpath='{.items[*].spec.nodeName}'); do",
              "  echo \"$n\"; kubectl debug node/\"$n\" -q -it --image=nicolaka/netshoot -- ethtool -S eth0 | grep allowance_exceeded",
              "done"
            ]
          },
          {
            title: "Query volume and amplification",
            text: "compare `coredns_dns_requests_total` with last week; check `NXDOMAIN` share; inspect `resolv.conf` of the noisiest clients."
          },
          {
            title: "Recent changes",
            text: "CoreDNS configuration (`kubectl get cm coredns coredns-custom -n kube-system -o yaml`), add-on version, NetworkPolicies, a new high-volume workload."
          }
        ]
      },
      {
        title: "Mitigate",
        hint: null,
        items: [
          {
            text: "Scale CoreDNS out and spread it: (On the managed add-on, prefer enabling its autoscaling configuration; manual scaling may be reverted.)",
            run: "kubectl scale deploy coredns -n kube-system --replicas=6"
          },
          {
            text: "If replicas share a node, delete one pod at a time so they reschedule elsewhere (check topology spread or anti-affinity first)."
          },
          { text: "Remove or raise CPU limits on CoreDNS if throttled." },
          {
            text: "Restore a known-good Corefile if a configuration change preceded the incident."
          }
        ]
      },
      {
        title: "Resolve",
        hint: null,
        items: [
          {
            text: "Deploy NodeLocal DNSCache; set topology spread on CoreDNS; reduce amplification in the noisiest workloads (FQDNs with trailing dots, `ndots: 2`); fix NetworkPolicies to allow DNS."
          }
        ]
      },
      {
        title: "Verify",
        hint: null,
        items: [
          {
            text: "CoreDNS p99 below 50 ms, SERVFAIL near zero, allowance counters flat, client error rates back to baseline."
          }
        ]
      },
      {
        title: "Escalate",
        hint: null,
        items: [
          {
            text: "Page the platform lead if scaling CoreDNS does not help within 15 minutes, or if the VPC resolver itself appears degraded (AWS support case, include ENI IDs and timestamps)."
          }
        ]
      },
      {
        title: "Follow up",
        hint: null,
        items: [
          {
            text: "Track DNS queries per pod per service; add the allowance counters to node monitoring if they are not exported yet."
          }
        ]
      }
    ]
  },
  {
    id: "api-server-degraded",
    title: "API server degraded",
    trigger: "`KubeAPIErrorsHigh`, `KubeAPILatencyHigh`, `KubeAPIPriorityAndFairnessRejecting`, `AdmissionWebhookSlow`, `AggregatedAPIUnavailable`, or many teams reporting failing `kubectl` and deploys.",
    impact: "running workloads continue (static stability), but deploys, scaling, self-healing and controllers are impaired. Becomes urgent if a peak or a failure needs the control plane to react.",
    phases: [
      {
        title: "Triage",
        hint: "5 minutes",
        items: [
          { text: "What kind of failure?" },
          {
            when: "`failed calling webhook`",
            then: "[webhook-unavailable](#/failures/webhook-unavailable)",
            to: ["webhook-unavailable"]
          },
          {
            when: "`TooManyRequests`, slow `LIST` calls",
            then: "[api-throttling](#/failures/api-throttling)",
            to: ["api-throttling"]
          },
          {
            when: "`unable to retrieve the complete list of server APIs`",
            then: "[apiservice-unavailable](#/failures/apiservice-unavailable)",
            to: ["apiservice-unavailable"]
          },
          {
            when: "`etcdserver: ...` errors",
            then: "[etcd-space-exceeded](#/failures/etcd-space-exceeded); on EKS, also open an AWS support case",
            to: ["etcd-space-exceeded"]
          },
          {
            when: "`Unauthorized` for everyone",
            then: "[kubectl-unauthorized](#/failures/kubectl-unauthorized)",
            to: ["kubectl-unauthorized"]
          },
          {
            when: "timeouts connecting at all",
            then: "endpoint access, network path, or an EKS-side issue: check AWS Health",
            to: [],
            run: [
              "kubectl get --raw='/readyz?verbose' | tail -20",
              "kubectl get apiservices | grep -v True",
              "kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations",
              "aws eks describe-cluster --name <cluster> --query 'cluster.[status,health]'"
            ]
          }
        ]
      },
      {
        title: "Diagnose",
        hint: null,
        items: [
          {
            title: "Webhooks",
            text: "which webhook, where does it point, are its pods ready?",
            run: "kubectl get --raw /metrics | grep apiserver_admission_webhook_admission_duration_seconds_sum | sort -t' ' -k2 -nr | head"
          },
          {
            title: "Load",
            text: "which priority levels reject, which clients call most (audit log query in [chapter 12](#/operations/observe))."
          },
          {
            title: "Object bloat",
            run: "kubectl get --raw /metrics | grep '^apiserver_storage_objects' | sort -t' ' -k2 -nr | head"
          },
          {
            title: "Recent change",
            text: "a new operator or controller, a new webhook, an add-on upgrade, a CI job polling in a loop."
          }
        ]
      },
      {
        title: "Mitigate",
        hint: null,
        items: [
          {
            title: "Webhook down",
            text: "restore its pods (capacity, node selector, crash). If that will take long and the webhook is not security-critical, set `failurePolicy: Ignore` or delete the configuration temporarily; record it."
          },
          {
            title: "Noisy client",
            text: "scale its Deployment to zero, or suspend the CI job, then reduce its rate."
          },
          { title: "Orphaned APIService", text: "delete it if its add-on is gone." },
          {
            title: "Object bloat",
            text: "delete old Helm release Secrets (`helm history` then trim), completed Jobs, and stale custom resources."
          }
        ]
      },
      {
        title: "Resolve",
        hint: null,
        items: [
          {
            text: "Fix the noisy client (informers, sensible resync), scope and harden webhooks (replicas, PDB, short timeout, namespace selectors), give important controllers their own FlowSchema, and set retention for Helm history and Jobs."
          }
        ]
      },
      {
        title: "Verify",
        hint: null,
        items: [
          {
            text: "API p99 latency back to baseline, no Priority and Fairness rejections, APIServices all `True`, deploys succeed."
          }
        ]
      },
      {
        title: "Escalate",
        hint: null,
        items: [
          {
            text: "Open an AWS support case (severity matching impact) for errors originating in the managed control plane (`etcdserver` errors, 5xx not explained by webhooks or load). Page the platform lead for any cluster-wide write failure."
          }
        ]
      },
      {
        title: "Follow up",
        hint: null,
        items: [
          {
            text: "Review admission webhooks and new controllers as part of change review; alert on webhook latency and APIService availability."
          }
        ]
      }
    ]
  },
  {
    id: "pod-ip-exhaustion",
    title: "Pod IP exhaustion",
    trigger: "`SubnetFreeAddressesLow` (a cluster subnet below 10% free), `FailedCreatePodSandBox` with `failed to assign an IP address to container`, or Karpenter `InsufficientFreeAddressesInSubnet`.",
    impact: "new pods cannot start in the affected subnets or AZ; node launches fail. Existing pods are unaffected. Becomes SEV1 if a rollout or peak needs new pods.",
    phases: [
      {
        title: "Triage",
        hint: "5 minutes",
        items: [
          {
            run: [
              "aws ec2 describe-subnets --filters Name=tag:karpenter.sh/discovery,Values=<cluster> \\",
              "  --query 'Subnets[].[SubnetId,AvailabilityZone,CidrBlock,AvailableIpAddressCount]' --output table",
              "kubectl get events -A --field-selector reason=FailedCreatePodSandBox --sort-by=.lastTimestamp | tail -5"
            ]
          },
          {
            text: "Confirm which subnets and AZs are short. Compare with your pod subnets if you use custom networking (`kubectl get eniconfigs -o yaml`)."
          }
        ]
      },
      {
        title: "Diagnose",
        hint: null,
        items: [
          {
            title: "Who holds the addresses?",
            text: "Pods, warm pools, nodes, load balancers, VPC endpoints.",
            run: [
              "kubectl get pods -A -o wide --no-headers | wc -l",
              "kubectl get ds aws-node -n kube-system -o jsonpath='{.spec.template.spec.containers[0].env}' | \\",
              "  jq '.[] | select(.name|test(\"WARM|MINIMUM|PREFIX|CUSTOM\"))'",
              "aws ec2 describe-network-interfaces --filters Name=subnet-id,Values=<subnet-id> \\",
              "  --query 'NetworkInterfaces[].[InterfaceType,Description]' --output text | sort | uniq -c | sort -rn | head"
            ]
          },
          {
            title: "Exhaustion or fragmentation?",
            text: "With prefix delegation, `InsufficientCidrBlocks` despite free addresses means no contiguous `/28` blocks remain."
          },
          {
            title: "Why now?",
            text: "A new workload, a scale-out, a change to warm pool settings, or nodes with many unused prefixes after a scale-down."
          },
          { text: "See [pod-ip-exhaustion](#/failures/pod-ip-exhaustion) for the mechanism." }
        ]
      },
      {
        title: "Mitigate",
        hint: null,
        items: [
          {
            text: "Reduce warm pools, which frees addresses on existing nodes within minutes: On the managed add-on, prefer changing configuration values through `aws eks update-addon` so the change persists.",
            run: [
              "kubectl set env ds/aws-node -n kube-system -c aws-node WARM_IP_TARGET=5 MINIMUM_IP_TARGET=10",
              "# with prefix delegation: WARM_PREFIX_TARGET=1 (and no WARM_IP_TARGET)"
            ]
          },
          {
            text: "Steer new nodes toward subnets with room (temporarily narrow the EC2NodeClass subnet selector or the NodePool zones), if zone balance allows."
          },
          { text: "Scale down non-critical workloads in the affected AZ." }
        ]
      },
      {
        title: "Resolve",
        hint: null,
        items: [
          {
            text: "Add address space: associate a secondary CIDR (for example `100.64.0.0/16`), create large pod subnets per AZ, enable custom networking with one `ENIConfig` per AZ, and roll nodes. With prefix delegation, create subnet CIDR reservations so `/28` blocks stay contiguous. See [chapter 6](#/eks?layer=networking)."
          }
        ]
      },
      {
        title: "Verify",
        hint: null,
        items: [
          {
            text: "Free addresses back above 20% in every cluster subnet; no new `FailedCreatePodSandBox` events; Karpenter launches succeed."
          }
        ]
      },
      {
        title: "Escalate",
        hint: null,
        items: [
          {
            text: "Page the platform lead if all AZs are affected or a peak is imminent. Network team involvement is needed for new CIDRs if address space is centrally managed."
          }
        ]
      },
      {
        title: "Follow up",
        hint: null,
        items: [
          {
            text: "Add IP capacity to the monthly capacity review; alert at 20% free (ticket) and 10% (page)."
          }
        ]
      }
    ]
  },
  {
    id: "certificate-expiry",
    title: "Certificate expiry",
    trigger: "`CertificateExpiringSoon` (under 21 days: ticket; under 7 days: page), `CertificateNotReady`, or `x509` errors appearing at a precise time.",
    impact: "at expiry, every client that validates the certificate fails at once: an ingress (users see browser errors), a webhook (cluster writes fail), or service-to-service TLS.",
    phases: [
      {
        title: "Triage",
        hint: "5 minutes",
        items: [
          {
            run: [
              "kubectl get certificates -A",
              "kubectl get certificates -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{\"\\t\"}{.status.notAfter}{\"\\t\"}{.status.conditions[?(@.type==\"Ready\")].status}{\"\\n\"}{end}' | sort -k2"
            ]
          },
          {
            text: "For an external endpoint:",
            run: "openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -dates -issuer -ext subjectAltName"
          },
          {
            text: "Identify what the certificate protects and who validates it. See [x509-certificate-errors](#/failures/x509-certificate-errors)."
          }
        ]
      },
      {
        title: "Diagnose",
        hint: null,
        items: [
          {
            title: "Cert-manager certificates",
            text: "follow the chain to the failing step. Typical failures: an HTTP01 challenge unreachable through the ALB, a DNS01 Route 53 permission error (the cert-manager role), an ACME rate limit, an issuer pointing at a deleted secret.",
            run: [
              "kubectl describe certificate <name> -n <ns> | sed -n '/Status/,$p'",
              "kubectl get certificaterequest,order,challenge -n <ns>",
              "kubectl logs -n cert-manager deploy/cert-manager --tail=100 | grep -i <name>"
            ]
          },
          {
            title: "Webhook certificates",
            text: "compare the configuration's `caBundle` with the serving certificate's issuer; check the CA injector (`cainjector`) is running."
          },
          {
            title: "ACM certificates on load balancers",
            text: "check validation status and renewal eligibility in ACM (DNS validation records still present)."
          }
        ]
      },
      {
        title: "Mitigate",
        hint: null,
        items: [
          {
            text: "Trigger renewal once the cause is fixed: `cmctl renew <name> -n <ns>` (or delete the Certificate's Secret to force reissue, accepting a short gap)."
          },
          {
            text: "For a webhook with an expired certificate blocking the cluster, set `failurePolicy: Ignore` temporarily while reissuing."
          },
          {
            text: "For an imminent external expiry with a broken pipeline, import a manually issued certificate as a stopgap and record it for removal."
          }
        ]
      },
      {
        title: "Resolve",
        hint: null,
        items: [
          {
            text: "Fix the issuance path permanently (permissions, challenge routing, DNS records) and confirm the next renewal will be automatic: cert-manager renews at two thirds of the lifetime by default."
          }
        ]
      },
      {
        title: "Verify",
        hint: null,
        items: [
          {
            text: "`Ready=True`, `notAfter` in the future, clients connecting without errors, and the CA bundle injected where needed."
          }
        ]
      },
      {
        title: "Escalate",
        hint: null,
        items: [
          {
            text: "Page if expiry is under 24 hours away and renewal is still failing, or if a production endpoint is already serving an expired certificate."
          }
        ]
      },
      {
        title: "Follow up",
        hint: null,
        items: [
          {
            text: "Every certificate must be monitored: add blackbox probes for externally served certificates not managed by cert-manager."
          }
        ]
      }
    ]
  },
  {
    id: "cluster-upgrade",
    title: "EKS cluster upgrade",
    trigger: "planned work, roughly every four months, at least 60 days before the current version leaves standard support.",
    impact: "none for users. Risks: removed APIs breaking deploys, add-on incompatibility, node rollouts blocked by PDBs or lacking capacity.",
    phases: [
      {
        title: "Before",
        hint: "one to two weeks ahead",
        items: [
          {
            title: "Read",
            text: "the Kubernetes release notes and the EKS version notes for the target version."
          },
          {
            title: "Check upgrade insights and deprecated API use",
            text: "Fix every finding ([deprecated-api-removed](#/failures/deprecated-api-removed)).",
            run: [
              "aws eks list-insights --cluster-name <cluster> --filter categories=UPGRADE_READINESS",
              "kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis",
              "pluto detect-helm --target-versions k8s=<target-version>"
            ]
          },
          {
            title: "Check add-on compatibility",
            text: "Also check Helm-installed components (Karpenter, AWS Load Balancer Controller, cert-manager, metrics-server) against the target version.",
            run: [
              "for a in $(aws eks list-addons --cluster-name <cluster> --query 'addons[]' --output text); do",
              "  echo \"$a: $(aws eks describe-addon --cluster-name <cluster> --addon-name \"$a\" --query addon.addonVersion --output text)\"",
              "  aws eks describe-addon-versions --addon-name \"$a\" --kubernetes-version <target-version> \\",
              "    --query 'addons[0].addonVersions[0].addonVersion' --output text",
              "done"
            ]
          },
          {
            title: "Check PDBs and capacity",
            text: "no PDB allows zero disruptions; enough headroom to drain one node per pool.",
            run: "kubectl get pdb -A -o jsonpath='{range .items[?(@.status.disruptionsAllowed==0)]}{.metadata.namespace}/{.metadata.name}{\"\\n\"}{end}'"
          },
          {
            title: "Upgrade staging",
            text: "with this same runbook, then soak for at least a few days of normal traffic and deploys."
          }
        ]
      },
      {
        title: "During",
        hint: "production, in a change window",
        items: [
          { title: "Snapshot", text: "the cluster state for reference: `tools/snapshot.sh`." },
          {
            title: "Upgrade the control plane",
            text: "(one minor version): Typically 10 to 20 minutes; the API stays available.",
            run: [
              "aws eks update-cluster-version --name <cluster> --kubernetes-version <target-version>",
              "aws eks describe-update --name <cluster> --update-id <id>    # repeat until Successful"
            ]
          },
          {
            title: "Update EKS add-ons",
            text: "to versions for the new release, one at a time, VPC CNI first: Watch each roll out (`kubectl rollout status ds/aws-node -n kube-system`) before the next.",
            run: "aws eks update-addon --cluster-name <cluster> --addon-name vpc-cni --addon-version <version> --resolve-conflicts PRESERVE"
          },
          {
            title: "Roll the data plane",
            text: "- managed node groups: `aws eks update-nodegroup-version --cluster-name <cluster> --nodegroup-name <ng>`; - Karpenter: update the AMI alias in the EC2NodeClass to one for the new version; drift replaces nodes within the NodePool's disruption budgets.",
            run: "kubectl get nodes -L karpenter.sh/nodepool -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion | sort -k2"
          },
          { title: "Update tooling and charts", text: "that pin client versions." }
        ]
      },
      {
        title: "If something goes wrong",
        hint: null,
        items: [
          {
            when: "deploys fail with `no matches for kind`",
            then: "[deprecated-api-removed](#/failures/deprecated-api-removed)",
            to: ["deprecated-api-removed"]
          },
          {
            when: "node group update stuck with `PodEvictionFailure`",
            then: "[drain-blocked-by-pdb](#/failures/drain-blocked-by-pdb)",
            to: ["drain-blocked-by-pdb"]
          },
          {
            when: "new nodes do not join",
            then: "[eks-node-join-failure](#/failures/eks-node-join-failure)",
            to: ["eks-node-join-failure"]
          },
          {
            when: "pods pending during the roll",
            then: "[pending-pods-capacity](#/operations/runbooks/pending-pods-capacity)",
            to: ["runbook:pending-pods-capacity"]
          },
          {
            when: "add-on update `ConfigurationConflict`",
            then: "compare your configuration values with the new version's schema; use `--resolve-conflicts PRESERVE` or update the values",
            to: []
          },
          {
            text: "The control plane cannot be downgraded. For a failed data plane roll, pin the previous AMI and let nodes drift back while you investigate."
          }
        ]
      },
      {
        title: "Verify",
        hint: null,
        items: [
          {
            run: [
              "kubectl version",
              "kubectl get nodes -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion",
              "kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded",
              "aws eks list-insights --cluster-name <cluster>"
            ]
          },
          {
            text: "All nodes on the new version, add-ons `ACTIVE`, no failing pods, a test deploy through the normal pipeline succeeds."
          }
        ]
      },
      {
        title: "Follow up",
        hint: null,
        items: [
          {
            text: "Record the time taken and any surprises; update this runbook. Schedule the next upgrade."
          }
        ]
      }
    ]
  }
]);
