<!-- Generated from data/runbooks.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Runbook: Pod IP exhaustion

**Trigger:** `SubnetFreeAddressesLow` (a cluster subnet below 10% free), `FailedCreatePodSandBox` with `failed to assign an IP address to container`, or Karpenter `InsufficientFreeAddressesInSubnet`.

**Impact:** new pods cannot start in the affected subnets or AZ; node launches fail. Existing pods are unaffected. Becomes SEV1 if a rollout or peak needs new pods.

[Open as a flowchart](../../index.html#/operations/runbooks/pod-ip-exhaustion)

## Triage (5 minutes)

```sh
aws ec2 describe-subnets --filters Name=tag:karpenter.sh/discovery,Values=<cluster> \
  --query 'Subnets[].[SubnetId,AvailabilityZone,CidrBlock,AvailableIpAddressCount]' --output table
kubectl get events -A --field-selector reason=FailedCreatePodSandBox --sort-by=.lastTimestamp | tail -5
```

Confirm which subnets and AZs are short. Compare with your pod subnets if you use custom networking (`kubectl get eniconfigs -o yaml`).

## Diagnose

**Who holds the addresses?.** Pods, warm pools, nodes, load balancers, VPC endpoints.

```sh
kubectl get pods -A -o wide --no-headers | wc -l
kubectl get ds aws-node -n kube-system -o jsonpath='{.spec.template.spec.containers[0].env}' | \
  jq '.[] | select(.name|test("WARM|MINIMUM|PREFIX|CUSTOM"))'
aws ec2 describe-network-interfaces --filters Name=subnet-id,Values=<subnet-id> \
  --query 'NetworkInterfaces[].[InterfaceType,Description]' --output text | sort | uniq -c | sort -rn | head
```

**Exhaustion or fragmentation?.** With prefix delegation, `InsufficientCidrBlocks` despite free addresses means no contiguous `/28` blocks remain.

**Why now?.** A new workload, a scale-out, a change to warm pool settings, or nodes with many unused prefixes after a scale-down.

See [pod-ip-exhaustion](../failures/pod-ip-exhaustion.md) for the mechanism.

## Mitigate

Reduce warm pools, which frees addresses on existing nodes within minutes: On the managed add-on, prefer changing configuration values through `aws eks update-addon` so the change persists.

```sh
kubectl set env ds/aws-node -n kube-system -c aws-node WARM_IP_TARGET=5 MINIMUM_IP_TARGET=10
# with prefix delegation: WARM_PREFIX_TARGET=1 (and no WARM_IP_TARGET)
```

Steer new nodes toward subnets with room (temporarily narrow the EC2NodeClass subnet selector or the NodePool zones), if zone balance allows.

Scale down non-critical workloads in the affected AZ.

## Resolve

Add address space: associate a secondary CIDR (for example `100.64.0.0/16`), create large pod subnets per AZ, enable custom networking with one `ENIConfig` per AZ, and roll nodes. With prefix delegation, create subnet CIDR reservations so `/28` blocks stay contiguous. See [chapter 6](../../index.html#/eks?layer=networking).

## Verify

Free addresses back above 20% in every cluster subnet; no new `FailedCreatePodSandBox` events; Karpenter launches succeed.

## Escalate

Page the platform lead if all AZs are affected or a peak is imminent. Network team involvement is needed for new CIDRs if address space is centrally managed.

## Follow up

Add IP capacity to the monthly capacity review; alert at 20% free (ticket) and 10% (page).
