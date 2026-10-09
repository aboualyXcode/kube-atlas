// Categories used everywhere: planes colour the stations, layers group failures,
// EKS lenses filter the EKS map down to one concern at a time.
KA.define("planes", {
  control: { name: "Control plane", hint: "Decides what should run where" },
  node: { name: "Node", hint: "Runs pods on one machine" },
  addon: { name: "Add-on", hint: "Runs in the cluster as pods" },
  workload: { name: "Your workload", hint: "What you deploy and declare" },
  client: { name: "Outside the cluster", hint: "People and pipelines" },
  aws: { name: "AWS", hint: "Cloud infrastructure and APIs" },
});

KA.define("layers", [
  { id: "workload", name: "Workload", hint: "The pod, its containers and configuration" },
  { id: "scheduling", name: "Scheduling", hint: "Why a pod gets no node" },
  { id: "node", name: "Node", hint: "kubelet, runtime, network plugin, instance" },
  { id: "networking", name: "Networking", hint: "Paths, endpoints, admission calls" },
  { id: "dns", name: "DNS", hint: "Names that do not resolve, or resolve slowly" },
  { id: "storage", name: "Storage", hint: "Claims, volumes, attachments, mounts" },
  { id: "autoscaling", name: "Autoscaling", hint: "Pods, nodes and drains" },
  { id: "identity", name: "Identity", hint: "Who you are and what you may do" },
  { id: "load-balancing", name: "Load balancing", hint: "ALBs, NLBs and their targets" },
  { id: "control-plane", name: "Control plane", hint: "API server, aggregation, etcd" },
]);

