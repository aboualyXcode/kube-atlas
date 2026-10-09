<!-- Generated from data/runbooks.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Runbook: Node NotReady

**Trigger:** `KubeNodeNotReady` (a node not Ready for 5 minutes), `KubeNodePressure`, or several nodes `NotReady` at once.

**Impact:** pods on the node stop receiving traffic within a minute and are evicted after about five; StatefulSet pods and their volumes may be stuck for longer. One node is usually harmless for well-spread services. **Several nodes at once is a shared cause and a potential SEV1.**

[Open as a flowchart](../../index.html#/operations/runbooks/node-not-ready)

## Triage (5 minutes)

```sh
kubectl get nodes -o wide -L topology.kubernetes.io/zone,karpenter.sh/nodepool,node.kubernetes.io/instance-type
kubectl describe node <node> | sed -n '/Conditions/,/Addresses/p'
```

| If you see | Then |
|---|---|
| one node, `Ready=Unknown` (`Kubelet stopped posting node status`) | instance or kubelet failure, below |
| one node, `Ready=False` with a reason | [node-not-ready](../failures/node-not-ready.md), [cni-not-ready](../failures/cni-not-ready.md) |
| `MemoryPressure`, `DiskPressure`, `PIDPressure` | [node-pressure-eviction](../failures/node-pressure-eviction.md) |
| many nodes in one AZ | zonal issue: check AWS Health, subnets, NACLs |
| many nodes of one pool or AMI | a bad AMI, user data or DaemonSet rollout |
| new nodes never appear | [eks-node-join-failure](../failures/eks-node-join-failure.md) |

## Diagnose

**Is the instance alive?.** Terminated or stopping means a Spot interruption, scale-in or manual action; failed status checks mean hardware or OS trouble.

```sh
aws ec2 describe-instance-status --instance-ids <instance-id> --include-all-instances
aws ec2 get-console-output --instance-id <instance-id> --latest --output text | tail -40
```

**What does the node say?.** 

```sh
aws ssm start-session --target <instance-id>
sudo journalctl -u kubelet -u containerd --since "30 min ago" --no-pager | tail -150
df -h /; free -m; sudo crictl ps -a | head
```

**What changed?.** DaemonSet rollouts (`kubectl rollout history ds -n kube-system`), EC2NodeClass or node group changes, security group or NACL changes in CloudTrail.

## Mitigate

**One node.** cordon it so nothing new lands there; if pods matter now, drain it.

```sh
kubectl cordon <node>
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --timeout=5m
```

**Instance gone.** delete the Node object so pods are rescheduled immediately: `kubectl delete node <node>`.

**Stateful pods stuck on a dead node.** confirm the instance is stopped, then `kubectl taint node <node> node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` to release volumes.

**Many nodes from one change.** revert the change (DaemonSet, AMI pin, security group) before investigating further.

## Resolve

Let Karpenter or the node group replace the instance. For kubelet or runtime crashes, restart them (`sudo systemctl restart containerd kubelet`) only to restore service; capture logs first and fix the cause (disk, memory reservation, configuration).

## Verify

```sh
kubectl get nodes
kubectl get pods -A -o wide --field-selector spec.nodeName=<replacement-node> | head
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
```

All nodes Ready, displaced pods Running elsewhere, no pods left `Terminating` on the old node.

## Escalate

Page the platform lead if more than 20% of nodes are affected, if replacements also fail, or if an AZ-wide AWS event is suspected (open an AWS support case with instance IDs and times).

## Follow up

Record the cause. Repeated single-node failures of one instance type or AMI deserve a ticket; repeated pressure evictions mean requests are wrong somewhere.
