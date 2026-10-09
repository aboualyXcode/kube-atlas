# Labs

Each lab breaks a local [kind](https://kind.sigs.k8s.io/) cluster in exactly the way one failure entry describes. The header of every lab says how to reproduce it, what to observe, the question to answer and the fix. Try to answer the question from what the cluster tells you before reading the fix.

```sh
make kind-up                     # 4 nodes, zone labels, one tainted batch node
make lab LAB=oomkilled           # apply a lab and print what to observe
make lab-clean LAB=oomkilled     # remove it
make kind-down                   # delete the cluster
```

Labs need `kind`, `kubectl` and Docker or Podman, and use small public images. Failures that need AWS (IP exhaustion, IAM, load balancers, EBS) cannot be reproduced locally; their entries carry real messages from EKS instead.

| Lab | The question it asks | Entry |
|---|---|---|
| [`connection-timeouts`](connection-timeouts.yaml) | why a timeout and not "connection refused"? What does that tell you about the hop? | [atlas](../index.html#/failures/connection-timeouts) |
| [`crashloopbackoff`](crashloopbackoff.yaml) | is CrashLoopBackOff the problem, or the kubelet's response to it? | [atlas](../index.html#/failures/crashloopbackoff) |
| [`createcontainerconfigerror`](createcontainerconfigerror.yaml) | the Secret exists in another namespace. Why does that not help? | [atlas](../index.html#/failures/createcontainerconfigerror) |
| [`dns-nxdomain`](dns-nxdomain.yaml) | the Service exists and has endpoints. Which search domain did the short name expand to? | [atlas](../index.html#/failures/dns-nxdomain) |
| [`drain-blocked-by-pdb`](drain-blocked-by-pdb.yaml) | the PDB promises something that can never be true during a drain. What? | [atlas](../index.html#/failures/drain-blocked-by-pdb) |
| [`hpa-unknown-metrics`](hpa-unknown-metrics.yaml) | there are two root causes. The first is the missing metrics API. Install metrics-server (`make metrics-server`), wait a minute, and read the conditions again: what is the second? | [atlas](../index.html#/failures/hpa-unknown-metrics) |
| [`imagepullbackoff`](imagepullbackoff.yaml) | which row of the table in the catalog entry does the registry's answer match? | [atlas](../index.html#/failures/imagepullbackoff) |
| [`liveness-probe-restarts`](liveness-probe-restarts.yaml) | the "health check" takes 3 seconds; the probe waits 1. What would a restart fix here? | [atlas](../index.html#/failures/liveness-probe-restarts) |
| [`oomkilled`](oomkilled.yaml) | why do the container's own logs say nothing about running out of memory? | [atlas](../index.html#/failures/oomkilled) |
| [`pending-insufficient-resources`](pending-insufficient-resources.yaml) | your laptop is idle. Why does the scheduler say there is no CPU? | [atlas](../index.html#/failures/pending-insufficient-resources) |
| [`pending-taint-affinity`](pending-taint-affinity.yaml) | each pod is blocked by a different filter. Name the filter for each. | [atlas](../index.html#/failures/pending-taint-affinity) |
| [`pending-unbound-pvc`](pending-unbound-pvc.yaml) | the pod reports the problem. Which object owns it? | [atlas](../index.html#/failures/pending-unbound-pvc) |
| [`pod-stuck-terminating`](pod-stuck-terminating.yaml) | the container has already stopped. What is the API server still waiting for? | [atlas](../index.html#/failures/pod-stuck-terminating) |
| [`readiness-probe-failing`](readiness-probe-failing.yaml) | the container is healthy. Who decided it gets no traffic, and on what evidence? | [atlas](../index.html#/failures/readiness-probe-failing) |
| [`resource-quota-exceeded`](resource-quota-exceeded.yaml) | where is the third replica, and why is there nothing to `kubectl describe pod`? | [atlas](../index.html#/failures/resource-quota-exceeded) |
| [`rollout-stuck`](rollout-stuck.yaml) | the Deployment reports the stall. Which step of the life of a pod actually stopped? | [atlas](../index.html#/failures/rollout-stuck) |
| [`service-no-endpoints`](service-no-endpoints.yaml) | every pod is Running and Ready. Why does the Service still have nowhere to send traffic? | [atlas](../index.html#/failures/service-no-endpoints) |
