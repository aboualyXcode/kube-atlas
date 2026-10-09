<!-- Generated from data/runbooks.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Runbook: EKS cluster upgrade

**Trigger:** planned work, roughly every four months, at least 60 days before the current version leaves standard support.

**Impact:** none for users. Risks: removed APIs breaking deploys, add-on incompatibility, node rollouts blocked by PDBs or lacking capacity.

[Open as a flowchart](../../index.html#/operations/runbooks/cluster-upgrade)

## Before (one to two weeks ahead)

**Read.** the Kubernetes release notes and the EKS version notes for the target version.

**Check upgrade insights and deprecated API use.** Fix every finding ([deprecated-api-removed](../failures/deprecated-api-removed.md)).

```sh
aws eks list-insights --cluster-name <cluster> --filter categories=UPGRADE_READINESS
kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis
pluto detect-helm --target-versions k8s=<target-version>
```

**Check add-on compatibility.** Also check Helm-installed components (Karpenter, AWS Load Balancer Controller, cert-manager, metrics-server) against the target version.

```sh
for a in $(aws eks list-addons --cluster-name <cluster> --query 'addons[]' --output text); do
  echo "$a: $(aws eks describe-addon --cluster-name <cluster> --addon-name "$a" --query addon.addonVersion --output text)"
  aws eks describe-addon-versions --addon-name "$a" --kubernetes-version <target-version> \
    --query 'addons[0].addonVersions[0].addonVersion' --output text
done
```

**Check PDBs and capacity.** no PDB allows zero disruptions; enough headroom to drain one node per pool.

```sh
kubectl get pdb -A -o jsonpath='{range .items[?(@.status.disruptionsAllowed==0)]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'
```

**Upgrade staging.** with this same runbook, then soak for at least a few days of normal traffic and deploys.

## During (production, in a change window)

**Snapshot.** the cluster state for reference: `tools/snapshot.sh`.

**Upgrade the control plane.** (one minor version): Typically 10 to 20 minutes; the API stays available.

```sh
aws eks update-cluster-version --name <cluster> --kubernetes-version <target-version>
aws eks describe-update --name <cluster> --update-id <id>    # repeat until Successful
```

**Update EKS add-ons.** to versions for the new release, one at a time, VPC CNI first: Watch each roll out (`kubectl rollout status ds/aws-node -n kube-system`) before the next.

```sh
aws eks update-addon --cluster-name <cluster> --addon-name vpc-cni --addon-version <version> --resolve-conflicts PRESERVE
```

**Roll the data plane.** - managed node groups: `aws eks update-nodegroup-version --cluster-name <cluster> --nodegroup-name <ng>`; - Karpenter: update the AMI alias in the EC2NodeClass to one for the new version; drift replaces nodes within the NodePool's disruption budgets.

```sh
kubectl get nodes -L karpenter.sh/nodepool -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion | sort -k2
```

**Update tooling and charts.** that pin client versions.

## If something goes wrong

| If you see | Then |
|---|---|
| deploys fail with `no matches for kind` | [deprecated-api-removed](../failures/deprecated-api-removed.md) |
| node group update stuck with `PodEvictionFailure` | [drain-blocked-by-pdb](../failures/drain-blocked-by-pdb.md) |
| new nodes do not join | [eks-node-join-failure](../failures/eks-node-join-failure.md) |
| pods pending during the roll | [pending-pods-capacity](pending-pods-capacity.md) |
| add-on update `ConfigurationConflict` | compare your configuration values with the new version's schema; use `--resolve-conflicts PRESERVE` or update the values |

The control plane cannot be downgraded. For a failed data plane roll, pin the previous AMI and let nodes drift back while you investigate.

## Verify

```sh
kubectl version
kubectl get nodes -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
aws eks list-insights --cluster-name <cluster>
```

All nodes on the new version, add-ons `ACTIVE`, no failing pods, a test deploy through the normal pipeline succeeds.

## Follow up

Record the time taken and any surprises; update this runbook. Schedule the next upgrade.
