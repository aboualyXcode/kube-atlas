// "What are you seeing?" Each symptom fans out to the failures that produce it. `tell` is the
// message or check that tells the causes apart; `label` overrides the failure title when one
// entry covers several distinct causes. Every failure must appear in at least one fan.
KA.define("triage", [
  // ---------------------------------------------------------------- pod won't start
  {
    id: "pending", group: "The pod won't start", label: "Pod stays Pending",
    see: "kubectl get pods shows Pending for more than a minute.",
    check: "kubectl describe pod <pod> -n <ns> | sed -n '/Events/,$p'",
    causes: [
      { id: "pending-insufficient-resources", tell: "Insufficient cpu, Insufficient memory, Too many pods" },
      { id: "pending-taint-affinity", tell: "untolerated taint, didn't match node affinity" },
      { id: "volume-node-affinity-conflict", tell: "volume node affinity conflict" },
      { id: "pending-unbound-pvc", tell: "unbound immediate PersistentVolumeClaims" },
      { id: "karpenter-not-provisioning", tell: "Insufficient cpu, yet no new NodeClaim" },
      { id: "cluster-autoscaler-no-scale-up", tell: "pod didn't trigger scale-up" },
    ],
  },
  {
    id: "container-creating", group: "The pod won't start", label: "Stuck in ContainerCreating",
    see: "The pod is scheduled but never reaches Running.",
    check: "kubectl describe pod <pod> -n <ns> | sed -n '/Events/,$p'",
    causes: [
      { id: "pod-ip-exhaustion", tell: "failed to assign an IP address to container" },
      { id: "cni-not-ready", tell: "network plugin not ready: cni plugin not initialized" },
      { id: "volume-attach-failed", tell: "FailedAttachVolume, AttachVolume.Attach failed" },
      { id: "multi-attach-error", tell: "Multi-Attach error for volume" },
      { id: "efs-mount-timeout", tell: "mount.nfs4: Connection timed out" },
    ],
  },
  {
    id: "image-pull", group: "The pod won't start", label: "ErrImagePull or ImagePullBackOff",
    see: "The image never arrives on the node.",
    check: "kubectl describe pod <pod> -n <ns> | grep -A3 -i 'failed to pull'",
    causes: [
      { id: "imagepullbackoff", label: "Wrong image name or tag", tell: "not found, manifest unknown" },
      { id: "imagepullbackoff", label: "The registry refuses the node", tell: "403 Forbidden, no basic auth credentials" },
      { id: "imagepullbackoff", label: "No network path to the registry", tell: "dial tcp ... i/o timeout" },
    ],
  },
  {
    id: "config-error", group: "The pod won't start", label: "CreateContainerConfigError",
    see: "The image is there, but the container is never created.",
    check: "kubectl describe pod <pod> -n <ns> | grep -i -A2 configerror",
    causes: [
      { id: "createcontainerconfigerror", label: "A Secret or ConfigMap is missing", tell: "secret \"orders-db\" not found" },
      { id: "createcontainerconfigerror", label: "A key is missing", tell: "couldn't find key DB_URL in Secret" },
    ],
  },
  {
    id: "crashloop", group: "The pod won't start", label: "CrashLoopBackOff",
    see: "The restart count climbs and the pod is never Ready.",
    check: "kubectl describe pod <pod> -n <ns> | grep -A6 'Last State'",
    causes: [
      { id: "oomkilled", tell: "Last State: OOMKilled, Exit Code: 137" },
      { id: "liveness-probe-restarts", tell: "Liveness probe failed ... will be restarted" },
      { id: "exec-format-error", tell: "exec format error" },
      { id: "crashloopbackoff", label: "The app exits on its own", tell: "Exit Code: 1, read logs --previous" },
      { id: "connection-timeouts", tell: "a dependency times out at startup" },
      { id: "dns-nxdomain", tell: "no such host at startup" },
    ],
  },

  // ---------------------------------------------------------------- runs but misbehaves
  {
    id: "not-ready", group: "The pod runs, but…", label: "Running, but 0/1 Ready",
    see: "The pod runs and receives no traffic.",
    check: "kubectl describe pod <pod> -n <ns> | grep -i -A2 readiness",
    causes: [
      { id: "readiness-probe-failing", tell: "Readiness probe failed: statuscode: 503" },
      { id: "connection-timeouts", tell: "readiness checks a dependency that times out" },
      { id: "alb-targets-unhealthy", tell: "readiness gate waits for a healthy ALB target" },
    ],
  },
  {
    id: "evicted", group: "The pod runs, but…", label: "Evicted, or stuck Terminating",
    see: "Pods disappear, or never finish deleting.",
    check: "kubectl get pods -A | grep -E 'Evicted|Terminating'",
    causes: [
      { id: "node-pressure-eviction", tell: "The node was low on resource: memory" },
      { id: "pod-stuck-terminating", tell: "Terminating for minutes: finalizers or unmount" },
      { id: "node-not-ready", tell: "the node itself is NotReady" },
    ],
  },
  {
    id: "replicas-missing", group: "The pod runs, but…", label: "Replicas missing, nothing to describe",
    see: "The Deployment has fewer pods than desired and none are Pending.",
    check: "kubectl describe rs -n <ns> -l app=<app> | grep -A3 FailedCreate",
    causes: [
      { id: "resource-quota-exceeded", tell: "exceeded quota, must specify limits" },
      { id: "webhook-unavailable", tell: "failed calling webhook" },
      { id: "rollout-stuck", tell: "ProgressDeadlineExceeded" },
    ],
  },

  // ---------------------------------------------------------------- traffic and latency
  {
    id: "lb-5xx", group: "Traffic and latency", label: "502, 503 or 504 from the load balancer",
    see: "Users get errors from the ALB.",
    check: "aws elbv2 describe-target-health --target-group-arn <arn> --output table",
    causes: [
      { id: "alb-targets-unhealthy", tell: "Target.ResponseCodeMismatch, Target.Timeout" },
      { id: "readiness-probe-failing", tell: "targets unhealthy because pods are not Ready" },
      { id: "service-no-endpoints", tell: "Endpoints: <none>" },
      { id: "alb-5xx-during-deploys", tell: "502s only during deploys and scale-in" },
    ],
  },
  {
    id: "slow", group: "Traffic and latency", label: "Slow, but no errors",
    see: "Latency climbs and nothing in the logs says error.",
    check: "# PromQL: CPU throttling ratio and CoreDNS p99 latency",
    causes: [
      { id: "cpu-throttling", tell: "container_cpu_cfs_throttled_periods_total climbing" },
      { id: "dns-timeouts", tell: "stalls of almost exactly 5 s" },
    ],
  },
  {
    id: "dependency", group: "Traffic and latency", label: "Timeouts or 'no such host' from the app",
    see: "Calls to other services, the database or AWS fail from inside the pod.",
    check: "kubectl exec -n <ns> <pod> -- nslookup <host>; kubectl exec -n <ns> <pod> -- nc -vz -w3 <host> <port>",
    causes: [
      { id: "connection-timeouts", tell: "dial tcp ... i/o timeout" },
      { id: "dns-nxdomain", tell: "lookup ... no such host, answered fast" },
      { id: "dns-timeouts", tell: "lookup ... i/o timeout, answered slowly" },
    ],
  },

  // ---------------------------------------------------------------- nodes and the cluster
  {
    id: "nodes", group: "Nodes and the cluster", label: "Nodes NotReady, or not joining",
    see: "kubectl get nodes shows NotReady, or new instances never appear as nodes.",
    check: "kubectl describe node <node> | sed -n '/Conditions/,/Addresses/p'",
    causes: [
      { id: "node-not-ready", tell: "Kubelet stopped posting node status" },
      { id: "cni-not-ready", tell: "NetworkReady=false" },
      { id: "node-pressure-eviction", tell: "MemoryPressure or DiskPressure True" },
      { id: "eks-node-join-failure", tell: "instances running, no Node objects" },
    ],
  },
  {
    id: "api-errors", group: "Nodes and the cluster", label: "kubectl and deploys fail with API errors",
    see: "Requests to the API server are rejected.",
    check: "kubectl get --raw='/readyz?verbose' | tail",
    causes: [
      { id: "kubectl-unauthorized", tell: "Unauthorized (401)" },
      { id: "rbac-forbidden", tell: "Forbidden (403)" },
      { id: "x509-certificate-errors", tell: "x509: certificate has expired" },
      { id: "webhook-unavailable", tell: "failed calling webhook" },
      { id: "api-throttling", tell: "429 Too Many Requests" },
      { id: "deprecated-api-removed", tell: "no matches for kind" },
      { id: "etcd-space-exceeded", tell: "etcdserver: mvcc: database space exceeded" },
      { id: "apiservice-unavailable", tell: "unable to retrieve the complete list of server APIs" },
    ],
  },
  {
    id: "scaling", group: "Nodes and the cluster", label: "Autoscaling does not happen",
    see: "The HPA stays flat, nodes never arrive, or drains never finish.",
    check: "kubectl get hpa -A; kubectl get nodeclaims",
    causes: [
      { id: "hpa-unknown-metrics", tell: "TARGETS <unknown>/70%" },
      { id: "karpenter-not-provisioning", tell: "could not schedule pod, InsufficientCapacity" },
      { id: "cluster-autoscaler-no-scale-up", tell: "NotTriggerScaleUp" },
      { id: "drain-blocked-by-pdb", tell: "Cannot evict pod as it would violate the pod's disruption budget" },
    ],
  },

  // ---------------------------------------------------------------- AWS integrations
  {
    id: "access-denied", group: "AWS integrations", label: "AccessDenied from AWS",
    see: "The app's AWS SDK calls are refused.",
    check: "kubectl exec -n <ns> <pod> -- aws sts get-caller-identity",
    causes: [
      { id: "pod-aws-access-denied", label: "The pod uses the node role", tell: "assumed-role/<node-role>/i-0abc is not authorized" },
      { id: "pod-aws-access-denied", label: "The role lacks the permission", tell: "assumed-role/<app-role>/... is not authorized" },
    ],
  },
  {
    id: "no-address", group: "AWS integrations", label: "Ingress or Service has no address",
    see: "ADDRESS stays empty, or EXTERNAL-IP stays <pending>.",
    check: "kubectl describe ingress <name> -n <ns> | sed -n '/Events/,$p'",
    causes: [
      { id: "ingress-no-address", tell: "FailedBuildModel, FailedDeployModel" },
      { id: "loadbalancer-pending", tell: "EXTERNAL-IP <pending>" },
    ],
  },
  {
    id: "storage", group: "AWS integrations", label: "Volumes won't provision, attach or mount",
    see: "A claim stays Pending, or a volume never reaches the pod.",
    check: "kubectl describe pvc <pvc> -n <ns>; kubectl get volumeattachments",
    causes: [
      { id: "pvc-pending-provisioning", tell: "ProvisioningFailed" },
      { id: "pending-unbound-pvc", tell: "the pod waits on an unbound claim" },
      { id: "volume-attach-failed", tell: "FailedAttachVolume" },
      { id: "multi-attach-error", tell: "Multi-Attach error" },
      { id: "efs-mount-timeout", tell: "mount.nfs4: Connection timed out" },
      { id: "volume-node-affinity-conflict", tell: "volume node affinity conflict" },
    ],
  },
]);