KA.define("eksLayers", [
  {
    id: "networking",
    name: "Networking",
    summary: "Every pod gets a real VPC IP from your subnets through the VPC CNI. Subnet size, ENI limits and security groups decide what can start and what can talk.",
    stations: ["vpc", "nat", "vpc-endpoints", "vpc-dns", "security-groups", "cni", "kube-proxy", "coredns", "ec2", "elb", "application", "kubelet", "container-runtime"],
    flows: ["eks-pod-gets-ip", "eks-request-to-pod"],
    decide: {
      title: "VPC CNI modes",
      cols: ["Mode", "What it changes", "Choose it when"],
      rows: [
        ["Secondary IPs (default)", "Each pod takes one IP from the node's ENIs", "Small clusters with roomy subnets"],
        ["Prefix delegation", "ENIs get /28 prefixes: up to 110 pods per node, faster starts", "Most production clusters; needs contiguous free space"],
        ["Custom networking", "Pods use separate subnets, often a 100.64.0.0/16 secondary CIDR", "Node subnets are small or centrally allocated"],
        ["Security groups for pods", "Selected pods get their own branch ENI and SG", "A database must allow only one workload"],
      ],
    },
    widget: "pod-density",
  },
  {
    id: "identity",
    name: "Identity",
    summary: "Three separate identities meet here: people and pipelines (IAM to access entries), nodes (the node role) and pods (Pod Identity or IRSA). Each fails differently.",
    stations: ["client", "kube-apiserver", "iam", "pod-identity-agent", "application", "aws-apis", "kubelet", "cni"],
    flows: ["eks-human-access", "eks-pod-identity", "eks-node-join"],
    decide: {
      title: "Pod Identity or IRSA",
      cols: ["", "EKS Pod Identity", "IRSA"],
      rows: [
        ["Setup", "One association per service account; no OIDC provider", "OIDC provider plus a trust policy per role"],
        ["Trust policy", "Same for every cluster (pods.eks.amazonaws.com)", "Names the cluster's OIDC issuer"],
        ["Works on", "EKS (EC2 nodes)", "EKS, self-managed clusters, Fargate"],
        ["Credentials from", "Node-local agent at 169.254.170.23", "STS AssumeRoleWithWebIdentity"],
      ],
    },
  },
  {
    id: "load-balancing",
    name: "Load balancing",
    summary: "The AWS Load Balancer Controller turns Ingresses into ALBs and LoadBalancer Services into NLBs, registering pod IPs directly as targets.",
    stations: ["users", "elb", "aws-load-balancer-controller", "security-groups", "application", "kube-apiserver", "client", "vpc", "iam"],
    flows: ["eks-ingress-to-alb", "eks-request-to-pod"],
    decide: {
      title: "ALB or NLB",
      cols: ["", "ALB (Ingress)", "NLB (Service)"],
      rows: [
        ["Layer", "HTTP and HTTPS, path and host rules", "TCP, UDP, TLS passthrough"],
        ["Declared by", "Ingress with ingressClassName: alb", "Service type LoadBalancer"],
        ["Targets", "Pod IPs (target-type: ip) recommended", "Pod IPs or instances"],
        ["Typical use", "Web APIs and sites", "gRPC, databases, non-HTTP protocols"],
      ],
    },
  },
  {
    id: "storage",
    name: "Storage",
    summary: "CSI drivers create and attach AWS volumes for PersistentVolumeClaims. EBS is zonal and attaches to one node; EFS is regional and shared.",
    stations: ["ebs-csi-driver", "efs-csi-driver", "csi-node", "ebs", "efs", "kms", "kube-controller-manager", "kube-scheduler", "kubelet", "application", "iam"],
    flows: ["eks-pvc-to-ebs"],
    decide: {
      title: "EBS or EFS",
      cols: ["", "EBS (gp3)", "EFS"],
      rows: [
        ["Access", "One node at a time (ReadWriteOnce)", "Many nodes at once (ReadWriteMany)"],
        ["Scope", "One Availability Zone", "Region, mount target per AZ"],
        ["Fits", "Databases, queues, anything needing low latency", "Shared content, ML datasets, legacy shared folders"],
        ["Watch out", "Pod must run in the volume's AZ", "Latency and per-client throughput limits"],
      ],
    },
  },
  {
    id: "autoscaling",
    name: "Autoscaling",
    summary: "Three loops in sequence: the HPA adds pods, the scheduler marks the ones that do not fit Pending, and Karpenter or Cluster Autoscaler adds nodes for them.",
    stations: ["karpenter", "cluster-autoscaler", "metrics-server", "kube-controller-manager", "kube-scheduler", "ec2", "vpc", "kubelet", "application", "iam", "cni"],
    flows: ["eks-pending-to-node"],
    decide: {
      title: "How nodes get added",
      cols: ["Option", "How it works", "Trade-off"],
      rows: [
        ["Karpenter", "Calls EC2 directly with the cheapest types that fit pending pods", "Fast and flexible; you tune NodePools and disruption"],
        ["Cluster Autoscaler", "Resizes Auto Scaling groups of identical nodes", "Predictable; one group per instance shape"],
        ["EKS Auto Mode", "AWS runs node provisioning and core add-ons for you", "Least to operate; less control over internals"],
        ["Fargate", "One micro-VM per pod, no nodes to manage", "No DaemonSets, no GPUs, per-pod pricing"],
      ],
    },
    widget: "capacity",
  },
  {
    id: "security",
    name: "Security",
    summary: "Defence in layers: private endpoint and security groups at the edge, IAM and access entries for identity, KMS for secrets, and least-privilege roles per workload.",
    stations: ["security-groups", "iam", "kms", "vpc-endpoints", "kube-apiserver", "pod-identity-agent", "application", "ecr"],
    flows: [],
    decide: {
      title: "Production baseline",
      cols: ["Control", "Why"],
      rows: [
        ["Private (or restricted public) cluster endpoint", "Shrinks who can even reach the API"],
        ["Secrets envelope encryption with KMS", "Secrets in etcd are encrypted with your key"],
        ["IMDSv2 with hop limit 1 on nodes", "Pods cannot borrow the node role"],
        ["One IAM role per workload", "A compromised pod gets only its own permissions"],
        ["Pod Security Standards (restricted) and NetworkPolicy", "Limits what a pod can do and reach"],
        ["Scanned, multi-arch images pinned by digest", "Known contents, runs on every node type"],
      ],
    },
  },
]);
