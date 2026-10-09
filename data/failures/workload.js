// Workload failures: the pod, its containers and its configuration
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the cluster and eks map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "cpu-throttling",
    title: "CPU throttling (latency without errors)",
    kind: "cause",
    layer: "workload",
    scope: "any",
    summary: "The container hits its CPU limit and the kernel pauses it for the rest of each 100 ms period: latency without errors.",
    propagation: {
      map: "cluster",
      origins: [{ at: "workload-controllers", note: "limits.cpu set below real bursts" }],
      path: [
        { at: "kubelet", note: "Writes the CFS quota into the cgroup" },
        { at: "container-runtime", note: "Kernel pauses the container when quota runs out" }
      ],
      symptom: { at: "users", note: "p99 latency rises, no errors logged" }
    },
    components: ["kubelet", "container-runtime", "application"],
    symptom: [
      "Latency rises, especially p99, while average CPU usage looks comfortably below the limit. Timeouts and",
      "liveness failures appear under load. Nothing in events or logs says \"error\"."
    ],
    affected: [
      "The **kernel's CFS bandwidth control**, configured by the **kubelet** and **runtime** from",
      "`resources.limits.cpu`, pauses the **application** when it uses its quota within a period."
    ],
    rootCause: [
      "A CPU limit becomes a quota per 100 ms period: `limits.cpu: 1` allows 100 ms of CPU time per 100 ms,",
      "across all threads. A multi-threaded process can burn that quota in the first 25 ms on four cores and is",
      "then frozen for the remaining 75 ms, even if the node is idle. Averages over a minute hide it completely.",
      "",
      "Runtimes that size thread pools from the host's core count (garbage collectors, worker pools) make it",
      "worse: they run many threads against a small quota."
    ],
    investigation: [
      {
        title: "Measure the throttled share of periods",
        run: [
          "# PromQL: fraction of 100 ms periods in which the container was throttled",
          "# sum by (pod, container) (rate(container_cpu_cfs_throttled_periods_total{namespace=\"shop\"}[5m]))",
          "#   / sum by (pod, container) (rate(container_cpu_cfs_periods_total{namespace=\"shop\"}[5m]))"
        ],
        lookFor: "Sustained values above about 0.25 on latency-sensitive services."
      },
      {
        title: "Compare limits with requests and real usage",
        run: [
          "kubectl get deploy orders-api -n shop -o jsonpath='{.spec.template.spec.containers[0].resources}'",
          "kubectl top pod -n shop -l app=orders-api --containers"
        ],
        lookFor: "A limit close to the request, on a service with bursty, parallel work."
      }
    ],
    resolution: [
      "For latency-sensitive services, set a CPU **request** sized to real usage and either remove the CPU",
      "limit (the request still guarantees a share under contention) or set it well above the request. Keep",
      "memory limits: memory is not compressible, CPU is. Size runtime thread pools to the request",
      "(`-XX:ActiveProcessorCount`, `GOMAXPROCS` via automaxprocs)."
    ],
    prevention: [
      "Make \"CPU requests always, CPU limits only where you need hard isolation\" a written policy.",
      "Alert on throttling ratio above 0.25 for 15 minutes on tier-1 services.",
      "Use LimitRange defaults that set requests but not CPU limits."
    ],
    signals: [[4, "cfs_throttled"], [3, "cpu throttl"]],
    samples: [
      "rate(container_cpu_cfs_throttled_periods_total{container=\"api\"}[5m]) / rate(container_cpu_cfs_periods_total{container=\"api\"}[5m]) = 0.62",
      "p99 latency doubled after the release; CPU throttling is at 60% although usage stays below the limit"
    ],
    related: ["liveness-probe-restarts", "oomkilled", "hpa-unknown-metrics"],
    lab: null,
    runbook: null
  },
  {
    id: "crashloopbackoff",
    title: "CrashLoopBackOff",
    kind: "symptom",
    layer: "workload",
    scope: "any",
    summary: "The kubelet keeps restarting a container that keeps exiting. The status is its waiting state between restarts, never the cause.",
    propagation: {
      map: "cluster",
      origins: [{ at: "application", note: "Process exits: bad config, crash, dependency down" }],
      path: [
        { at: "container-runtime", note: "Reports the exit code to the kubelet" },
        { at: "kubelet", note: "Restarts it, doubling the back-off up to 5 min" }
      ],
      symptom: { at: "application", note: "CrashLoopBackOff, restart count climbing" },
      branches: [{ from: "kubelet", at: "service", note: "Never Ready, so never in the endpoints" }]
    },
    components: ["kubelet", "container-runtime", "application"],
    symptom: [
      "The pod shows `CrashLoopBackOff` and a climbing restart count. It is never Ready, so it receives no",
      "Service traffic. Between restarts the status may flicker to `Running` or `Error` for a few seconds."
    ],
    affected: [
      "Reported by the **kubelet**, which restarts the container and backs off. The failure almost always",
      "lives in the **application** or what it depends on: its command, configuration, a dependency it",
      "cannot reach, a probe that kills it, or a limit it exceeds."
    ],
    rootCause: [
      "`CrashLoopBackOff` is not an error. It is the kubelet's *waiting state* between restarts of a container",
      "that keeps exiting. With `restartPolicy: Always`, the kubelet restarts the container and waits 10s,",
      "20s, 40s and so on, capped at five minutes; the delay resets after the container runs for ten minutes.",
      "",
      "The question is always *why the container exits*. The usual answers, by exit code:",
      "",
      "| Exit code | Meaning | Typical cause |",
      "|---|---|---|",
      "| 1, 2 | the process reported an error | bad configuration, missing environment variable, failed migration, dependency down at startup |",
      "| 126, 127 | not executable / not found | wrong `command`, missing binary, wrong image |",
      "| 137 | SIGKILL | memory limit (`OOMKilled`), or the kubelet killed it after a failed liveness probe |",
      "| 139 | SIGSEGV | native crash |",
      "| 143 | SIGTERM | the kubelet stopped it (liveness probe) and it exited cleanly |",
      "| 0 | exited successfully | a long-running workload whose process finishes (a script, not a server) |"
    ],
    investigation: [
      {
        title: "Read the exit code and reason of the last termination",
        run: [
          "kubectl describe pod orders-api-6f7c9d8b5-x2xlq -n shop",
          "kubectl get pod orders-api-6f7c9d8b5-x2xlq -n shop \\",
          "  -o jsonpath='{range .status.containerStatuses[*]}{.name}{\"\\t\"}{.lastState.terminated.reason}{\"\\t\"}{.lastState.terminated.exitCode}{\"\\n\"}{end}'"
        ],
        lookFor: "`Last State: Terminated` with `Reason` and `Exit Code`. `OOMKilled` sends you to the OOMKilled entry; `Error` with code 1 means read the logs."
      },
      {
        title: "Read the logs of the previous, crashed container",
        run: "kubectl logs orders-api-6f7c9d8b5-x2xlq -n shop -c api --previous --tail=100",
        lookFor: "The last lines before exit. `kubectl logs` without `--previous` shows the new attempt, which has usually logged nothing yet."
      },
      {
        title: "Check the events for probe kills and config errors",
        run: "kubectl get events -n shop --field-selector involvedObject.name=orders-api-6f7c9d8b5-x2xlq --sort-by=.lastTimestamp",
        lookFor: "`Liveness probe failed ... will be restarted` means the kubelet is killing a live process (see liveness-probe-restarts)."
      },
      {
        title: "Compare with the last version that worked",
        run: [
          "kubectl rollout history deployment/orders-api -n shop",
          "kubectl diff -f reference/apps/orders-api.yaml"
        ],
        lookFor: "A new image, changed environment, ConfigMap or Secret. A crash that began at a deploy is a change, not an incident in the platform."
      },
      {
        title: "Reproduce interactively if logs are empty",
        run: [
          "kubectl debug orders-api-6f7c9d8b5-x2xlq -n shop -it --copy-to=orders-api-debug \\",
          "  --container=api -- sh"
        ],
        lookFor: "Run the entrypoint by hand inside the copy to see the error the process prints before it dies."
      }
    ],
    resolution: [
      "Fix the cause the exit code and logs point to, then let the Deployment roll forward, or roll back",
      "while you fix it:",
      "",
      "```sh",
      "kubectl rollout undo deployment/orders-api -n shop",
      "```",
      "",
      "If the process needs a dependency at startup, make it retry with backoff instead of exiting, and use a",
      "`startupProbe` for slow starts rather than a long `initialDelaySeconds` on the liveness probe."
    ],
    prevention: [
      "Run new versions in staging with production-like configuration; most crash loops are configuration that only exists in one environment.",
      "Make startup tolerant of slow dependencies (retry with backoff) and log the reason before exiting non-zero.",
      "Alert on `kube_pod_container_status_waiting_reason{reason=\"CrashLoopBackOff\"}` for more than 10 minutes, not on single restarts.",
      "Use rolling updates with `maxUnavailable: 0` and readiness probes, so a crashing version never replaces healthy pods."
    ],
    signals: [[2, "CrashLoopBackOff"], [2, "Back-off restarting failed container"]],
    samples: [
      [
        "NAME                         READY   STATUS             RESTARTS      AGE",
        "orders-api-6f7c9d8b5-x2xlq   0/1     CrashLoopBackOff   7 (2m ago)    14m"
      ],
      "Warning  BackOff  3m (x25 over 9m)  kubelet  Back-off restarting failed container api in pod orders-api-6f7c9d8b5-x2xlq_shop"
    ],
    related: [
      "oomkilled",
      "liveness-probe-restarts",
      "exec-format-error",
      "createcontainerconfigerror",
      "rollout-stuck"
    ],
    lab: "crashloopbackoff",
    runbook: null
  },
  {
    id: "createcontainerconfigerror",
    title: "CreateContainerConfigError",
    kind: "cause",
    layer: "workload",
    scope: "any",
    summary: "The pod references a ConfigMap, Secret or key that does not exist in its namespace, so the container cannot be configured.",
    propagation: {
      map: "cluster",
      origins: [{ at: "workload-controllers", note: "Spec references a missing Secret, ConfigMap or key" }],
      path: [{ at: "kubelet", note: "Cannot build the container configuration" }],
      symptom: { at: "application", note: "CreateContainerConfigError, never starts" }
    },
    components: ["kubelet", "workload-controllers", "application"],
    symptom: [
      "The pod is scheduled and its image is pulled, but the container is never created. Status is",
      "`CreateContainerConfigError` with zero restarts, and the event names a missing Secret, ConfigMap or key,",
      "or a security context conflict."
    ],
    affected: [
      "The **kubelet** builds the container's configuration (environment, mounts, security context) before",
      "asking the runtime to create it. The cause is in the **workload's** references: an object that does not",
      "exist in this namespace, a key that is not in it, or a security setting the image contradicts."
    ],
    rootCause: [
      "The kubelet resolves `env.valueFrom`, `envFrom` and the security context when it creates the container.",
      "It cannot proceed if:",
      "",
      "- a referenced Secret or ConfigMap does not exist **in the pod's namespace** (they are namespaced; one in",
      "  `default` does not count);",
      "- a referenced key is missing from it (often a renamed key, or a Secret created by an operator that has",
      "  not reconciled yet);",
      "- `runAsNonRoot: true` is set and the image's user is root (UID 0) with no `runAsUser` override.",
      "",
      "Volume-mounted Secrets and ConfigMaps fail differently: the pod stays in `ContainerCreating` with a",
      "`FailedMount` event instead."
    ],
    investigation: [
      {
        title: "Read the event that names the missing object",
        run: "kubectl describe pod orders-api-58d9b7c6f4-tt2nv -n shop | sed -n '/Events/,$p'",
        lookFor: "`secret \"x\" not found`, `couldn't find key K in Secret ns/x`, or `runAsNonRoot`."
      },
      {
        title: "Check the object exists in the right namespace with the right keys",
        run: [
          "kubectl get secret orders-db -n shop -o jsonpath='{.data}' | jq 'keys'",
          "kubectl get secret -A --field-selector metadata.name=orders-db"
        ],
        lookFor: "The Secret in another namespace, or keys named differently from the reference."
      },
      {
        title: "If the Secret is synced from AWS, check the syncer",
        run: [
          "kubectl get externalsecret -n shop",
          "kubectl describe externalsecret orders-db -n shop"
        ],
        lookFor: "`SecretSyncedError` caused by IAM permissions or a wrong Secrets Manager path."
      },
      {
        title: "For runAsNonRoot, check the image user",
        run: "docker inspect --format '{{.Config.User}}' 111122223333.dkr.ecr.eu-west-1.amazonaws.com/orders-api:1.4.2",
        lookFor: "An empty user (root). Set `runAsUser` or rebuild the image with a numeric non-root `USER`."
      }
    ],
    resolution: [
      "Create or fix the referenced object in the pod's namespace, or correct the key name. The kubelet retries",
      "on its own; no pod restart is needed once the object exists. For security context conflicts, set a",
      "numeric `runAsUser` in the pod spec or, better, a numeric `USER` in the image.",
      "",
      "Mark references that are genuinely optional with `optional: true` so the container can start without them."
    ],
    prevention: [
      "Deploy configuration and the workload that needs it in the same release (one Helm chart or Kustomize base), with configuration first.",
      "Validate manifests in CI against the namespace's expected Secrets and keys.",
      "Build images with a numeric non-root `USER` so `runAsNonRoot` never conflicts.",
      "Alert on `kube_pod_container_status_waiting_reason{reason=\"CreateContainerConfigError\"}` for more than 5 minutes."
    ],
    signals: [
      [3, "CreateContainerConfigError"],
      [2, "secret \"[^\"]+\" not found|configmap \"[^\"]+\" not found"],
      [2, "couldn't find key \\S+ in (Secret|ConfigMap)"],
      [2, "has runAsNonRoot and image will run as root"]
    ],
    samples: [
      [
        "NAME                          READY   STATUS                       RESTARTS   AGE",
        "orders-api-58d9b7c6f4-tt2nv   0/1     CreateContainerConfigError   0          3m"
      ],
      "Warning  Failed  12s (x6 over 1m)  kubelet  Error: secret \"orders-db\" not found",
      "Error: couldn't find key DATABASE_URL in Secret shop/orders-db",
      "Error: container has runAsNonRoot and image will run as root (pod: \"orders-api-58d9b7c6f4-tt2nv_shop(4f1c)\", container: api)"
    ],
    related: ["crashloopbackoff", "pod-aws-access-denied"],
    lab: "createcontainerconfigerror",
    runbook: null
  },
  {
    id: "exec-format-error",
    title: "exec format error (image built for another CPU architecture)",
    kind: "cause",
    layer: "workload",
    scope: "eks",
    summary: "The image was built for one CPU architecture and the node runs another, so the entrypoint cannot execute.",
    propagation: {
      map: "eks",
      origins: [
        { at: "ecr", note: "Image exists for amd64 only" },
        { at: "karpenter", note: "Launches arm64 (Graviton) nodes for the pod" }
      ],
      path: [{ at: "container-runtime", note: "Pulls the image, cannot exec the binary" }],
      symptom: { at: "application", note: "exec format error, crash loop on some nodes only" }
    },
    components: ["container-runtime", "application", "karpenter", "ecr"],
    symptom: [
      "New pods crash immediately and loop in `CrashLoopBackOff`; the previous container's log has a single",
      "line: `exec <binary>: exec format error`. Typically only *some* replicas fail: the ones scheduled onto",
      "nodes of the other architecture. A variant fails earlier with `no match for platform in manifest` during",
      "the pull."
    ],
    affected: [
      "The **container runtime** cannot execute the binary. The cause is the **image** (built for one",
      "architecture) meeting a node of another, usually because **Karpenter** or a node group now offers",
      "Graviton (`arm64`) instances alongside `amd64`."
    ],
    rootCause: [
      "An image contains binaries compiled for one CPU architecture. A multi-architecture image is an index that",
      "points to one manifest per platform, and the runtime pulls the one matching the node. A single-platform",
      "image has no such choice: the runtime pulls it and the kernel refuses to execute an `amd64` binary on an",
      "`arm64` node, or the reverse.",
      "",
      "On EKS this appears after a cost change: a NodePool whose requirements allow `kubernetes.io/arch: In",
      "[amd64, arm64]` will happily launch Graviton nodes, and every workload whose image is `amd64`-only",
      "crashes there."
    ],
    investigation: [
      {
        title: "Correlate failing pods with node architecture",
        run: [
          "kubectl get pods -n shop -l app=orders-api -o wide",
          "kubectl get nodes -L kubernetes.io/arch,karpenter.sh/nodepool,node.kubernetes.io/instance-type"
        ],
        lookFor: "Failing pods all on `arm64` nodes (or all on `amd64`), healthy ones on the other."
      },
      {
        title: "Inspect the platforms the image actually provides",
        run: [
          "docker buildx imagetools inspect 111122223333.dkr.ecr.eu-west-1.amazonaws.com/orders-api:1.4.2",
          "# or: crane manifest <image> | jq '.manifests[].platform'"
        ],
        lookFor: "A single platform, or an index without the node's architecture."
      },
      {
        title: "Check what the NodePool allows",
        run: "kubectl get nodepool general -o jsonpath='{.spec.template.spec.requirements}' | jq",
        lookFor: "`kubernetes.io/arch` with both values, or no arch requirement at all."
      }
    ],
    resolution: [
      "Build and push a multi-architecture image, which is the durable fix:",
      "",
      "```sh",
      "docker buildx build --platform linux/amd64,linux/arm64 \\",
      "  -t 111122223333.dkr.ecr.eu-west-1.amazonaws.com/orders-api:1.4.3 --push .",
      "```",
      "",
      "Until then, pin the workload to the architecture its image supports:",
      "",
      "```yaml",
      "nodeSelector:",
      "  kubernetes.io/arch: amd64",
      "```"
    ],
    prevention: [
      "Build every image for `linux/amd64` and `linux/arm64` in CI and fail the pipeline if the pushed index lacks either.",
      "Add an admission policy that requires a `kubernetes.io/arch` node selector for images known to be single-architecture.",
      "Introduce new architectures through a separate NodePool with a taint, and move workloads deliberately."
    ],
    signals: [[5, "exec format error"], [2, "no match for platform in manifest"]],
    samples: [
      "exec /usr/local/bin/orders-api: exec format error",
      [
        "$ kubectl logs orders-api-7b8c6d5f4-q9w2e -n shop --previous",
        "exec /app/server: exec format error"
      ]
    ],
    related: ["crashloopbackoff", "karpenter-not-provisioning", "imagepullbackoff"],
    lab: null,
    runbook: null
  },
  {
    id: "imagepullbackoff",
    title: "ImagePullBackOff / ErrImagePull",
    kind: "symptom",
    layer: "workload",
    scope: "any",
    summary: "The node cannot pull the image: the name or tag is wrong, the node has no permission, or there is no network path to the registry.",
    propagation: {
      map: "eks",
      origins: [
        { at: "ecr", note: "Image or tag does not exist" },
        { at: "iam", note: "Node role cannot read from ECR" },
        { at: "vpc-endpoints", note: "No NAT route or ECR/S3 endpoints" }
      ],
      path: [
        { at: "container-runtime", note: "Pull fails: not found, 403 or i/o timeout" },
        { at: "kubelet", note: "Retries with growing back-off" }
      ],
      symptom: { at: "application", note: "ErrImagePull, then ImagePullBackOff" }
    },
    components: ["kubelet", "container-runtime", "ecr", "iam", "vpc"],
    symptom: [
      "The pod stays in `ErrImagePull`, then `ImagePullBackOff`, and never starts. Events on the pod say",
      "`Failed to pull image` followed by the registry's answer. Other pods using images already cached on the",
      "node keep working, which can make the problem look node-specific."
    ],
    affected: [
      "The **kubelet** asks the **container runtime** to pull; the failure is between the node and the",
      "**registry**: the reference itself, credentials (**IAM** for ECR, image pull secrets elsewhere), rate",
      "limits, or the network path (**VPC** routing, NAT, endpoints)."
    ],
    rootCause: [
      "The error after `Failed to pull image` tells you which link failed:",
      "",
      "| Message contains | Cause |",
      "|---|---|",
      "| `not found`, `manifest unknown` | the tag or digest does not exist (typo, not pushed yet, wrong repository or region) |",
      "| `401 Unauthorized`, `403 Forbidden`, `no basic auth credentials`, `pull access denied` | no or wrong credentials: node role lacks ECR pull permissions, cross-account repository policy, missing `imagePullSecrets` |",
      "| `429 Too Many Requests`, `toomanyrequests` | registry rate limit (Docker Hub anonymous pulls from shared NAT IPs) |",
      "| `i/o timeout`, `dial tcp ... connect: connection timed out` | no network path: private subnet without NAT or without ECR and S3 endpoints, or a security group blocking 443 |",
      "| `no match for platform in manifest` | the image index lacks the node's architecture |",
      "",
      "ECR pulls need three things: `ecr:GetAuthorizationToken` and pull permissions on the node role (managed",
      "policy `AmazonEC2ContainerRegistryPullOnly` or `ReadOnly`), a route to the `ecr.api` and `ecr.dkr`",
      "endpoints, and a route to S3, where the layers live."
    ],
    investigation: [
      {
        title: "Read the exact pull error",
        run: "kubectl describe pod dispatch-worker-5d4b7c9f6-kq8zt -n fulfilment | sed -n '/Events/,$p'",
        lookFor: "The text after `Failed to pull image`. Match it to the table above before anything else."
      },
      {
        title: "Verify the reference exists",
        run: "aws ecr describe-images --repository-name orders-api --image-ids imageTag=1.4.2 --region eu-west-1",
        lookFor: "`ImageNotFoundException` means the tag was never pushed, or was pushed to another account or region."
      },
      {
        title: "Check the node's identity and permissions",
        run: [
          "aws eks describe-nodegroup --cluster-name larder-prod --nodegroup-name system --query nodegroup.nodeRole",
          "aws iam list-attached-role-policies --role-name <node-role-name>",
          "aws ecr get-repository-policy --repository-name orders-api   # for cross-account pulls"
        ],
        lookFor: "No ECR policy on the node role, or a repository policy that does not allow the cluster's account."
      },
      {
        title: "Test the network path from the node",
        run: [
          "kubectl debug node/<node-name> -it --image=public.ecr.aws/amazonlinux/amazonlinux:2023 -- \\",
          "  curl -sS -m 5 -o /dev/null -w '%{http_code}\\n' https://api.ecr.eu-west-1.amazonaws.com/",
          "aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=<vpc-id> \\",
          "  --query 'VpcEndpoints[].ServiceName'"
        ],
        lookFor: "A timeout, and no `ecr.api`, `ecr.dkr` and `s3` endpoints in a VPC without NAT."
      }
    ],
    resolution: [
      "- **Not found:** fix the tag, or push it; prefer immutable tags or digests so a reference never changes meaning.",
      "- **Unauthorized:** attach `AmazonEC2ContainerRegistryPullOnly` to the node role, add the cluster's",
      "  account to the repository policy for cross-account pulls, or create an `imagePullSecret` for",
      "  third-party registries.",
      "- **Rate limited:** mirror public images into ECR with a pull-through cache rule and reference the ECR",
      "  path; authenticate to Docker Hub if you must pull from it.",
      "- **Timeout:** add NAT, or interface endpoints for `ecr.api` and `ecr.dkr` plus the S3 gateway endpoint,",
      "  and allow 443 from nodes to the endpoint security group."
    ],
    prevention: [
      "Use ECR pull-through cache for every public image; never depend on anonymous Docker Hub pulls in production.",
      "Promote images by digest across environments, and enable ECR tag immutability.",
      "Deploy only tags that CI has verified exist (`aws ecr describe-images`) before updating manifests.",
      "Alert on `kube_pod_container_status_waiting_reason{reason=~\"ImagePullBackOff|ErrImagePull\"}` for more than 5 minutes."
    ],
    signals: [
      [2, "ImagePullBackOff"],
      [2, "ErrImagePull"],
      [2, "Back-off pulling image"],
      [2, "Failed to pull image"],
      [4, "toomanyrequests|pull rate limit"],
      [1, "failed to pull and unpack image|failed to resolve reference"]
    ],
    samples: [
      [
        "NAME                          READY   STATUS             RESTARTS   AGE",
        "dispatch-worker-5d4b7c9f6-kq8zt   0/1     ImagePullBackOff   0          6m"
      ],
      "Failed to pull image \"111122223333.dkr.ecr.eu-west-1.amazonaws.com/orders-api:1.4.2\": rpc error: code = NotFound desc = failed to pull and unpack image \"111122223333.dkr.ecr.eu-west-1.amazonaws.com/orders-api:1.4.2\": failed to resolve reference: not found",
      "Failed to pull image \"redis:7.4\": failed to copy: httpReadSeeker: failed open: unexpected status code https://registry-1.docker.io/v2/library/redis/manifests/sha256:9f4c: 429 Too Many Requests - Server message: toomanyrequests: You have reached your unauthenticated pull rate limit"
    ],
    related: ["exec-format-error", "pod-aws-access-denied", "crashloopbackoff"],
    lab: "imagepullbackoff",
    runbook: null
  },
  {
    id: "liveness-probe-restarts",
    title: "Liveness probe restarts healthy containers",
    kind: "cause",
    layer: "workload",
    scope: "any",
    summary: "A liveness probe that is stricter than the app's real response time kills containers that were only slow.",
    propagation: {
      map: "cluster",
      origins: [{ at: "application", note: "Slow to answer: GC pause, load, slow dependency" }],
      path: [
        { at: "kubelet", note: "Liveness probe times out failureThreshold times" },
        { at: "container-runtime", note: "Kubelet kills and restarts the container" }
      ],
      symptom: { at: "application", note: "Restarts under load, exit 137 or 143" },
      branches: [
        {
          from: "kubelet",
          at: "service",
          note: "Restarting pods leave endpoints, overloading the rest"
        }
      ]
    },
    components: ["kubelet", "application"],
    symptom: [
      "Containers restart under load, usually several replicas at once, and latency or errors spike because the",
      "remaining replicas absorb the traffic and then fail their probes too. Exit codes are 143 or 137, and",
      "events show `Liveness probe failed` followed by `will be restarted`."
    ],
    affected: [
      "The **kubelet** kills the container after `failureThreshold` consecutive failures. The cause is the",
      "**probe's design**: it measures something other than \"this process is irrecoverably stuck\"."
    ],
    rootCause: [
      "A liveness failure is a death sentence: the kubelet kills and restarts the container. That is right for",
      "deadlocks, and wrong for anything a restart does not fix:",
      "",
      "- **Slowness under load:** the probe shares the request thread pool or event loop, times out after the",
      "  default one second, and the kubelet kills a busy but healthy process. Restarting it removes capacity and",
      "  makes the overload worse, so the restarts cascade across replicas.",
      "- **Dependency checks:** a liveness endpoint that checks the database restarts every replica when the",
      "  database blips.",
      "- **Slow start:** without a `startupProbe`, liveness begins before the app is ready and kills it during",
      "  boot, which shows up as a crash loop.",
      "- **GC pauses or CPU throttling** longer than `timeoutSeconds × failureThreshold`."
    ],
    investigation: [
      {
        title: "Confirm the kubelet is killing the container",
        run: [
          "kubectl get events -n shop --field-selector reason=Killing --sort-by=.lastTimestamp",
          "kubectl describe pod <pod> -n shop | grep -A2 -E \"Liveness|Last State\""
        ],
        lookFor: "`failed liveness probe, will be restarted`, and exit code 143 or 137 rather than an application error."
      },
      {
        title: "Correlate restarts with load and throttling",
        run: [
          "# PromQL",
          "# sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace=\"shop\"}[10m]))",
          "# sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace=\"shop\"}[5m]))",
          "#   / sum by (pod) (rate(container_cpu_cfs_periods_total{namespace=\"shop\"}[5m]))"
        ],
        lookFor: "Restarts that line up with traffic peaks or high throttling."
      },
      {
        title: "Read the probe configuration",
        run: "kubectl get deploy orders-api -n shop -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}' | jq",
        lookFor: "`timeoutSeconds: 1`, a low `failureThreshold`, the same path as readiness, or no `startupProbe`."
      }
    ],
    resolution: [
      "Make liveness cheap, local and tolerant. It should answer from a path that does not wait on the request",
      "queue or on dependencies, and only fail when a restart would help:",
      "",
      "```yaml",
      "livenessProbe:",
      "  httpGet: { path: /healthz, port: http }",
      "  periodSeconds: 10",
      "  timeoutSeconds: 3",
      "  failureThreshold: 6        # a minute of consecutive failures before a restart",
      "```",
      "",
      "If you cannot point to a failure mode that a restart fixes, remove the liveness probe; readiness alone",
      "keeps traffic away from a struggling pod without killing it."
    ],
    prevention: [
      "Review every liveness probe against the question \"what stuck state does this detect?\".",
      "Pair every slow-starting container with a `startupProbe`.",
      "Load-test with probes enabled; probe-induced cascades only appear near saturation."
    ],
    signals: [
      [4, "Liveness probe failed"],
      [4, "failed liveness probe, will be restarted"],
      [1, "Client\\.Timeout exceeded while awaiting headers"]
    ],
    samples: [
      "Warning  Unhealthy  2m (x3 over 2m)  kubelet  Liveness probe failed: Get \"http://10.20.41.8:8080/healthz\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
      "Normal  Killing  2m  kubelet  Container api failed liveness probe, will be restarted"
    ],
    related: ["crashloopbackoff", "readiness-probe-failing", "cpu-throttling"],
    lab: "liveness-probe-restarts",
    runbook: null
  },
  {
    id: "oomkilled",
    title: "OOMKilled (container exceeded its memory limit)",
    kind: "cause",
    layer: "workload",
    scope: "any",
    summary: "The container used more memory than its limit, so the kernel killed it with SIGKILL (exit code 137).",
    propagation: {
      map: "cluster",
      origins: [{ at: "application", note: "Memory grows past limits.memory" }],
      path: [
        { at: "container-runtime", note: "Kernel OOM killer ends the process (137)" },
        { at: "kubelet", note: "Records OOMKilled and restarts the container" }
      ],
      symptom: { at: "application", note: "Restarts climb, then CrashLoopBackOff" }
    },
    components: ["kubelet", "container-runtime", "application"],
    symptom: [
      "The container restarts with `Last State: Terminated, Reason: OOMKilled, Exit Code: 137`. Often seen as",
      "`CrashLoopBackOff` if it happens repeatedly, or as sporadic restarts under load. The application's own",
      "logs simply stop: the kernel gives it no chance to write anything."
    ],
    affected: [
      "The **kernel** enforces the memory limit through the container's cgroup; the **kubelet** and",
      "**container runtime** report it. The cause is the **application**'s memory use relative to the limit",
      "you set."
    ],
    rootCause: [
      "`resources.limits.memory` becomes the cgroup's `memory.max`. When the container's processes need more",
      "than that and the kernel cannot reclaim page cache, the kernel's OOM killer kills them with SIGKILL",
      "(exit 137). On cgroup v2 nodes, recent kubelets kill the whole container rather than one process.",
      "",
      "Common reasons:",
      "",
      "- The limit is below the real working set (the request and limit were guessed, not measured).",
      "- A runtime ignores the container limit: an old JVM sizing its heap from host memory, or a heap sized",
      "  to the full limit with no room for off-heap memory, threads and native buffers.",
      "- A leak: memory grows steadily until the limit, and restarts appear at regular intervals.",
      "- A traffic- or data-dependent spike: one large request, batch or cache fill.",
      "",
      "This is different from **eviction** (the node ran low on memory and the kubelet chose victims) and",
      "from a **node-level OOM** (the node itself ran out because limits were overcommitted)."
    ],
    investigation: [
      {
        title: "Confirm it is the container limit, not eviction",
        run: [
          "kubectl get pod orders-api-6f7c9d8b5-x2xlq -n shop \\",
          "  -o jsonpath='{.status.containerStatuses[*].lastState.terminated}'",
          "kubectl get pod orders-api-6f7c9d8b5-x2xlq -n shop -o jsonpath='{.status.reason}'"
        ],
        lookFor: "`reason: OOMKilled` on the container is a limit kill. `Evicted` on the pod is node pressure (see node-pressure-eviction)."
      },
      {
        title: "Compare the limit with actual usage over time",
        run: [
          "kubectl get pod orders-api-6f7c9d8b5-x2xlq -n shop -o jsonpath='{.spec.containers[*].resources}'",
          "kubectl top pod -n shop -l app=orders-api --containers",
          "# PromQL: working set against limit, per container",
          "# max by (pod, container) (container_memory_working_set_bytes{namespace=\"shop\", container=\"api\"})",
          "#   / on (pod, container) kube_pod_container_resource_limits{resource=\"memory\", namespace=\"shop\"}"
        ],
        lookFor: "A sawtooth that climbs to the limit (leak or cache), or flat usage with sudden spikes (request-driven)."
      },
      {
        title: "Check how the runtime sizes its heap",
        run: "kubectl exec deploy/orders-api -n shop -c api -- sh -c 'cat /sys/fs/cgroup/memory.max; env | grep -i -E \"java|heap|node_options|gomemlimit\"'",
        lookFor: "A JVM without `-XX:MaxRAMPercentage`, Node.js without `--max-old-space-size`, Go without `GOMEMLIMIT` sized below the limit."
      },
      {
        title: "Check whether the node killed it instead",
        run: [
          "kubectl describe node <node-name> | grep -A5 -i -E \"SystemOOM|MemoryPressure\"",
          "kubectl get events -A --field-selector reason=SystemOOM"
        ],
        lookFor: "`SystemOOM` events mean the node ran out; requests were too low and limits overcommitted."
      }
    ],
    resolution: [
      "If usage is legitimate, raise the limit to the measured peak plus headroom, and set the request to the",
      "typical working set (or equal to the limit for Guaranteed QoS on critical services):",
      "",
      "```yaml",
      "resources:",
      "  requests: { cpu: 250m, memory: 768Mi }",
      "  limits:   { memory: 1Gi }",
      "```",
      "",
      "Size language runtimes inside the limit: `-XX:MaxRAMPercentage=75` for the JVM, `GOMEMLIMIT` at about",
      "90% of the limit for Go, `--max-old-space-size` for Node.js. If it is a leak, roll back and fix the code;",
      "raising the limit only stretches the interval between kills."
    ],
    prevention: [
      "Set memory requests and limits from observed p99 working set, and revisit them after big releases (VPA in recommendation mode helps).",
      "Alert when working set exceeds 90% of the limit for 15 minutes, before the kill.",
      "Alert on `increase(kube_pod_container_status_restarts_total[1h]) > 3` combined with `kube_pod_container_status_last_terminated_reason{reason=\"OOMKilled\"}`.",
      "Load-test with production-sized payloads; many OOMs only appear with the largest customers."
    ],
    signals: [[4, "OOMKilled"], [2, "Exit Code:\\s*137"], [1, "memory\\.max|out of memory|oom-kill"]],
    samples: [
      [
        "Last State:     Terminated",
        "  Reason:       OOMKilled",
        "  Exit Code:    137",
        "  Started:      Tue, 06 Oct 2026 09:12:04 +0000",
        "  Finished:     Tue, 06 Oct 2026 09:14:51 +0000",
        "State:          Waiting",
        "  Reason:       CrashLoopBackOff"
      ],
      "kernel: Memory cgroup out of memory: Killed process 31337 (java) total-vm:4120232kB, anon-rss:1048576kB"
    ],
    related: ["crashloopbackoff", "node-pressure-eviction", "cpu-throttling"],
    lab: "oomkilled",
    runbook: null
  },
  {
    id: "pod-stuck-terminating",
    title: "Pod stuck in Terminating",
    kind: "symptom",
    layer: "workload",
    scope: "any",
    summary: "The pod was deleted but something still holds it: a finalizer nobody removes, a node that cannot confirm the stop, or a volume that will not unmount.",
    propagation: {
      map: "cluster",
      origins: [
        { at: "workload-controllers", note: "A finalizer no controller removes" },
        { at: "kubelet", note: "Node unreachable: nobody confirms the stop" },
        { at: "csi-node", note: "Volume unmount hangs" }
      ],
      path: [{ at: "kube-apiserver", note: "Keeps the object until all of these clear" }],
      symptom: { at: "client", note: "Terminating for minutes or hours" }
    },
    components: ["kubelet", "kube-apiserver", "csi-node", "workload-controllers"],
    symptom: [
      "A deleted pod stays `Terminating` long after its grace period. A StatefulSet will not create its",
      "replacement (same name), a node drain hangs, or a namespace cannot finish deleting."
    ],
    affected: [
      "Deletion is a cooperation between the **API server** (which only removes the object when its",
      "finalizers are empty and the kubelet confirms), the **kubelet** on the pod's node, and sometimes the",
      "**CSI node plugin** unmounting volumes."
    ],
    rootCause: [
      "Deleting a pod sets `deletionTimestamp`. The kubelet then runs `preStop`, sends SIGTERM, waits up to",
      "`terminationGracePeriodSeconds`, sends SIGKILL, cleans up, and tells the API server the pod is gone.",
      "The object disappears only when that has happened **and** `metadata.finalizers` is empty. It gets stuck",
      "when:",
      "",
      "- **a finalizer remains**: the controller responsible for removing it is gone, broken or lacks permission;",
      "- **the node is unreachable**: no kubelet is left to confirm, so the object waits forever (by design: the",
      "  pod may still be running on a partitioned node);",
      "- **unmount hangs**: a stuck NFS (EFS) mount or a volume detach that does not complete;",
      "- **the grace period is huge**: someone set `terminationGracePeriodSeconds: 3600`."
    ],
    investigation: [
      {
        title: "Check finalizers and the deletion timestamp",
        run: "kubectl get pod search-indexer-0 -n catalog -o jsonpath='{.metadata.deletionTimestamp}{\"\\n\"}{.metadata.finalizers}{\"\\n\"}'",
        lookFor: "Any finalizer, and which controller owns it."
      },
      {
        title: "Check the node the pod was on",
        run: [
          "kubectl get pod search-indexer-0 -n catalog -o jsonpath='{.spec.nodeName}'; echo",
          "kubectl get node <node-name>"
        ],
        lookFor: "`NotReady` or a node that no longer exists (an instance terminated by Spot or by hand)."
      },
      {
        title: "Check for stuck volumes on that node",
        run: [
          "kubectl describe pod search-indexer-0 -n catalog | sed -n '/Events/,$p'",
          "kubectl get volumeattachments | grep <node-name>"
        ],
        lookFor: "`UnmountVolume.TearDown failed` or attachments that never go away."
      }
    ],
    resolution: [
      "Fix the owner of the finalizer if you can (restart or repair its controller). Remove a finalizer by hand",
      "only when you know what cleanup it guarded and that it is safe to skip:",
      "",
      "```sh",
      "kubectl patch pod search-indexer-0 -n catalog --type=json -p='[{\"op\":\"remove\",\"path\":\"/metadata/finalizers\"}]'",
      "```",
      "",
      "For a node that is truly gone, delete the Node object (the pods are then garbage collected), or apply",
      "the `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` taint so volumes detach. Force deletion",
      "(`--grace-period=0 --force`) removes only the API object; for StatefulSet pods on a partitioned node it",
      "can leave two copies running with the same identity."
    ],
    prevention: [
      "Every controller that adds finalizers must be highly available and have a documented removal procedure.",
      "Keep `terminationGracePeriodSeconds` close to real shutdown time.",
      "Let Karpenter, Cluster Autoscaler or the node termination handler drain nodes before instances disappear."
    ],
    signals: [[3, "Terminating"], [2, "finalizers"], [1, "deletionTimestamp"]],
    samples: [
      [
        "NAME                    READY   STATUS        RESTARTS   AGE",
        "search-indexer-0        1/1     Terminating   0          3d",
        "metadata.deletionTimestamp: \"2026-10-06T08:01:12Z\"",
        "metadata.finalizers: [\"larder.example/flush-index\"]"
      ]
    ],
    related: ["node-not-ready", "efs-mount-timeout", "drain-blocked-by-pdb", "apiservice-unavailable"],
    lab: "pod-stuck-terminating",
    runbook: "node-not-ready"
  },
  {
    id: "readiness-probe-failing",
    title: "Readiness probe failing (pods Running but not Ready)",
    kind: "symptom",
    layer: "workload",
    scope: "any",
    summary: "The container runs, but its readiness check fails, so it is taken out of Service endpoints and receives no traffic.",
    propagation: {
      map: "cluster",
      origins: [{ at: "application", note: "Readiness endpoint fails, often on a dependency check" }],
      path: [
        { at: "kubelet", note: "Readiness probe fails: Ready=False" },
        { at: "kube-controller-manager", note: "EndpointSlice controller removes the pod" },
        { at: "service", note: "Fewer, or zero, ready endpoints" }
      ],
      symptom: { at: "users", note: "503 once no ready endpoints remain" },
      branches: [{ from: "service", at: "elb", note: "Load balancer targets go unhealthy" }]
    },
    components: ["kubelet", "application", "kube-controller-manager", "kube-proxy"],
    symptom: [
      "Pods are `Running` with `READY 0/1` and few or no restarts. The Service has no ready endpoints, so",
      "callers get connection refused, and an ALB in front returns `503`. A rollout using these pods stalls,",
      "because new pods never become available."
    ],
    affected: [
      "The **kubelet** runs the probe and marks the container unready; the **EndpointSlice controller** removes",
      "the pod from the Service; **kube-proxy** and the load balancer stop sending it traffic. The cause is the",
      "**application**'s readiness endpoint or something it checks."
    ],
    rootCause: [
      "Readiness answers \"should this pod receive traffic now?\". A failing readiness probe never restarts the",
      "container; it only takes the pod out of rotation. It fails when:",
      "",
      "- the probe targets the wrong port or path (`connection refused`, `404`);",
      "- the app is still starting and the probe has no `startupProbe` or tolerance for it;",
      "- the readiness handler checks a dependency (database, cache, another service) that is down or",
      "  unreachable, so **every** replica goes unready at once and the outage spreads upwards;",
      "- the probe's `timeoutSeconds` (default 1s) is shorter than the endpoint's latency under load.",
      "",
      "The third case is the dangerous one: a dependency blip removes all capacity even though the pods could",
      "serve cached or partial responses."
    ],
    investigation: [
      {
        title: "See which pods are unready and why",
        run: [
          "kubectl get pods -n shop -l app=orders-api -o wide",
          "kubectl describe pod <pod> -n shop | grep -A3 -E \"Readiness|Conditions\""
        ],
        lookFor: "`connection refused` (nothing listening on that port yet), a status code (the handler answered \"no\"), or `context deadline exceeded` (too slow)."
      },
      {
        title: "Call the readiness endpoint yourself",
        run: [
          "kubectl port-forward pod/<pod> -n shop 8080:8080 &",
          "curl -sv http://127.0.0.1:8080/ready"
        ],
        lookFor: "The body usually says which check failed (`db: timeout`)."
      },
      {
        title: "Check the endpoints the Service actually has",
        run: "kubectl get endpointslices -n shop -l kubernetes.io/service-name=orders-api -o wide",
        lookFor: "Addresses with `ready=false`, or none at all."
      },
      {
        title: "If all replicas are unready, test the dependency",
        run: [
          "kubectl debug -it <pod> -n shop --image=nicolaka/netshoot --target=api -- \\",
          "  nc -vz -w 3 orders-db.cluster-abc123.eu-west-1.rds.amazonaws.com 5432"
        ],
        lookFor: "A timeout points to network or security groups (see connection-timeouts); a refusal points to the dependency itself."
      }
    ],
    resolution: [
      "Point the probe at a cheap endpoint that reflects whether *this process* can serve. Keep deep dependency",
      "checks out of readiness, or make them tolerate short outages. Use a `startupProbe` for slow starts and a",
      "realistic `timeoutSeconds`:",
      "",
      "```yaml",
      "startupProbe:   { httpGet: { path: /ready, port: http }, periodSeconds: 5, failureThreshold: 30 }",
      "readinessProbe: { httpGet: { path: /ready, port: http }, periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 3 }",
      "```"
    ],
    prevention: [
      "Separate liveness (process is alive), readiness (can serve now) and startup (finished booting) endpoints.",
      "Never make readiness fail on a dependency that every replica shares, unless removing all replicas is truly better than serving errors.",
      "Alert on Services whose ready endpoint count drops to zero, and on Deployments with `kube_deployment_status_replicas_available` below desired."
    ],
    signals: [[4, "Readiness probe failed"], [1, "probe failed with statuscode: 5\\d\\d"]],
    samples: [
      "Warning  Unhealthy  8s (x40 over 6m)  kubelet  Readiness probe failed: HTTP probe failed with statuscode: 503",
      "Readiness probe failed: Get \"http://10.20.37.14:8080/ready\": dial tcp 10.20.37.14:8080: connect: connection refused"
    ],
    related: [
      "service-no-endpoints",
      "alb-targets-unhealthy",
      "liveness-probe-restarts",
      "rollout-stuck",
      "connection-timeouts"
    ],
    lab: "readiness-probe-failing",
    runbook: "load-balancer-5xx"
  },
  {
    id: "rollout-stuck",
    title: "Rollout stuck (ProgressDeadlineExceeded)",
    kind: "symptom",
    layer: "workload",
    scope: "any",
    summary: "New pods never become available, so the Deployment stops progressing and reports ProgressDeadlineExceeded.",
    propagation: {
      map: "cluster",
      origins: [
        { at: "kube-scheduler", note: "New pods cannot be scheduled" },
        { at: "kubelet", note: "New pods crash or never pass readiness" },
        { at: "kube-apiserver", note: "Quota or a webhook rejects new pods" }
      ],
      path: [
        {
          at: "kube-controller-manager",
          note: "Deployment controller waits for available replicas"
        }
      ],
      symptom: { at: "client", note: "rollout status hangs, then ProgressDeadlineExceeded" }
    },
    components: ["kube-controller-manager", "workload-controllers", "kube-scheduler", "kubelet"],
    symptom: [
      "`kubectl rollout status` hangs and then fails with `exceeded its progress deadline`; a CD pipeline times",
      "out. The Deployment shows old and new ReplicaSets side by side, with the new one never reaching its",
      "desired count. Traffic is usually still served by the old pods."
    ],
    affected: [
      "The **deployment controller** sets `Progressing=False` after `progressDeadlineSeconds` (600 by default)",
      "without progress. The real failure is in whatever stops new pods becoming available: the **scheduler**,",
      "the **kubelet**, the image, the probes, or a quota."
    ],
    rootCause: [
      "A rolling update creates new pods and removes old ones only as new ones become **available** (Ready for",
      "`minReadySeconds`). The rollout stops progressing when new pods cannot get there:",
      "",
      "- they are `Pending` (no capacity, taints, PVC zone, quota exhausted);",
      "- they crash or cannot pull their image;",
      "- they run but never pass readiness;",
      "- the ReplicaSet cannot create them at all (`FailedCreate` from a quota or admission webhook).",
      "",
      "The condition is a symptom aggregator: it tells you the rollout stopped, never why."
    ],
    investigation: [
      {
        title: "Find the new ReplicaSet and its pods",
        run: [
          "kubectl rollout status deployment/orders-api -n shop --timeout=10s",
          "kubectl get rs -n shop -l app=orders-api",
          "kubectl get pods -n shop -l app=orders-api -o wide"
        ],
        lookFor: "The newest ReplicaSet with fewer ready pods than desired, and the status of its pods."
      },
      {
        title: "Check whether the ReplicaSet could create pods",
        run: "kubectl describe rs <new-replicaset> -n shop | sed -n '/Events/,$p'",
        lookFor: "`FailedCreate` with `exceeded quota` or a webhook denial: no pods exist to inspect (see resource-quota-exceeded, webhook-unavailable)."
      },
      {
        title: "Follow the pod status to its own entry",
        run: "kubectl describe pod <new-pod> -n shop | sed -n '/Events/,$p'",
        lookFor: "`Pending` with a scheduler message, `ImagePullBackOff`, `CrashLoopBackOff`, or `Readiness probe failed`."
      }
    ],
    resolution: [
      "Roll back to restore the previous ReplicaSet as the target while you fix the cause:",
      "",
      "```sh",
      "kubectl rollout undo deployment/orders-api -n shop",
      "```",
      "",
      "Then fix the underlying pod failure and roll forward. If the cause was capacity, check that `maxSurge`",
      "pods can be scheduled: a rollout of a large Deployment needs headroom for the surge."
    ],
    prevention: [
      "Use `maxUnavailable: 0` with a modest `maxSurge` so stuck rollouts never reduce capacity.",
      "Let CD fail on `kubectl rollout status --timeout` and roll back automatically (or use progressive delivery with analysis).",
      "Alert on `kube_deployment_status_condition{condition=\"Progressing\",status=\"false\"}`."
    ],
    signals: [
      [4, "ProgressDeadlineExceeded"],
      [4, "exceeded its progress deadline"],
      [1, "Waiting for deployment .* rollout to finish"]
    ],
    samples: [
      "error: deployment \"orders-api\" exceeded its progress deadline",
      [
        "Conditions:",
        "  Type           Status  Reason",
        "  ----           ------  ------",
        "  Available      True    MinimumReplicasAvailable",
        "  Progressing    False   ProgressDeadlineExceeded"
      ]
    ],
    related: [
      "pending-insufficient-resources",
      "imagepullbackoff",
      "crashloopbackoff",
      "readiness-probe-failing",
      "resource-quota-exceeded"
    ],
    lab: "rollout-stuck",
    runbook: null
  }
]);
