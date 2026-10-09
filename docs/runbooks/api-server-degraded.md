<!-- Generated from data/runbooks.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Runbook: API server degraded

**Trigger:** `KubeAPIErrorsHigh`, `KubeAPILatencyHigh`, `KubeAPIPriorityAndFairnessRejecting`, `AdmissionWebhookSlow`, `AggregatedAPIUnavailable`, or many teams reporting failing `kubectl` and deploys.

**Impact:** running workloads continue (static stability), but deploys, scaling, self-healing and controllers are impaired. Becomes urgent if a peak or a failure needs the control plane to react.

[Open as a flowchart](../../index.html#/operations/runbooks/api-server-degraded)

## Triage (5 minutes)

What kind of failure?

| If you see | Then |
|---|---|
| `failed calling webhook` | [webhook-unavailable](../failures/webhook-unavailable.md) |
| `TooManyRequests`, slow `LIST` calls | [api-throttling](../failures/api-throttling.md) |
| `unable to retrieve the complete list of server APIs` | [apiservice-unavailable](../failures/apiservice-unavailable.md) |
| `etcdserver: ...` errors | [etcd-space-exceeded](../failures/etcd-space-exceeded.md); on EKS, also open an AWS support case |
| `Unauthorized` for everyone | [kubectl-unauthorized](../failures/kubectl-unauthorized.md) |
| timeouts connecting at all | endpoint access, network path, or an EKS-side issue: check AWS Health |

## Diagnose

**Webhooks.** which webhook, where does it point, are its pods ready?

```sh
kubectl get --raw /metrics | grep apiserver_admission_webhook_admission_duration_seconds_sum | sort -t' ' -k2 -nr | head
```

**Load.** which priority levels reject, which clients call most (audit log query in [chapter 12](../../index.html#/operations/observe)).

**Object bloat.** 

```sh
kubectl get --raw /metrics | grep '^apiserver_storage_objects' | sort -t' ' -k2 -nr | head
```

**Recent change.** a new operator or controller, a new webhook, an add-on upgrade, a CI job polling in a loop.

## Mitigate

**Webhook down.** restore its pods (capacity, node selector, crash). If that will take long and the webhook is not security-critical, set `failurePolicy: Ignore` or delete the configuration temporarily; record it.

**Noisy client.** scale its Deployment to zero, or suspend the CI job, then reduce its rate.

**Orphaned APIService.** delete it if its add-on is gone.

**Object bloat.** delete old Helm release Secrets (`helm history` then trim), completed Jobs, and stale custom resources.

## Resolve

Fix the noisy client (informers, sensible resync), scope and harden webhooks (replicas, PDB, short timeout, namespace selectors), give important controllers their own FlowSchema, and set retention for Helm history and Jobs.

## Verify

API p99 latency back to baseline, no Priority and Fairness rejections, APIServices all `True`, deploys succeed.

## Escalate

Open an AWS support case (severity matching impact) for errors originating in the managed control plane (`etcdserver` errors, 5xx not explained by webhooks or load). Page the platform lead for any cluster-wide write failure.

## Follow up

Review admission webhooks and new controllers as part of change review; alert on webhook latency and APIService availability.
