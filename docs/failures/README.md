<!-- Generated from data/failures/ by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Failure catalog

45 failures across 10 layers. Each has a symptom, the affected component, the root cause, an investigation, a resolution and prevention, and a diagram of how it propagates. The [interactive atlas](../../index.html#/failures) animates each one on the map.

A **symptom** tells you where to look (`Pending`, `CrashLoopBackOff`, a 503). A **cause** names the mechanism (`OOMKilled`, `Insufficient cpu`, `x509`).

## Workload

The pod, its containers and configuration.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [CPU throttling](cpu-throttling.md) | cause | any | Your objects |
| [CrashLoopBackOff](crashloopbackoff.md) | symptom | any | Your pod |
| [CreateContainerConfigError](createcontainerconfigerror.md) | cause | any | Your objects |
| [exec format error](exec-format-error.md) | cause | EKS | ECR, Karpenter |
| [ImagePullBackOff / ErrImagePull](imagepullbackoff.md) | symptom | any | ECR, IAM & STS, VPC endpoints |
| [Liveness probe restarts healthy containers](liveness-probe-restarts.md) | cause | any | Your pod |
| [OOMKilled](oomkilled.md) | cause | any | Your pod |
| [Pod stuck in Terminating](pod-stuck-terminating.md) | symptom | any | Your objects, kubelet, CSI node plugin |
| [Readiness probe failing](readiness-probe-failing.md) | symptom | any | Your pod |
| [Rollout stuck](rollout-stuck.md) | symptom | any | Scheduler, kubelet, API server |

## Scheduling

Why a pod gets no node.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [Pending — Insufficient cpu, memory or pods](pending-insufficient-resources.md) | cause | any | Your objects |
| [Pending — untolerated taint, affinity or topology spread](pending-taint-affinity.md) | cause | any | Your objects |
| [Pending — pod has unbound immediate PersistentVolumeClaims](pending-unbound-pvc.md) | symptom | any | EBS CSI |
| [Pods never created — exceeded quota or LimitRange](resource-quota-exceeded.md) | cause | any | Your objects |

## Node

kubelet, runtime, network plugin, instance.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [Network plugin not ready](cni-not-ready.md) | cause | EKS | IAM & STS |
| [EKS nodes fail to join the cluster](eks-node-join-failure.md) | symptom | EKS | IAM & STS, Security groups, Subnet IPs |
| [Node NotReady](node-not-ready.md) | symptom | any | Instances, containerd, CNI plugin |
| [Evicted — node low on memory, disk or PIDs](node-pressure-eviction.md) | cause | any | Your pod |

## Networking

Paths, endpoints, admission calls.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [Connection timeouts between pods or to AWS services](connection-timeouts.md) | symptom | EKS | Security groups |
| [Pod IP exhaustion](pod-ip-exhaustion.md) | cause | EKS | Subnet IPs |
| [Service has no endpoints](service-no-endpoints.md) | symptom | any | Your objects, Your pod |
| [failed calling webhook](webhook-unavailable.md) | cause | any | API extensions |

## DNS

Names that do not resolve, or resolve slowly.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [DNS — no such host](dns-nxdomain.md) | cause | any | Your pod |
| [DNS timeouts and intermittent resolution failures](dns-timeouts.md) | cause | EKS | Your pod |

## Storage

Claims, volumes, attachments, mounts.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [EFS mount timeout](efs-mount-timeout.md) | cause | EKS | Security groups, Subnet IPs |
| [Multi-Attach error](multi-attach-error.md) | cause | any | kubelet |
| [PVC Pending — volume not provisioned](pvc-pending-provisioning.md) | symptom | EKS | IAM & STS, KMS |
| [AttachVolume or MountVolume failed](volume-attach-failed.md) | cause | EKS | IAM & STS, KMS, EC2 API |
| [volume node affinity conflict](volume-node-affinity-conflict.md) | cause | EKS | EBS volume |

## Autoscaling

Pods, nodes and drains.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [Cluster Autoscaler does not scale up](cluster-autoscaler-no-scale-up.md) | symptom | EKS | EC2 API, IAM & STS |
| [Node drain blocked by a PodDisruptionBudget](drain-blocked-by-pdb.md) | cause | any | Your objects |
| [HPA shows <unknown> and does not scale](hpa-unknown-metrics.md) | cause | any | metrics-server, Your objects |
| [Karpenter does not launch nodes](karpenter-not-provisioning.md) | symptom | EKS | IAM & STS, Subnet IPs, EC2 API |

## Identity

Who you are and what you may do.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [You must be logged in to the server](kubectl-unauthorized.md) | cause | EKS | IAM & STS |
| [AccessDenied from a pod calling AWS](pod-aws-access-denied.md) | cause | EKS | Your pod, IAM & STS |
| [Forbidden — RBAC denies the action](rbac-forbidden.md) | cause | any | Your objects |
| [x509 certificate errors](x509-certificate-errors.md) | cause | any | cert-manager |

## Load balancing

ALBs, NLBs and their targets.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [ALB 502 and 504 during deploys and scale-in](alb-5xx-during-deploys.md) | cause | EKS | Your pod |
| [ALB targets unhealthy](alb-targets-unhealthy.md) | symptom | EKS | Security groups, Your pod |
| [Ingress has no ADDRESS](ingress-no-address.md) | symptom | EKS | IAM & STS, Subnet IPs |
| [Service type LoadBalancer stuck in <pending>](loadbalancer-pending.md) | symptom | EKS | Subnet IPs, IAM & STS |

## Control plane

API server, aggregation, etcd.

| Failure | Kind | Scope | Starts at |
|---|---|---|---|
| [API server throttling (429 Too Many Requests) and slow API](api-throttling.md) | cause | any | kubectl / CI |
| [APIService unavailable (metrics.k8s.io and others), namespaces stuck Terminating](apiservice-unavailable.md) | cause | any | metrics-server |
| [no matches for kind ... in version ...](deprecated-api-removed.md) | cause | any | Your objects |
| [etcd database space exceeded or request too large](etcd-space-exceeded.md) | cause | any | Your objects |
