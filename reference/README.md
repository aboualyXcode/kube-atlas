# Reference platform

Larder's production cluster, `larder-prod` in `eu-west-1`, as configuration you can read and adapt. It is a reference, not a turnkey installer: account IDs, VPC and subnet IDs, CIDRs, ARNs and versions are examples and must be replaced.

| Path | What it is | Where the atlas explains it |
|---|---|---|
| `eks/cluster.yaml` | The eksctl cluster definition and its system node group | EKS overview |
| `eks/eniconfig.yaml` | VPC CNI custom networking: pod subnets per AZ | EKS, networking lens |
| `eks/karpenter/nodepool.yaml` | Karpenter NodePool and EC2NodeClass | EKS, autoscaling lens |
| `eks/addons/` | Helm values for the AWS Load Balancer Controller, Cluster Autoscaler and Karpenter | EKS, load balancing and autoscaling lenses |
| `eks/storage/storageclasses.yaml` | EBS and EFS StorageClasses | EKS, storage lens |
| `eks/iam/` | Pod Identity and IRSA trust policies, and a workload policy | EKS, identity lens |
| `baseline/` | The namespace baseline and PriorityClasses | Operations: workload contract and security |
| `apps/` | Three workloads that meet the production contract, and their Ingress | Operations: workload contract |
| `observability/alerts.yaml` | Prometheus alerting rules, each with a `runbook_url` | Operations: observe |
| `observability/cloudwatch-alarms.yaml` | CloudWatch alarms for the AWS side | Operations: observe |

Platform components select the system node group by its `role` label. Changing that label breaks every component that selects it, which is exactly the incident replayed in the atlas as "The Tuesday deploys stopped".
