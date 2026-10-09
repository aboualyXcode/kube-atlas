// Identity failures: who you are, and what you may do
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the cluster and eks map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "kubectl-unauthorized",
    title: "You must be logged in to the server (Unauthorized)",
    kind: "cause",
    layer: "identity",
    scope: "eks",
    summary: "The API server does not recognize your credentials: the wrong IAM identity, no access entry, or an expired token.",
    propagation: {
      map: "eks",
      origins: [{ at: "iam", note: "Your IAM principal has no access entry" }],
      path: [{ at: "kube-apiserver", note: "Authentication fails: 401" }],
      symptom: { at: "client", note: "You must be logged in to the server (Unauthorized)" }
    },
    components: ["client", "kube-apiserver", "iam"],
    symptom: [
      "Every `kubectl` command fails with `You must be logged in to the server (Unauthorized)`, or `the server",
      "has asked for the client to provide credentials`. A CI pipeline that worked yesterday fails to deploy."
    ],
    affected: [
      "**Authentication** in the **API server** rejected the request: the credentials **kubectl** sent are not",
      "valid for this cluster or map to no known identity. On EKS, the identity is an **IAM** principal."
    ],
    rootCause: [
      "On EKS, `kubectl` runs `aws eks get-token`, which signs a token as your current IAM principal. The API",
      "server verifies it and maps the principal to a Kubernetes identity through **access entries** (or the",
      "legacy `aws-auth` ConfigMap). `Unauthorized` (401) means one of:",
      "",
      "- the principal has **no access entry** (or `aws-auth` mapping): a new role, a renamed SSO permission",
      "  set, a CI role, or the cluster creator's access removed;",
      "- you are **someone else** than you think: wrong `AWS_PROFILE`, an assumed role, expired SSO session",
      "  falling back to other credentials;",
      "- the kubeconfig points at **another cluster** or region;",
      "- a stale or manually pasted token expired (tokens live 15 minutes).",
      "",
      "Compare with `Forbidden` (403): you were recognised, but RBAC denies the action."
    ],
    investigation: [
      {
        title: "Confirm who you are to AWS",
        run: [
          "aws sts get-caller-identity",
          "kubectl config current-context",
          "kubectl config view --minify -o jsonpath='{.users[0].user.exec.args}'; echo"
        ],
        lookFor: "The account, role and cluster you expect. An `assumed-role` ARN maps to its role."
      },
      {
        title: "Check the cluster knows that principal",
        run: [
          "aws eks list-access-entries --cluster-name larder-prod --region eu-west-1",
          "aws eks describe-cluster --name larder-prod --query 'cluster.accessConfig.authenticationMode'"
        ],
        lookFor: "No entry for your role ARN, or `CONFIG_MAP` mode where only `aws-auth` applies."
      },
      {
        title: "Regenerate kubeconfig for the right cluster and profile",
        run: [
          "aws eks update-kubeconfig --name larder-prod --region eu-west-1 --profile larder-prod-admin",
          "kubectl auth whoami"
        ],
        lookFor: "`kubectl auth whoami` printing your mapped username and groups."
      }
    ],
    resolution: [
      "Add an access entry for the principal and associate a policy (or map it to Kubernetes groups bound by",
      "RBAC), using a principal that already has access:",
      "",
      "```sh",
      "aws eks create-access-entry --cluster-name larder-prod \\",
      "  --principal-arn arn:aws:iam::111122223333:role/platform-oncall",
      "aws eks associate-access-policy --cluster-name larder-prod \\",
      "  --principal-arn arn:aws:iam::111122223333:role/platform-oncall \\",
      "  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy \\",
      "  --access-scope type=cluster",
      "```",
      "",
      "If no one can authenticate any more, any IAM principal with `eks:CreateAccessEntry` in the account can",
      "restore access through the EKS API; this is why access entries beat `aws-auth`, which can lock everyone",
      "out with one bad edit."
    ],
    prevention: [
      "Manage access entries as code, with at least two break-glass roles.",
      "Use the `API` authentication mode; migrate away from `aws-auth`.",
      "Give CI its own role with a scoped access policy, and alert on authentication failures in the authenticator logs."
    ],
    signals: [
      [5, "You must be logged in to the server"],
      [3, "\\(Unauthorized\\)"],
      [4, "the server has asked for the client to provide credentials"],
      [2, "getting credentials: exec"]
    ],
    samples: [
      "error: You must be logged in to the server (Unauthorized)",
      "E1006 10:01:22.193 memcache.go:265] couldn't get current server API group list: the server has asked for the client to provide credentials"
    ],
    related: ["rbac-forbidden", "x509-certificate-errors", "eks-node-join-failure"],
    lab: null,
    runbook: null
  },
  {
    id: "pod-aws-access-denied",
    title: "AccessDenied from a pod calling AWS (IRSA or Pod Identity)",
    kind: "cause",
    layer: "identity",
    scope: "eks",
    summary: "The pod calls AWS with the wrong identity (often the node role) or with a role whose policy does not allow the action.",
    propagation: {
      map: "eks",
      origins: [
        { at: "application", note: "Service account not associated, or SDK too old" },
        { at: "iam", note: "Role policy or trust policy does not allow it" }
      ],
      path: [
        { at: "pod-identity-agent", note: "No credentials: SDK falls back to the node role" },
        { at: "aws-apis", note: "Request evaluated and denied" }
      ],
      symptom: { at: "application", note: "AccessDenied: not authorized to perform" }
    },
    components: ["iam", "pod-identity-agent", "application", "workload-controllers"],
    symptom: [
      "An application's AWS SDK calls fail with `AccessDenied`, `InvalidIdentityToken`, or credential lookup",
      "errors. The pod runs, but every S3, SQS, DynamoDB or Secrets Manager call fails. The ARN in the message",
      "is the most important clue."
    ],
    affected: [
      "The chain that gives a pod an **IAM** identity: the service account, either the IRSA webhook and the",
      "cluster's OIDC provider or the **Pod Identity agent** and its association, the role's trust policy, and",
      "the role's permissions."
    ],
    rootCause: [
      "Read the principal in the error first:",
      "",
      "- **The node role** (`assumed-role/<node-role>/i-...`): the pod did not get its own identity and the SDK",
      "  fell back to the instance profile. The service account has no `eks.amazonaws.com/role-arn` annotation",
      "  and no Pod Identity association, the pod started before the annotation or association existed",
      "  (credentials are injected at pod creation), or the pod uses a different service account than you",
      "  configured. If IMDS is limited to one hop, the fallback fails instead with `no EC2 IMDS role found`.",
      "- **Your role, but `AssumeRoleWithWebIdentity` denied** (IRSA): the trust policy's `sub` condition does",
      "  not match `system:serviceaccount:<namespace>:<name>`, or the audience is not `sts.amazonaws.com`.",
      "- **`No OpenID Connect provider found`** (IRSA): the cluster's OIDC issuer was never registered as an IAM",
      "  identity provider in this account (common in a new account or for a recreated cluster).",
      "- **Your role, action denied:** the role is assumed correctly but its policy lacks the action or",
      "  resource, or a KMS key policy, bucket policy, permissions boundary or SCP denies it."
    ],
    investigation: [
      {
        title: "See what identity the pod actually receives",
        run: [
          "kubectl get pod <pod> -n fulfilment -o jsonpath='{.spec.serviceAccountName}'; echo",
          "kubectl exec <pod> -n fulfilment -- env | grep -E '^AWS_(ROLE_ARN|WEB_IDENTITY_TOKEN_FILE|CONTAINER_CREDENTIALS_FULL_URI)'",
          "kubectl exec <pod> -n fulfilment -- aws sts get-caller-identity   # if the image has the CLI"
        ],
        lookFor: "No AWS_* variables means no IRSA or Pod Identity injection; the caller identity shows the role in use."
      },
      {
        title: "Check the service account and association",
        run: [
          "kubectl get sa dispatch-worker -n fulfilment -o jsonpath='{.metadata.annotations}'; echo",
          "aws eks list-pod-identity-associations --cluster-name larder-prod --namespace fulfilment",
          "kubectl get pods -n kube-system -l app.kubernetes.io/name=eks-pod-identity-agent"
        ],
        lookFor: "Neither an annotation nor an association, or the agent not running on the pod's node."
      },
      {
        title: "For IRSA, check the OIDC provider and trust policy",
        run: [
          "aws eks describe-cluster --name larder-prod --query 'cluster.identity.oidc.issuer' --output text",
          "aws iam list-open-id-connect-providers",
          "aws iam get-role --role-name dispatch-worker --query 'Role.AssumeRolePolicyDocument'"
        ],
        lookFor: "A missing provider for the issuer, or a `sub` condition for another namespace or service account name."
      },
      {
        title: "Simulate the permission",
        run: [
          "aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::111122223333:role/dispatch-worker \\",
          "  --action-names sqs:ReceiveMessage --resource-arns arn:aws:sqs:eu-west-1:111122223333:dispatch-jobs"
        ],
        lookFor: "`implicitDeny` or `explicitDeny`, and which policy decides."
      }
    ],
    resolution: [
      "With Pod Identity (preferred for new workloads), create the association and restart the pods:",
      "",
      "```sh",
      "aws eks create-pod-identity-association --cluster-name larder-prod \\",
      "  --namespace fulfilment --service-account dispatch-worker \\",
      "  --role-arn arn:aws:iam::111122223333:role/dispatch-worker",
      "kubectl rollout restart deployment/dispatch-worker -n fulfilment",
      "```",
      "",
      "The role's trust policy must allow `pods.eks.amazonaws.com` to `sts:AssumeRole` and `sts:TagSession`.",
      "With IRSA, register the OIDC provider, fix the trust policy's `sub`, annotate the service account and",
      "restart. In both cases, add the missing action to the role's policy if the role itself is denied."
    ],
    prevention: [
      "Set the IMDS hop limit to 1 so pods cannot silently fall back to the node role; failures become explicit and early.",
      "Manage roles, trust policies and associations with the workload's infrastructure code, keyed by namespace and service account.",
      "Use Pod Identity session tags (namespace, service account) for attribute-based policies instead of one role per tiny variation."
    ],
    signals: [
      [4, "is not authorized to perform: \\S+"],
      [5, "AssumeRoleWithWebIdentity"],
      [5, "InvalidIdentityToken"],
      [3, "assumed-role/[^/]*[Nn]ode[^/]*/i-[0-9a-f]+"],
      [3, "AccessDenied"],
      [2, "NoCredentialProviders|no EC2 IMDS role found|Unable to locate credentials"]
    ],
    samples: [
      "AccessDenied: User: arn:aws:sts::111122223333:assumed-role/eks-larder-prod-system-NodeInstanceRole/i-0abc123def4567890 is not authorized to perform: sqs:ReceiveMessage on resource: arn:aws:sqs:eu-west-1:111122223333:dispatch-jobs because no identity-based policy allows the sqs:ReceiveMessage action",
      "WebIdentityErr: failed to retrieve credentials caused by: InvalidIdentityToken: No OpenID Connect provider found in your account for https://oidc.eks.eu-west-1.amazonaws.com/id/5C7A9E1B2D3F4A6B8C0D",
      "AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity"
    ],
    related: ["rbac-forbidden", "createcontainerconfigerror", "pvc-pending-provisioning", "cni-not-ready"],
    lab: null,
    runbook: null
  },
  {
    id: "rbac-forbidden",
    title: "Forbidden — RBAC denies the action",
    kind: "cause",
    layer: "identity",
    scope: "any",
    summary: "You are authenticated, but no Role or ClusterRole bound to you grants this verb on this resource.",
    propagation: {
      map: "cluster",
      origins: [{ at: "workload-controllers", note: "No RoleBinding grants the verb" }],
      path: [{ at: "kube-apiserver", note: "Authorization denies: 403" }],
      symptom: { at: "client", note: "Error from server (Forbidden)" }
    },
    components: ["kube-apiserver", "workload-controllers", "client"],
    symptom: [
      "A request fails with `Forbidden` and a sentence naming the user, the verb, the resource, the API group",
      "and the namespace. For a controller or operator, its logs repeat the error and it stops reconciling."
    ],
    affected: [
      "**Authorization** in the **API server** (RBAC, plus EKS access policies) recognised the identity but",
      "found no rule allowing that verb on that resource in that scope."
    ],
    rootCause: [
      "RBAC is additive and default-deny: an identity can do only what some Role or ClusterRole bound to it (or",
      "to one of its groups) allows. The message tells you exactly what was missing: the **verb**, the",
      "**resource** (and subresource such as `pods/log` or `pods/exec`), the **API group** and the",
      "**namespace**. Common gaps:",
      "",
      "- a RoleBinding in one namespace when the workload acts in another;",
      "- a ClusterRole bound with a RoleBinding (namespace-scoped) when cluster-wide access was needed;",
      "- a missing subresource (`pods/exec`, `deployments/scale`);",
      "- an access policy associated with a namespace scope rather than the cluster."
    ],
    investigation: [
      {
        title: "Ask the API server what the identity may do",
        run: [
          "kubectl auth can-i list secrets -n fulfilment --as=system:serviceaccount:fulfilment:dispatch-worker",
          "kubectl auth can-i --list -n payments --as=arn:aws:sts::111122223333:assumed-role/developer/alice"
        ],
        lookFor: "`no` for the exact verb and resource in the message."
      },
      {
        title: "Find the bindings for the subject",
        run: [
          "kubectl get rolebindings,clusterrolebindings -A -o json | \\",
          "  jq -r '.items[] | select(.subjects[]? | .name==\"dispatch-worker\") | \"\\(.kind) \\(.metadata.namespace // \"-\")/\\(.metadata.name) -> \\(.roleRef.name)\"'",
          "aws eks list-associated-access-policies --cluster-name larder-prod --principal-arn arn:aws:iam::111122223333:role/developer"
        ],
        lookFor: "Bindings in the wrong namespace, or a role missing the resource."
      }
    ],
    resolution: [
      "Grant the narrowest rule that covers the message, in the namespace where the action happens:",
      "",
      "```yaml",
      "apiVersion: rbac.authorization.k8s.io/v1",
      "kind: Role",
      "metadata: { name: dispatch-worker, namespace: fulfilment }",
      "rules:",
      "  - apiGroups: [\"\"]",
      "    resources: [\"configmaps\"]",
      "    verbs: [\"get\", \"list\", \"watch\"]",
      "```",
      "",
      "Bind it with a RoleBinding to the service account. Question requests for `secrets` list access; reading",
      "one named Secret (`resourceNames`) is usually enough."
    ],
    prevention: [
      "Keep RBAC in the same chart as the workload that needs it, and test controllers with their real service account.",
      "Review ClusterRoleBindings regularly; alert on new bindings to `cluster-admin` from the audit log."
    ],
    signals: [
      [5, "is forbidden: User \"[^\"]+\" cannot"],
      [3, "Error from server \\(Forbidden\\)"],
      [2, "cannot (get|list|watch|create|update|patch|delete) resource"]
    ],
    samples: [
      "Error from server (Forbidden): pods is forbidden: User \"arn:aws:sts::111122223333:assumed-role/developer/alice\" cannot list resource \"pods\" in API group \"\" in the namespace \"payments\"",
      "E1006 12:00:00 reflector.go:150] failed to list *v1.Secret: secrets is forbidden: User \"system:serviceaccount:fulfilment:dispatch-worker\" cannot list resource \"secrets\" in API group \"\" in the namespace \"fulfilment\""
    ],
    related: ["kubectl-unauthorized", "pod-aws-access-denied"],
    lab: null,
    runbook: null
  },
  {
    id: "x509-certificate-errors",
    title: "x509 certificate errors (expired, unknown authority, wrong name)",
    kind: "cause",
    layer: "identity",
    scope: "any",
    summary: "A TLS handshake fails because a certificate is expired, signed by an authority the client does not trust, or issued for another name.",
    propagation: {
      map: "cluster",
      origins: [{ at: "cert-manager", note: "Certificate not renewed, or CA bundle not injected" }],
      path: [
        { at: "admission-webhooks", note: "Serves an expired or untrusted certificate" },
        { at: "kube-apiserver", note: "Rejects the handshake: x509" }
      ],
      symptom: { at: "client", note: "x509: certificate has expired or is not yet valid" }
    },
    components: ["client", "admission-webhooks", "cert-manager", "kube-apiserver", "kubelet"],
    symptom: [
      "TLS handshakes fail with an `x509:` error: `kubectl` cannot connect, a webhook call fails, an ingress",
      "serves a browser warning, or service-to-service calls with TLS break, often all at once at a specific",
      "time (an expiry)."
    ],
    affected: [
      "Whatever validates a certificate: **kubectl** validating the API server, the **API server** validating",
      "a webhook's serving certificate against its `caBundle`, the **kubelet**, or applications. Issuance and",
      "renewal usually belong to **cert-manager** (in-cluster) or ACM (load balancers)."
    ],
    rootCause: [
      "Three distinct failures share the prefix:",
      "",
      "- **Expired or not yet valid:** a certificate was not renewed (cert-manager failing its challenges or",
      "  lacking permissions, a manually created certificate forgotten, a self-managed cluster's control plane",
      "  certificates after one year), or the client clock is wrong.",
      "- **Unknown authority:** the client does not trust the issuer. A corporate TLS-inspection proxy",
      "  re-signing traffic to the API server; a kubeconfig `certificate-authority-data` from another cluster",
      "  (a recreated cluster has a new CA); a webhook `caBundle` that was not updated after rotation.",
      "- **Wrong name:** the certificate's subject alternative names do not include the name the client used",
      "  (a Service DNS name missing from a webhook certificate, an ingress host not on the certificate)."
    ],
    investigation: [
      {
        title: "Inspect the certificate actually presented",
        run: [
          "openssl s_client -connect api.larder.example:443 -servername api.larder.example </dev/null 2>/dev/null | \\",
          "  openssl x509 -noout -subject -issuer -dates -ext subjectAltName"
        ],
        lookFor: "`notAfter` in the past, an unexpected issuer (a proxy), or SANs without the requested name."
      },
      {
        title: "For webhooks, compare caBundle with the serving certificate",
        run: [
          "kubectl get validatingwebhookconfiguration cert-manager-webhook -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | base64 -d | openssl x509 -noout -subject -dates",
          "kubectl get secret cert-manager-webhook-ca -n cert-manager -o jsonpath='{.data.ca\\.crt}' | base64 -d | openssl x509 -noout -subject -dates"
        ],
        lookFor: "Different subjects or dates between the bundle and the CA that signed the serving certificate."
      },
      {
        title: "For cert-manager certificates, follow the issuance chain",
        run: [
          "kubectl get certificate,certificaterequest,order,challenge -A",
          "kubectl describe certificate orders-tls -n shop | sed -n '/Status/,$p'"
        ],
        lookFor: "`Ready=False` and the failing step: a challenge that cannot be reached, a DNS01 permission error, a rate limit."
      },
      {
        title: "For kubectl, check which CA you trust",
        run: [
          "kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d | openssl x509 -noout -subject -dates",
          "aws eks describe-cluster --name larder-prod --query 'cluster.certificateAuthority.data' --output text | base64 -d | openssl x509 -noout -subject -dates"
        ],
        lookFor: "A kubeconfig CA that differs from the cluster's current CA."
      }
    ],
    resolution: [
      "Renew or reissue the certificate (fix the cert-manager issuer and trigger renewal with `cmctl renew`),",
      "update the trust (regenerate kubeconfig with `aws eks update-kubeconfig`, re-inject the webhook",
      "`caBundle` with cert-manager's CA injector), or add the missing SANs. Behind a TLS-inspection proxy,",
      "exempt the EKS endpoint from inspection rather than disabling verification."
    ],
    prevention: [
      "Alert 21 days before expiry on every certificate (`certmanager_certificate_expiration_timestamp_seconds - time()`), and probe external endpoints with blackbox checks.",
      "Use cert-manager's CA injector for every webhook and APIService that it serves.",
      "Never use `insecure-skip-tls-verify`; it hides the next real problem."
    ],
    signals: [
      [5, "x509: certificate has expired or is not yet valid"],
      [5, "x509: certificate signed by unknown authority"],
      [4, "x509: certificate is valid for .*, not "],
      [3, "tls: failed to verify certificate"],
      [2, "x509:"]
    ],
    samples: [
      "Unable to connect to the server: x509: certificate signed by unknown authority",
      "failed calling webhook \"webhook.cert-manager.io\": failed to call webhook: Post \"https://cert-manager-webhook.cert-manager.svc:443/validate?timeout=10s\": tls: failed to verify certificate: x509: certificate has expired or is not yet valid: current time 2026-10-06T09:00:00Z is after 2026-10-05T23:59:59Z",
      "x509: certificate is valid for orders.larder.example, not api.larder.example"
    ],
    related: ["webhook-unavailable", "kubectl-unauthorized", "ingress-no-address"],
    lab: null,
    runbook: "certificate-expiry"
  }
]);
