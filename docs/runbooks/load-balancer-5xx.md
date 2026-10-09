<!-- Generated from data/runbooks.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Runbook: Load balancer 5xx

**Trigger:** `ALBTarget5xxHigh`, `ALBUnhealthyTargets`, `ServiceWithoutEndpoints`, or an SLO burn alert for a service behind an ALB or NLB.

**Impact:** users see errors directly. Who generated the error decides where to look.

[Open as a flowchart](../../index.html#/operations/runbooks/load-balancer-5xx)

## Triage (5 minutes)

Which component produced the 5xx?

| If you see | Then |
|---|---|
| `HTTPCode_Target_5XX_Count` | the app returned 5xx: application or dependency problem |
| `HTTPCode_ELB_503_Count`, body from `awselb` | no healthy targets: [alb-targets-unhealthy](../failures/alb-targets-unhealthy.md), [service-no-endpoints](../failures/service-no-endpoints.md) |
| `HTTPCode_ELB_502_Count` | the target closed or reset the connection: [alb-5xx-during-deploys](../failures/alb-5xx-during-deploys.md) |
| `HTTPCode_ELB_504_Count` | the target did not answer within the idle timeout: slow app or dependency |
| no ADDRESS on the Ingress / `<pending>` | [ingress-no-address](../failures/ingress-no-address.md), [loadbalancer-pending](../failures/loadbalancer-pending.md) |

## Diagnose

**Targets unhealthy?.** Read the reason (`Target.Timeout`, `Target.ResponseCodeMismatch`) and compare the health check path with the readiness probe.

**Endpoints empty?.** Unready pods: [readiness-probe-failing](../failures/readiness-probe-failing.md). No matching pods: selector mismatch.

```sh
kubectl get endpointslices -n <ns> -l kubernetes.io/service-name=<svc> -o wide
kubectl get pods -n <ns> -l <selector> -o wide
```

**Correlated with deploys or scale-in?.** Compare 5xx minutes with `kubectl get events -n <ns> --field-selector reason=Killing` and rollout times.

**Target 5xx?.** Read application logs and traces for the failing route; check dependencies.

## Mitigate

Bad deploy: `kubectl rollout undo deployment/<name> -n <ns>`.

Too few healthy targets: scale out; if a readiness check on a shared dependency removed everything, consider temporarily relaxing it.

502s at every deploy: pause deploys of that service until graceful shutdown is fixed.

Controller not reconciling: check `kubectl logs -n kube-system deploy/aws-load-balancer-controller`; restart it if wedged.

## Resolve

Align health checks with readiness; fix selectors and ports; add `preStop` delay, SIGTERM handling and keep-alive settings; enable pod readiness gates on the namespace.

## Verify

ELB 5xx back to baseline, all targets healthy, a test rollout with synthetic traffic produces no errors.

## Escalate

SEV1 if checkout or order placement is affected for more than 5 minutes; involve the owning service team for target 5xx.

## Follow up

Make graceful shutdown and health check settings part of the service template; add a synthetic check through the ALB.
