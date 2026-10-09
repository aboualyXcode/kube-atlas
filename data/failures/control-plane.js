// Control plane failures: API server, aggregation, etcd
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the cluster map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "api-throttling",
    title: "API server throttling (429 Too Many Requests) and slow API",
    kind: "cause",
    layer: "control-plane",
    scope: "any",
    summary: "A client floods the API server, and API Priority and Fairness starts rejecting requests with 429 Too Many Requests.",
    propagation: {
      map: "cluster",
      origins: [{ at: "client", note: "A controller or script lists and watches too aggressively" }],
      path: [
        { at: "kube-apiserver", note: "Priority and Fairness queues fill: 429" },
        { at: "etcd", note: "Large lists load the datastore" }
      ],
      symptom: { at: "client", note: "429s, slow kubectl, controllers lag" },
      branches: [
        { from: "kube-apiserver", at: "kube-controller-manager", note: "Controllers fall behind" },
        { from: "kube-apiserver", at: "kubelet", note: "Status updates delayed" }
      ]
    },
    components: ["kube-apiserver", "etcd", "admission-webhooks", "client"],
    symptom: [
      "`kubectl` is slow or returns `429 TooManyRequests`; controllers (Argo CD, operators, autoscalers) lag",
      "and log throttling; deploys take minutes to apply. Workloads already running are unaffected."
    ],
    affected: [
      "**API Priority and Fairness** in the **API server** queues and rejects requests per priority level to",
      "protect itself and **etcd**. Client libraries also throttle themselves (`client-side throttling`). The",
      "load almost always comes from a misbehaving **client** or a slow **admission webhook**."
    ],
    rootCause: [
      "Every request is classified by FlowSchemas into a priority level with a share of the API server's",
      "concurrency. When a level's queues fill, its requests get 429 with `Retry-After`. Typical sources:",
      "",
      "- a controller doing full `LIST` calls of large collections (all pods, all secrets) in a loop instead of",
      "  using informers and watches;",
      "- many `kubectl` scripts or CI jobs polling;",
      "- a DaemonSet whose pods each list cluster-wide objects at startup, multiplied by node count;",
      "- slow admission webhooks holding request slots;",
      "- huge objects or collections (thousands of ConfigMaps from Helm history, events) making each list expensive.",
      "",
      "`Waited for ... due to client-side throttling` is the client's own rate limiter (QPS and burst), not",
      "the server: it means that client is chatty."
    ],
    investigation: [
      {
        title: "Find which priority levels reject and queue",
        run: [
          "kubectl get --raw /metrics | grep -E '^apiserver_flowcontrol_(rejected_requests_total|current_inqueue_requests)' | sort -t' ' -k2 -nr | head",
          "kubectl get flowschemas,prioritylevelconfigurations"
        ],
        lookFor: "The `priority_level` and `flow_schema` with rejections."
      },
      {
        title: "Find the noisy clients",
        run: [
          "aws logs start-query --log-group-name /aws/eks/larder-prod/cluster --start-time $(date -d '-1 hour' +%s) --end-time $(date +%s) \\",
          "  --query-string 'filter @logStream like \"kube-apiserver-audit\" | stats count(*) as calls by user.username, userAgent, verb | sort calls desc | limit 20'"
        ],
        lookFor: "One user agent or service account with orders of magnitude more calls, especially `list` verbs."
      },
      {
        title: "Check webhook latency and object counts",
        run: "kubectl get --raw /metrics | grep -E 'apiserver_admission_webhook_admission_duration_seconds_sum|apiserver_storage_objects' | sort -t' ' -k2 -nr | head -20",
        lookFor: "Slow webhooks, or resource types with very large counts."
      }
    ],
    resolution: [
      "Fix or throttle the noisy client (use informers, add a resync interval, lower its QPS), clean up object",
      "bloat (Helm `--history-max`, completed Jobs with `ttlSecondsAfterFinished`), and fix slow webhooks. If",
      "a legitimate high-volume controller is starved, give it a dedicated FlowSchema and priority level rather",
      "than raising everyone's limits."
    ],
    prevention: [
      "Alert on `apiserver_flowcontrol_rejected_requests_total` rate above zero for 10 minutes, and on API latency SLOs.",
      "Review new controllers and operators for list/watch behaviour before installing them cluster-wide.",
      "Keep object counts bounded: Helm history limits, Job TTLs, event retention."
    ],
    signals: [
      [5, "the server has received too many requests and has asked us to try again later"],
      [4, "\\(TooManyRequests\\)"],
      [4, "due to client-side throttling"],
      [3, "apiserver_flowcontrol_rejected_requests_total"]
    ],
    samples: [
      "Error from server (TooManyRequests): the server has received too many requests and has asked us to try again later (get pods)",
      "I1006 10:12:00.401 request.go:697] Waited for 1.181s due to client-side throttling, not priority and fairness, request: GET:https://4F1A.gr7.eu-west-1.eks.amazonaws.com/api/v1/namespaces/shop/pods"
    ],
    related: ["webhook-unavailable", "etcd-space-exceeded", "apiservice-unavailable"],
    lab: null,
    runbook: "api-server-degraded"
  },
  {
    id: "apiservice-unavailable",
    title: "APIService unavailable (metrics.k8s.io and others), namespaces stuck Terminating",
    kind: "cause",
    layer: "control-plane",
    scope: "any",
    summary: "An aggregated API such as metrics.k8s.io is registered but its backend is down, which breaks discovery for clients and controllers.",
    propagation: {
      map: "cluster",
      origins: [{ at: "metrics-server", note: "Backend pods down or unreachable" }],
      path: [
        { at: "admission-webhooks", note: "APIService reports Available=False" },
        { at: "kube-apiserver", note: "Discovery fails for that API group" }
      ],
      symptom: { at: "client", note: "unable to retrieve the complete list of server APIs" },
      branches: [
        {
          from: "kube-apiserver",
          at: "kube-controller-manager",
          note: "Namespace deletion and HPA stall"
        }
      ]
    },
    components: ["kube-apiserver", "admission-webhooks", "metrics-server"],
    symptom: [
      "`kubectl` commands print warnings about `unable to retrieve the complete list of server APIs`; `kubectl",
      "top` fails; HPAs show `<unknown>`; a namespace stays in `Terminating` for days; some controllers that",
      "discover all API groups (garbage collector, Helm, Argo CD) misbehave."
    ],
    affected: [
      "The **aggregation layer** of the **API server** proxies an API group to an in-cluster Service (an",
      "APIService). When that backend (often **metrics-server**) is down or unreachable, discovery for the",
      "group fails, and anything that needs complete discovery is affected."
    ],
    rootCause: [
      "An APIService registers a group (for example `v1beta1.metrics.k8s.io`) served by a Service in the",
      "cluster. The API server checks it; if the backend is unavailable, the APIService becomes",
      "`Available=False` with `MissingEndpoints` or `FailedDiscoveryCheck`.",
      "",
      "Namespace deletion needs to enumerate every resource type to delete contents; if discovery for any group",
      "fails, the namespace controller cannot be sure the namespace is empty, so it waits forever with",
      "`NamespaceDeletionDiscoveryFailure`. One broken metrics add-on can therefore block every namespace deletion",
      "in the cluster.",
      "",
      "Causes: the backend pods are down, the Service has no endpoints, the API server cannot reach the pods (on",
      "EKS, security groups between the control plane ENIs and nodes on the backend's port), or an add-on was",
      "uninstalled and left its APIService behind."
    ],
    investigation: [
      {
        title: "Find unavailable APIServices",
        run: [
          "kubectl get apiservices | grep -v True",
          "kubectl describe apiservice v1beta1.metrics.k8s.io | sed -n '/Status/,$p'"
        ],
        lookFor: "`False` with `MissingEndpoints`, `FailedDiscoveryCheck` or `ServiceNotFound`."
      },
      {
        title: "Check the backend",
        run: [
          "kubectl get pods,endpointslices -n kube-system -l k8s-app=metrics-server",
          "kubectl logs -n kube-system deploy/metrics-server --tail=50"
        ],
        lookFor: "Pods down, or errors scraping kubelets (`x509` or timeouts to port 10250)."
      },
      {
        title: "For a stuck namespace, read its conditions",
        run: "kubectl get ns old-feature -o jsonpath='{range .status.conditions[*]}{.type}{\"=\"}{.status}{\" \"}{.message}{\"\\n\"}{end}'",
        lookFor: "`NamespaceDeletionDiscoveryFailure` naming the group, or remaining resources with finalizers."
      }
    ],
    resolution: [
      "Restore the backend (fix metrics-server, open the security group port from the cluster security group to",
      "the nodes on its secure port), or, if the add-on was intentionally removed, delete the orphaned APIService:",
      "",
      "```sh",
      "kubectl delete apiservice v1beta1.metrics.k8s.io",
      "```",
      "",
      "Stuck namespaces finish deleting on their own once discovery works again."
    ],
    prevention: [
      "Uninstall add-ons with their charts or add-on APIs, never by deleting only their Deployments.",
      "Run aggregated API servers with two replicas and a PDB.",
      "Alert on `aggregator_unavailable_apiservice` greater than zero."
    ],
    signals: [
      [5, "unable to retrieve the complete list of server APIs"],
      [4, "the server is currently unable to handle the request"],
      [4, "NamespaceDeletionDiscoveryFailure"],
      [3, "FailedDiscoveryCheck|MissingEndpoints"]
    ],
    samples: [
      "E1006 09:40:11 memcache.go:287] couldn't get resource list for metrics.k8s.io/v1beta1: the server is currently unable to handle the request",
      "error: unable to retrieve the complete list of server APIs: metrics.k8s.io/v1beta1: the server is currently unable to handle the request",
      "NamespaceDeletionDiscoveryFailure  True  DiscoveryFailed  Discovery failed for some groups, 1 failing: unable to retrieve the complete list of server APIs: metrics.k8s.io/v1beta1: stale GroupVersion discovery: metrics.k8s.io/v1beta1"
    ],
    related: ["hpa-unknown-metrics", "pod-stuck-terminating", "webhook-unavailable"],
    lab: null,
    runbook: "api-server-degraded"
  },
  {
    id: "deprecated-api-removed",
    title: "no matches for kind ... in version ... (API removed after upgrade)",
    kind: "cause",
    layer: "control-plane",
    scope: "any",
    summary: "After an upgrade, manifests still use an API version the cluster no longer serves.",
    propagation: {
      map: "cluster",
      origins: [{ at: "workload-controllers", note: "Manifests use a removed apiVersion" }],
      path: [{ at: "kube-apiserver", note: "No longer serves that group and version" }],
      symptom: { at: "client", note: "no matches for kind ... in version ..." }
    },
    components: ["kube-apiserver", "client", "workload-controllers"],
    symptom: [
      "After a cluster upgrade, applying manifests or upgrading Helm releases fails with `no matches for kind",
      "X in version Y`. Existing objects keep working; only writes from old manifests fail. GitOps tools show",
      "sync errors."
    ],
    affected: [
      "The **API server** no longer serves that API version. The stale version lives in your manifests, Helm",
      "charts, Helm release history, or **client** tooling."
    ],
    rootCause: [
      "Kubernetes removes beta API versions some releases after their replacement goes GA. Objects stored in",
      "etcd are migrated automatically, so they keep running, but any request that names the removed version",
      "fails. Helm is a special trap: it stores the previous release's manifest, and an upgrade fails if that",
      "stored manifest uses a removed version, even when the new chart is fixed."
    ],
    investigation: [
      {
        title: "Find deprecated API usage before and after upgrading",
        run: [
          "aws eks list-insights --cluster-name larder-prod --filter categories=UPGRADE_READINESS",
          "kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis"
        ],
        lookFor: "Insights in `ERROR` or `WARNING` state, and the clients still calling deprecated versions."
      },
      {
        title: "Scan manifests and charts",
        run: [
          "pluto detect-files -d apps/ --target-versions k8s=v1.35.0",
          "pluto detect-helm --target-versions k8s=v1.35.0"
        ],
        lookFor: "Files and releases using removed versions."
      }
    ],
    resolution: [
      "Update manifests and charts to the current versions (for example `policy/v1` for PodDisruptionBudget,",
      "`autoscaling/v2` for HPA) and re-apply. For Helm releases whose stored manifest blocks upgrades, rewrite",
      "the release history with the `helm-mapkubeapis` plugin, then upgrade."
    ],
    prevention: [
      "Treat EKS upgrade insights as a gate: no control plane upgrade while any insight is in error.",
      "Run `pluto` or `kubent` in CI against the next Kubernetes version.",
      "Upgrade one minor version at a time, staging first, as described in the upgrade runbook."
    ],
    signals: [
      [5, "no matches for kind \"[^\"]+\" in version \"[^\"]+\""],
      [4, "resource mapping not found for name"],
      [3, "unable to build kubernetes objects from current release manifest"],
      [2, "ensure CRDs are installed first"]
    ],
    samples: [
      "error: resource mapping not found for name: \"orders-api\" namespace: \"shop\" from \"pdb.yaml\": no matches for kind \"PodDisruptionBudget\" in version \"policy/v1beta1\" ensure CRDs are installed first",
      "Error: UPGRADE FAILED: unable to build kubernetes objects from current release manifest: resource mapping not found for name: \"storefront\" namespace: \"shop\" from \"\": no matches for kind \"HorizontalPodAutoscaler\" in version \"autoscaling/v2beta2\""
    ],
    related: ["api-throttling"],
    lab: null,
    runbook: "cluster-upgrade"
  },
  {
    id: "etcd-space-exceeded",
    title: "etcd database space exceeded or request too large",
    kind: "cause",
    layer: "control-plane",
    scope: "any",
    summary: "etcd reached its storage quota, or one object exceeded the size limit, so writes fail across the cluster.",
    propagation: {
      map: "cluster",
      origins: [{ at: "workload-controllers", note: "Huge objects or runaway object counts" }],
      path: [
        { at: "etcd", note: "Quota exceeded: NOSPACE alarm, writes rejected" },
        { at: "kube-apiserver", note: "Returns errors for every write" }
      ],
      symptom: { at: "client", note: "etcdserver: mvcc: database space exceeded" },
      branches: [
        {
          from: "kube-apiserver",
          at: "kube-controller-manager",
          note: "Every controller fails to write"
        },
        { from: "kube-apiserver", at: "kubelet", note: "Pod status updates fail" }
      ]
    },
    components: ["etcd", "kube-apiserver", "workload-controllers"],
    symptom: [
      "Writes to the cluster fail with `etcdserver: mvcc: database space exceeded` while reads still work; or a",
      "single object fails to save with `request is too large`. In degraded clusters, `etcdserver: request",
      "timed out` and `leader changed` appear intermittently."
    ],
    affected: [
      "**etcd**, through the **API server**. On EKS etcd is managed and you cannot reach it, but you control",
      "the objects that fill it; on self-managed clusters, you own etcd too."
    ],
    rootCause: [
      "etcd keeps every revision of every key until compaction, and its file only shrinks after",
      "defragmentation. When the database reaches its quota (2 GiB by default upstream, configurable to about",
      "8 GiB), etcd raises a `NOSPACE` alarm and rejects writes. A single request is limited to about 1.5 MiB,",
      "so very large ConfigMaps, Secrets or CRs fail individually.",
      "",
      "Growth usually comes from object churn or bloat: thousands of Helm release Secrets, events, completed",
      "Jobs and pods, CRDs with huge status, or a controller that updates objects in a tight loop (each update",
      "is a new revision). Timeouts and leader changes point to slow disks or overloaded members."
    ],
    investigation: [
      {
        title: "Find what consumes storage (works on EKS)",
        run: [
          "kubectl get --raw /metrics | grep -E '^apiserver_storage_(objects|size_bytes)' | sort -t' ' -k2 -nr | head -20",
          "kubectl get secrets -A -l owner=helm --no-headers | wc -l"
        ],
        lookFor: "Resource types with very large counts, and the reported database size."
      },
      {
        title: "On self-managed clusters, check etcd directly",
        run: [
          "ETCDCTL_API=3 etcdctl --endpoints=$ENDPOINTS endpoint status --write-out=table",
          "ETCDCTL_API=3 etcdctl --endpoints=$ENDPOINTS alarm list"
        ],
        lookFor: "`DB SIZE` near the quota and a `NOSPACE` alarm."
      }
    ],
    resolution: [
      "Delete the bloat (old Helm release history, completed Jobs, stale CRs). On self-managed etcd, then",
      "compact, defragment one member at a time, and disarm the alarm:",
      "",
      "```sh",
      "rev=$(etcdctl endpoint status --write-out=json | jq '.[0].Status.header.revision')",
      "etcdctl compact \"$rev\" && etcdctl defrag --endpoints=$MEMBER && etcdctl alarm disarm",
      "```",
      "",
      "Keep objects small: store large payloads in S3 and reference them."
    ],
    prevention: [
      "Set Helm `--history-max`, `ttlSecondsAfterFinished` on Jobs, and limits on CR status size.",
      "Alert on `apiserver_storage_size_bytes` at 70% of the quota and on rapid growth of `apiserver_storage_objects`.",
      "On self-managed clusters, schedule defragmentation and take etcd snapshots before every change."
    ],
    signals: [
      [5, "mvcc: database space exceeded"],
      [5, "etcdserver: request is too large"],
      [4, "etcdserver: (request timed out|leader changed)"],
      [3, "alarm:NOSPACE"]
    ],
    samples: [
      "Error from server: etcdserver: mvcc: database space exceeded",
      "Error from server: error when creating \"big-configmap.yaml\": etcdserver: request is too large"
    ],
    related: ["api-throttling", "deprecated-api-removed"],
    lab: null,
    runbook: "api-server-degraded"
  }
]);
