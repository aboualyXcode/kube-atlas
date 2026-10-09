// Load balancing failures on EKS
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the eks map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "alb-5xx-during-deploys",
    title: "ALB 502 and 504 during deploys and scale-in",
    kind: "cause",
    layer: "load-balancing",
    scope: "eks",
    summary: "Old pods stop before the ALB stops sending them requests (or new pods get traffic too early), so every deploy and scale-in produces 502s and 504s.",
    propagation: {
      map: "eks",
      origins: [{ at: "application", note: "Exits on SIGTERM at once, no preStop drain" }],
      path: [
        { at: "aws-load-balancer-controller", note: "Deregisters the target seconds later" },
        { at: "elb", note: "Still routes requests to the gone pod" }
      ],
      symptom: { at: "users", note: "502 and 504 spikes during deploys" }
    },
    components: ["aws-load-balancer-controller", "elb", "application", "kubelet"],
    symptom: [
      "Short bursts of `502 Bad Gateway` (sometimes `504`) from the ALB line up with rollouts, HPA scale-in, or",
      "Karpenter consolidation. Application logs show no errors for those requests, because the requests never",
      "reached a healthy process."
    ],
    affected: [
      "The race between Kubernetes stopping a pod (**kubelet**, endpoints) and the **ALB** draining that target,",
      "which the **AWS Load Balancer Controller** deregisters only after the endpoint change. The fix lives in",
      "the **application's** shutdown behaviour and pod spec."
    ],
    rootCause: [
      "When a pod is deleted, two things start **at the same time**: the kubelet runs `preStop` and sends",
      "SIGTERM, and the endpoint removal propagates to the controller, which deregisters the target from the",
      "ALB, which then stops sending new requests. Deregistration takes seconds. If the process exits on",
      "SIGTERM immediately, the ALB keeps sending requests to a closed port for those seconds: `502`.",
      "",
      "The other classic 502: **keep-alive mismatch**. The ALB reuses idle connections for up to its idle",
      "timeout (60 seconds by default). If the application closes idle connections sooner (Node.js defaults to",
      "5 seconds), the ALB occasionally sends a request on a connection the backend just closed.",
      "",
      "On rollouts, new pods can also be registered but not yet healthy in the target group while old ones are",
      "already gone, unless pod readiness gates make Kubernetes wait for ALB health."
    ],
    investigation: [
      {
        title: "Correlate 5xx with pod lifecycle events",
        run: [
          "aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB --metric-name HTTPCode_ELB_502_Count \\",
          "  --dimensions Name=LoadBalancer,Value=app/k8s-shop-storefro-1a2b3c/4d5e6f --start-time 2026-10-06T09:00:00Z \\",
          "  --end-time 2026-10-06T10:00:00Z --period 60 --statistics Sum",
          "kubectl get events -n shop --field-selector reason=Killing --sort-by=.lastTimestamp"
        ],
        lookFor: "5xx minutes that match `Killing` events and rollouts."
      },
      {
        title: "Check the pod spec for graceful shutdown",
        run: [
          "kubectl get deploy storefront -n shop -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}{\"\\n\"}{.spec.template.spec.containers[0].lifecycle}{\"\\n\"}'",
          "kubectl get ns shop --show-labels | grep pod-readiness-gate-inject"
        ],
        lookFor: "No `preStop` delay, and no readiness gate injection label."
      },
      {
        title: "Check the target group's deregistration delay and the app's keep-alive",
        run: [
          "aws elbv2 describe-target-group-attributes --target-group-arn <tg-arn> \\",
          "  --query \"Attributes[?Key=='deregistration_delay.timeout_seconds']\""
        ],
        lookFor: "A delay longer than the pod's grace period, or an application idle timeout shorter than the ALB's."
      }
    ],
    resolution: [
      "Keep the pod serving while the ALB drains it, then shut down gracefully:",
      "",
      "```yaml",
      "spec:",
      "  terminationGracePeriodSeconds: 60",
      "  containers:",
      "    - name: web",
      "      lifecycle:",
      "        preStop:",
      "          sleep: { seconds: 20 }     # longer than deregistration propagation",
      "```",
      "",
      "Handle SIGTERM by finishing in-flight requests before exiting. Set the application's keep-alive idle",
      "timeout above the ALB idle timeout. Label the namespace with",
      "`elbv2.k8s.aws/pod-readiness-gate-inject=enabled` so rollouts wait for new targets to be healthy, and set",
      "`deregistration_delay.timeout_seconds` below the grace period."
    ],
    prevention: [
      "Make graceful shutdown (preStop delay, SIGTERM handling, keep-alive) part of the service template.",
      "Run a synthetic load test during a rollout in staging and fail it on any 5xx.",
      "Alert on ALB 5xx ratio per target group, not only on application error rates."
    ],
    signals: [
      [4, "502 Bad Gateway"],
      [4, "504 Gateway Time-?out"],
      [3, "HTTPCode_ELB_50[24]_Count"],
      [2, "during (deploys?|rollouts?|scale-in)"]
    ],
    samples: [
      "HTTPCode_ELB_502_Count spikes to 140 for two minutes at every orders-api rollout",
      "curl: (22) The requested URL returned error: 502 Bad Gateway during deploys of storefront"
    ],
    related: ["alb-targets-unhealthy", "readiness-probe-failing", "rollout-stuck"],
    lab: null,
    runbook: "load-balancer-5xx"
  },
  {
    id: "alb-targets-unhealthy",
    title: "ALB targets unhealthy (503 or no healthy targets)",
    kind: "symptom",
    layer: "load-balancing",
    scope: "eks",
    summary: "The ALB's health checks fail, so it has no healthy targets: wrong path or port, a security group blocks it, or the pods are not ready.",
    propagation: {
      map: "eks",
      origins: [
        { at: "security-groups", note: "SG does not allow ALB to pod port" },
        { at: "application", note: "Health check path does not return 200" }
      ],
      path: [{ at: "elb", note: "Marks targets unhealthy" }],
      symptom: { at: "users", note: "503 Service Unavailable" }
    },
    components: ["aws-load-balancer-controller", "elb", "security-groups", "application"],
    symptom: [
      "The ALB returns `503 Service Temporarily Unavailable` (no healthy targets) or errors for a fraction of",
      "requests. In the target group, targets are `unhealthy` with a reason code, while the pods look fine in",
      "`kubectl`."
    ],
    affected: [
      "The **ALB** health checks targets registered by the **AWS Load Balancer Controller**. The health check",
      "path, the **security groups** between the ALB and pods, or the **application's** health endpoint are",
      "usually at fault."
    ],
    rootCause: [
      "Kubernetes readiness and ALB health are separate checks. A pod can be Ready while the ALB considers it",
      "unhealthy:",
      "",
      "- `Target.ResponseCodeMismatch`: the ALB health check path (default `/`) returns 404, 301 or 401 while",
      "  the readiness probe uses `/ready`.",
      "- `Target.Timeout`: the ALB cannot reach the pod. With `target-type: ip` the ALB connects directly to the",
      "  pod IP; with security groups for pods, the pod's own security group must allow the ALB's security group.",
      "  The controller manages backend rules automatically unless that is disabled.",
      "- `Target.NotRegistered` or an empty target group: the Service has no ready endpoints, or a",
      "  `TargetGroupBinding` points to the wrong Service or port.",
      "- All targets unhealthy: the ALB fails open and routes to all of them, so errors can look partial."
    ],
    investigation: [
      {
        title: "Read target health reasons",
        run: [
          "kubectl get targetgroupbindings -n shop -o wide",
          "aws elbv2 describe-target-health --target-group-arn <tg-arn> \\",
          "  --query 'TargetHealthDescriptions[].[Target.Id,Target.Port,TargetHealth.State,TargetHealth.Reason,TargetHealth.Description]' --output table"
        ],
        lookFor: "The reason code; it chooses the next step."
      },
      {
        title: "Compare the ALB health check with the readiness probe",
        run: [
          "aws elbv2 describe-target-groups --target-group-arns <tg-arn> \\",
          "  --query 'TargetGroups[].[HealthCheckPath,HealthCheckPort,Matcher.HttpCode,HealthCheckTimeoutSeconds]'",
          "kubectl get deploy storefront -n shop -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet}'"
        ],
        lookFor: "Different paths or ports."
      },
      {
        title: "Check the network path from the ALB to pods",
        run: [
          "kubectl get securitygrouppolicies -n shop",
          "aws ec2 describe-security-groups --group-ids <pod-or-node-sg> --query 'SecurityGroups[].IpPermissions'"
        ],
        lookFor: "No inbound rule from the ALB's security group on the target port."
      }
    ],
    resolution: [
      "Align the ALB health check with the readiness endpoint:",
      "",
      "```yaml",
      "metadata:",
      "  annotations:",
      "    alb.ingress.kubernetes.io/healthcheck-path: /ready",
      "    alb.ingress.kubernetes.io/success-codes: \"200\"",
      "```",
      "",
      "Allow the ALB security group to reach the target port on pods or nodes (leave the controller's",
      "backend security group management on), and fix the Service or endpoints if the target group is empty."
    ],
    prevention: [
      "Set the health check path in the Ingress template for every service; never rely on `/`.",
      "Alert on `UnHealthyHostCount > 0` per target group and on `HealthyHostCount` reaching zero."
    ],
    signals: [
      [5, "Target\\.(Timeout|ResponseCodeMismatch|FailedHealthChecks|NotRegistered|NotInUse)"],
      [4, "Health checks failed"],
      [3, "503 Service Temporarily Unavailable"],
      [2, "unhealthy"]
    ],
    samples: [
      [
        "$ aws elbv2 describe-target-health --target-group-arn arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/k8s-shop-storefro-9a8b7c/1a2b3c",
        "10.20.37.14   8080   unhealthy   Target.Timeout   Request timed out",
        "10.20.52.88   8080   unhealthy   Target.ResponseCodeMismatch   Health checks failed with these codes: [404]"
      ],
      "HTTP/1.1 503 Service Temporarily Unavailable (awselb/2.0)"
    ],
    related: [
      "readiness-probe-failing",
      "service-no-endpoints",
      "alb-5xx-during-deploys",
      "connection-timeouts"
    ],
    lab: null,
    runbook: "load-balancer-5xx"
  },
  {
    id: "ingress-no-address",
    title: "Ingress has no ADDRESS (ALB not provisioned)",
    kind: "symptom",
    layer: "load-balancing",
    scope: "eks",
    summary: "The AWS Load Balancer Controller cannot build the ALB, so the Ingress never gets an address.",
    propagation: {
      map: "eks",
      origins: [
        { at: "iam", note: "Controller role lacks ELB or EC2 permissions" },
        { at: "vpc", note: "No subnets tagged kubernetes.io/role/elb" }
      ],
      path: [{ at: "aws-load-balancer-controller", note: "Reconcile fails: FailedBuildModel" }],
      symptom: { at: "client", note: "kubectl get ingress: ADDRESS empty" }
    },
    components: ["aws-load-balancer-controller", "elb", "vpc", "iam"],
    symptom: [
      "`kubectl get ingress` shows an empty `ADDRESS` column; DNS for the host has nothing to point at, and no",
      "ALB exists. Sometimes there are no events at all, which is itself the clue."
    ],
    affected: [
      "The **AWS Load Balancer Controller** reconciles Ingresses of its class into ALBs. The cause is that it is",
      "not handling this Ingress, or fails at building or deploying the ALB (subnets, **IAM**, certificates,",
      "annotations)."
    ],
    rootCause: [
      "- **No class:** `CLASS <none>` and no default IngressClass, or a class of another controller. Without",
      "  `ingressClassName: alb` (or a default IngressClass), the controller ignores the Ingress and nothing",
      "  records any event.",
      "- **Build failures:** subnets not discoverable, an invalid annotation, two Ingresses in one IngressGroup",
      "  with conflicting settings (one bad member blocks the whole group).",
      "- **Deploy failures:** IAM denies an action, an HTTPS listener without `certificate-arn` (or no ACM",
      "  certificate matching the host for discovery), a WAF or security group reference that does not exist.",
      "- **Backend Service type:** with `target-type: instance` the backend Service must be `NodePort` or",
      "  `LoadBalancer`; `ip` targets work with `ClusterIP`."
    ],
    investigation: [
      {
        title: "Check the class and events",
        run: [
          "kubectl get ingress storefront -n shop -o jsonpath='{.spec.ingressClassName}'; echo",
          "kubectl get ingressclass",
          "kubectl describe ingress storefront -n shop | sed -n '/Events/,$p'"
        ],
        lookFor: "No class (no events), `FailedBuildModel` or `FailedDeployModel` with the reason."
      },
      {
        title: "If it is part of a group, check every member",
        run: "kubectl get ingress -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{\"\\t\"}{.metadata.annotations.alb\\.ingress\\.kubernetes\\.io/group\\.name}{\"\\n\"}{end}'",
        lookFor: "Another Ingress in the same group with an error; fix that one."
      },
      {
        title: "Read the controller logs",
        run: "kubectl logs -n kube-system deploy/aws-load-balancer-controller --tail=200 | grep -i -E \"error|storefront\"",
        lookFor: "The exact AWS API error."
      }
    ],
    resolution: [
      "Set `ingressClassName: alb`, then fix what the event names: tag public subnets with",
      "`kubernetes.io/role/elb=1`, attach the current controller IAM policy, add",
      "`alb.ingress.kubernetes.io/certificate-arn` or issue an ACM certificate for the host, or correct the",
      "annotation. The controller retries automatically."
    ],
    prevention: [
      "Mark one IngressClass as default, and validate Ingress annotations in CI.",
      "Keep IngressGroups owned by one team, or give each team its own group, so one bad Ingress cannot block others.",
      "Alert on Ingresses without an address for more than 10 minutes."
    ],
    signals: [
      [5, "A certificate must be specified for HTTPS listeners"],
      [4, "FailedBuildModel"],
      [4, "FailedDeployModel"],
      [3, "ingressClassName"],
      [3, "CLASS\\s+HOSTS\\s+ADDRESS"],
      [3, "elasticloadbalancing:"],
      [2, "\\s+ingress\\s+Failed (build|deploy) model"],
      [3, "couldn't auto-discover subnets"]
    ],
    samples: [
      "Warning  FailedBuildModel  12s (x9 over 5m)  ingress  Failed build model due to couldn't auto-discover subnets: unable to resolve at least one subnet (0 match VPC and tags: [kubernetes.io/role/elb])",
      "Warning  FailedDeployModel  3s  ingress  Failed deploy model due to ValidationError: A certificate must be specified for HTTPS listeners",
      [
        "NAME         CLASS    HOSTS                  ADDRESS   PORTS   AGE",
        "storefront   <none>   shop.larder.example              80      40m"
      ]
    ],
    related: ["loadbalancer-pending", "alb-targets-unhealthy", "x509-certificate-errors"],
    lab: null,
    runbook: "load-balancer-5xx"
  },
  {
    id: "loadbalancer-pending",
    title: "Service type LoadBalancer stuck in <pending>",
    kind: "symptom",
    layer: "load-balancing",
    scope: "eks",
    summary: "Nothing provisions a load balancer for the type LoadBalancer Service, so its EXTERNAL-IP stays <pending>.",
    propagation: {
      map: "eks",
      origins: [
        { at: "vpc", note: "No suitably tagged subnets" },
        { at: "iam", note: "Controller lacks permissions" }
      ],
      path: [
        {
          at: "aws-load-balancer-controller",
          note: "Not watching this Service, or reconcile fails"
        }
      ],
      symptom: { at: "client", note: "EXTERNAL-IP <pending>" }
    },
    components: ["aws-load-balancer-controller", "cloud-controller-manager", "vpc", "iam", "elb"],
    symptom: [
      "`kubectl get svc` shows `EXTERNAL-IP <pending>` indefinitely. No load balancer appears in the EC2 console,",
      "or one appears with no healthy targets. Events on the Service, if any, name the failure."
    ],
    affected: [
      "Whichever controller owns the Service: the **AWS Load Balancer Controller** (Services with",
      "`loadBalancerClass: service.k8s.aws/nlb`, which recent controller versions set by default) or the legacy",
      "service controller in the **cloud controller manager**. They need tagged **subnets**, **IAM**",
      "permissions and **ELB** quota."
    ],
    rootCause: [
      "`<pending>` means no controller has written an address to the Service's status. Either no controller is",
      "handling it, or the one handling it fails:",
      "",
      "- **No controller:** `loadBalancerClass: service.k8s.aws/nlb` is set but the AWS Load Balancer Controller",
      "  is not installed or not running, so nobody claims the Service.",
      "- **Subnet discovery:** without explicit subnets, controllers look for subnets tagged",
      "  `kubernetes.io/role/elb=1` (internet-facing) or `kubernetes.io/role/internal-elb=1` (internal), one per",
      "  AZ, with enough free addresses.",
      "- **IAM:** the controller's role lacks Elastic Load Balancing or EC2 permissions (an outdated policy for",
      "  a newer controller version is common).",
      "- **Quotas and conflicts:** load balancer or target group quota reached, a security group limit, or an",
      "  annotation combination the controller rejects."
    ],
    investigation: [
      {
        title: "Read the Service's events and class",
        run: [
          "kubectl describe svc orders-grpc -n shop | sed -n '/Annotations/,/Session/p;/Events/,$p'",
          "kubectl get svc orders-grpc -n shop -o jsonpath='{.spec.loadBalancerClass}'; echo"
        ],
        lookFor: "`FailedBuildModel` or `FailedDeployModel` from the controller, `SyncLoadBalancerFailed` from the legacy controller, or no events at all."
      },
      {
        title: "Check the controller is running and read its logs",
        run: [
          "kubectl get deploy aws-load-balancer-controller -n kube-system",
          "kubectl logs -n kube-system deploy/aws-load-balancer-controller --tail=100 | grep -i -E \"error|orders-grpc\""
        ],
        lookFor: "Not installed, crash looping, or the AWS error for this Service."
      },
      {
        title: "Check subnet tags per AZ",
        run: [
          "aws ec2 describe-subnets --filters Name=vpc-id,Values=<vpc-id> \\",
          "  --query 'Subnets[].[SubnetId,AvailabilityZone,AvailableIpAddressCount,Tags[?Key==`kubernetes.io/role/elb`]|[0].Value,Tags[?Key==`kubernetes.io/role/internal-elb`]|[0].Value]' --output table"
        ],
        lookFor: "No subnet with the role tag for the requested scheme, or subnets almost out of addresses."
      }
    ],
    resolution: [
      "Install the AWS Load Balancer Controller with a role that has the policy matching its version, tag the",
      "subnets for the scheme you need, or name subnets explicitly with the",
      "`service.beta.kubernetes.io/aws-load-balancer-subnets` annotation. Be explicit about intent on every",
      "Service:",
      "",
      "```yaml",
      "metadata:",
      "  annotations:",
      "    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing",
      "    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip",
      "spec:",
      "  type: LoadBalancer",
      "  loadBalancerClass: service.k8s.aws/nlb",
      "```"
    ],
    prevention: [
      "Tag subnets for load balancer discovery in the VPC code, per AZ, from day one.",
      "Upgrade the controller's IAM policy with every controller upgrade.",
      "Alert on Services of type LoadBalancer without an ingress address for more than 10 minutes."
    ],
    signals: [
      [4, "LoadBalancer\\s+\\S+\\s+<pending>"],
      [5, "could not find any suitable subnets for creating the ELB"],
      [4, "Failed build model due to"],
      [4, "Failed deploy model due to"],
      [3, "couldn't auto-discover subnets"],
      [2, "SyncLoadBalancerFailed"],
      [3, "elasticloadbalancing:"],
      [2, "\\s+service\\s+Failed (build|deploy) model"]
    ],
    samples: [
      [
        "NAME           TYPE           CLUSTER-IP      EXTERNAL-IP   PORT(S)          AGE",
        "orders-grpc    LoadBalancer   172.20.61.201   <pending>     443:31845/TCP    25m"
      ],
      "Warning  SyncLoadBalancerFailed  1m  service-controller  Error syncing load balancer: failed to ensure load balancer: could not find any suitable subnets for creating the ELB",
      "Warning  FailedDeployModel  20s  service  Failed deploy model due to AccessDenied: User: arn:aws:sts::111122223333:assumed-role/aws-load-balancer-controller/1696589312 is not authorized to perform: elasticloadbalancing:CreateLoadBalancer"
    ],
    related: ["ingress-no-address", "webhook-unavailable", "alb-targets-unhealthy", "pod-aws-access-denied"],
    lab: null,
    runbook: "load-balancer-5xx"
  }
]);
