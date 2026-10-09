<!-- Generated from data/runbooks.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Runbook: Pods pending, capacity not arriving

**Trigger:** `KubePodsPendingTooLong` (pods `Pending` for 10 minutes), a stuck rollout, or HPA at max with pending replicas.

**Impact:** new replicas do not start: rollouts stall, scale-out does not happen, and a traffic peak may outgrow running capacity.

[Open as a flowchart](../../index.html#/operations/runbooks/pending-pods-capacity)

## Triage (5 minutes)

```sh
kubectl get pods -A --field-selector=status.phase=Pending -o wide
kubectl get events -A --field-selector reason=FailedScheduling --sort-by=.lastTimestamp | tail -10
```

Read the scheduler message and classify it:

| If you see | Then |
|---|---|
| `Insufficient cpu`, `Insufficient memory`, `Too many pods` | [pending-insufficient-resources](../failures/pending-insufficient-resources.md); then why the autoscaler did not add nodes |
| `untolerated taint`, `node affinity/selector`, `topology spread` | [pending-taint-affinity](../failures/pending-taint-affinity.md): a rule, not capacity |
| `volume node affinity conflict` | [volume-node-affinity-conflict](../failures/volume-node-affinity-conflict.md): capacity needed in one specific zone |
| `unbound immediate PersistentVolumeClaims` | [pending-unbound-pvc](../failures/pending-unbound-pvc.md) |
| no pods exist, ReplicaSet shows `FailedCreate` | [resource-quota-exceeded](../failures/resource-quota-exceeded.md) or [webhook-unavailable](../failures/webhook-unavailable.md) |

## Diagnose (why no new nodes)

**Karpenter.** 

```sh
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter --tail=300 | grep -i -E "could not schedule|incompatible|error|insufficient"
kubectl get nodepools; kubectl get nodeclaims -o wide
kubectl get ec2nodeclass -o jsonpath='{range .items[*]}{.metadata.name}{": "}{range .status.conditions[*]}{.type}={.status} {end}{"\n"}{end}'
```

| If you see | Then |
|---|---|
| `incompatible with nodepool`, `no instance type satisfied` | [karpenter-not-provisioning](../failures/karpenter-not-provisioning.md): requirements too narrow, pod too big |
| NodePool at its limits | raise `spec.limits` if the growth is legitimate |
| `InsufficientInstanceCapacity` | widen instance families, sizes and zones; allow On-Demand fallback |
| `InsufficientFreeAddressesInSubnet` | [pod-ip-exhaustion runbook](pod-ip-exhaustion.md) |
| NodeClaims launched but not registered | [eks-node-join-failure](../failures/eks-node-join-failure.md) |

**Cluster Autoscaler.** see [cluster-autoscaler-no-scale-up](../failures/cluster-autoscaler-no-scale-up.md).

```sh
kubectl get configmap cluster-autoscaler-status -n kube-system -o jsonpath='{.data.status}' | head -40
```

## Mitigate

Free room for what matters: scale down batch workloads; check that tier-1 pods have a higher PriorityClass so they preempt.

Remove capacity-buffer placeholder pods if present: their space is immediately available.

If one NodePool is blocked, temporarily allow another (On-Demand, other families) by adjusting requirements.

For a stalled rollout, `kubectl rollout undo` to stop asking for surge capacity.

## Resolve

Fix the blocker the diagnosis found, then let pending pods schedule. Do not raise limits blindly: confirm that the demand is real (an HPA reacting to genuine load, not a crash-looping pod inflating CPU).

## Verify

```sh
kubectl get pods -A --field-selector=status.phase=Pending
kubectl get hpa -A
```

No pods pending longer than a minute; HPAs below max; rollouts complete.

## Escalate

Page the platform lead if capacity cannot be added within 15 minutes ahead of a known peak, or if EC2 capacity or quota errors persist (request a quota increase; open an AWS support case for capacity).

## Follow up

Review requested versus allocatable trends, NodePool limits, instance diversity and subnet sizing in the next capacity review ([chapter 13](../../index.html#/operations)).
