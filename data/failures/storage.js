// Storage failures: claims, volumes, attachments, mounts
// Each entry: the six parts (symptom, affected, rootCause, investigation, resolution, prevention),
// a propagation path drawn on the eks map, and the signals that let pasted output find it.
// Multi-line text is an array of lines (Markdown). See CONTRIBUTING.md before editing.
KA.define("failures", [
  {
    id: "efs-mount-timeout",
    title: "EFS mount timeout",
    kind: "cause",
    layer: "storage",
    scope: "eks",
    summary: "The node cannot reach an EFS mount target on NFS port 2049, so the mount times out and the pod never starts.",
    propagation: {
      map: "eks",
      origins: [
        { at: "security-groups", note: "Mount target SG does not allow 2049 from nodes" },
        { at: "vpc", note: "No mount target in the node's AZ" }
      ],
      path: [
        { at: "efs", note: "Mount target unreachable" },
        { at: "efs-csi-driver", note: "mount.nfs times out" }
      ],
      symptom: { at: "application", note: "ContainerCreating: MountVolume.SetUp failed" }
    },
    components: ["efs-csi-driver", "efs", "security-groups", "vpc"],
    symptom: [
      "Pods mounting an EFS volume stay in `ContainerCreating` with `FailedMount` and `mount.nfs4: Connection",
      "timed out` or `Failed to resolve \"fs-...efs...\"`. Often only pods in one AZ are affected."
    ],
    affected: [
      "The **EFS CSI node plugin** mounts over NFS (TCP 2049) to the **mount target** in the node's AZ. The",
      "cause is almost always the **security group** on the mount target, a missing mount target, or **VPC**",
      "DNS."
    ],
    rootCause: [
      "EFS is regional, but clients reach it through one mount target per AZ, each with its own security",
      "group. A mount needs:",
      "",
      "- a mount target in the **node's AZ** (otherwise the regional DNS name does not resolve to an address",
      "  in that AZ: `Failed to resolve`);",
      "- the mount target's security group allowing **TCP 2049** from the nodes' (or pods') security groups;",
      "- VPC DNS resolution and hostnames enabled;",
      "- for access points with IAM authorization, a file system policy that allows the driver's role."
    ],
    investigation: [
      {
        title: "Map failing pods to AZs",
        run: [
          "kubectl get pods -n catalog -o wide",
          "aws efs describe-mount-targets --file-system-id fs-0a1b2c3d --query 'MountTargets[].[AvailabilityZoneName,SubnetId,LifeCycleState,MountTargetId]'"
        ],
        lookFor: "Failing pods in an AZ without an `available` mount target."
      },
      {
        title: "Check the mount target security groups",
        run: [
          "aws efs describe-mount-target-security-groups --mount-target-id <fsmt-id>",
          "aws ec2 describe-security-groups --group-ids <efs-sg> --query 'SecurityGroups[].IpPermissions'"
        ],
        lookFor: "No inbound TCP 2049 from the node security group."
      },
      {
        title: "Read the node plugin logs",
        run: "kubectl logs -n kube-system -l app=efs-csi-node -c efs-plugin --prefix --tail=50",
        lookFor: "Timeouts, DNS failures, or `access denied by server` (file system policy)."
      }
    ],
    resolution: [
      "Create a mount target in every AZ the cluster uses, allow TCP 2049 from the node security group (or the",
      "cluster security group) on the mount targets' security group, and enable VPC DNS hostnames. Mounts retry",
      "automatically once the path works."
    ],
    prevention: [
      "Provision EFS mount targets for every cluster subnet AZ in the same code as the file system.",
      "Reference security groups, not CIDRs, in the EFS security group so new node pools are covered."
    ],
    signals: [
      [5, "mount\\.nfs4?: Connection timed out"],
      [4, "Failed to resolve \"fs-[0-9a-f]+\\.efs"],
      [3, "efs\\.csi\\.aws\\.com"],
      [2, "MountVolume\\.SetUp failed"]
    ],
    samples: [
      "Warning  FailedMount  2m  kubelet  MountVolume.SetUp failed for volume \"shared-assets\" : rpc error: code = Internal desc = Could not mount \"fs-0a1b2c3d:/\" at \"/var/lib/kubelet/pods/9f1e/volumes/kubernetes.io~csi/shared-assets/mount\": mount failed: exit status 32 Output: mount.nfs4: Connection timed out",
      "Output: Failed to resolve \"fs-0a1b2c3d.efs.eu-west-1.amazonaws.com\" - check that your file system ID is correct, and ensure that the VPC has an EFS mount target for this file system ID."
    ],
    related: ["connection-timeouts", "pvc-pending-provisioning", "pod-stuck-terminating"],
    lab: null,
    runbook: null
  },
  {
    id: "multi-attach-error",
    title: "Multi-Attach error (volume still attached to another node)",
    kind: "cause",
    layer: "storage",
    scope: "any",
    summary: "An EBS volume can be attached to one node at a time, and the old node still holds it.",
    propagation: {
      map: "eks",
      origins: [{ at: "kubelet", note: "Old node gone or stuck, never confirmed the unmount" }],
      path: [
        { at: "kube-controller-manager", note: "Waits 6 min before force-detaching" },
        { at: "ebs", note: "Still attached to the old instance" }
      ],
      symptom: { at: "application", note: "Multi-Attach error, stuck ContainerCreating" }
    },
    components: ["kube-controller-manager", "ebs-csi-driver", "ebs", "kubelet"],
    symptom: [
      "A replacement pod of a single-replica workload stays in `ContainerCreating` with a `Multi-Attach error`",
      "event. Typical moments: a node failure, a Deployment rollout of a pod with an EBS volume, or a drain.",
      "It often resolves by itself after about six minutes, which is the clue."
    ],
    affected: [
      "The **attach-detach controller** in the controller manager will not attach a `ReadWriteOnce` **EBS**",
      "volume to a new node while the volume is still attached to the old one."
    ],
    rootCause: [
      "EBS volumes (with rare io2 exceptions) attach to one instance at a time. When a pod moves:",
      "",
      "- **Rolling update of a Deployment with an RWO volume:** the default strategy starts the new pod before",
      "  stopping the old one, so both want the volume. Single-replica, volume-owning workloads need",
      "  `strategy: Recreate` or a StatefulSet.",
      "- **Node failure:** the old node cannot confirm the volume is unmounted. The controller waits",
      "  `maxWaitForUnmountDuration` (six minutes) before force detaching, to avoid two writers.",
      "- **Stuck detach:** the EC2 detach does not complete (the instance is impaired), which shows in",
      "  `VolumeAttachment` objects and EC2 volume state `detaching`."
    ],
    investigation: [
      {
        title: "Find where the volume is attached",
        run: [
          "kubectl get volumeattachments -o custom-columns=PV:.spec.source.persistentVolumeName,NODE:.spec.nodeName,ATTACHED:.status.attached | grep <pv-name>",
          "aws ec2 describe-volumes --volume-ids <vol-id> --query 'Volumes[].Attachments'"
        ],
        lookFor: "An attachment to the old node, and its EC2 state."
      },
      {
        title: "Check the old node and the workload strategy",
        run: [
          "kubectl get node <old-node>",
          "kubectl get deploy <name> -n <ns> -o jsonpath='{.spec.strategy}'"
        ],
        lookFor: "A NotReady or deleted node, or a `RollingUpdate` strategy on a single-replica Deployment with an RWO volume."
      }
    ],
    resolution: [
      "For rollouts, switch to `strategy: type: Recreate` or a StatefulSet. For a failed node that will not",
      "return, confirm it is shut down, then mark it out of service so the volume detaches immediately:",
      "",
      "```sh",
      "kubectl taint node <old-node> node.kubernetes.io/out-of-service=nodeshutdown:NoExecute",
      "```",
      "",
      "Remove the taint once the node object is gone or the node is healthy again."
    ],
    prevention: [
      "Use StatefulSets (or `Recreate`) for anything that owns an RWO volume.",
      "Prefer RWX storage (EFS) or application-level replication where moving fast between nodes matters.",
      "Let the node termination handling (Karpenter, managed node groups) drain nodes before they stop."
    ],
    signals: [[5, "Multi-Attach error for volume"], [3, "already exclusively attached to one node"]],
    samples: [
      "Warning  FailedAttachVolume  3m  attachdetach-controller  Multi-Attach error for volume \"pvc-1c2d3e4f\" Volume is already exclusively attached to one node and can't be attached to another"
    ],
    related: [
      "volume-attach-failed",
      "volume-node-affinity-conflict",
      "node-not-ready",
      "pod-stuck-terminating"
    ],
    lab: null,
    runbook: null
  },
  {
    id: "pvc-pending-provisioning",
    title: "PVC Pending — volume not provisioned",
    kind: "symptom",
    layer: "storage",
    scope: "eks",
    summary: "The PersistentVolumeClaim waits for a volume that the CSI driver cannot create: driver missing, permissions, KMS key policy or StorageClass.",
    propagation: {
      map: "eks",
      origins: [
        { at: "iam", note: "Driver role lacks CreateVolume" },
        { at: "kms", note: "Key policy denies the driver" }
      ],
      path: [{ at: "ebs-csi-driver", note: "CreateVolume fails: ProvisioningFailed" }],
      symptom: { at: "application", note: "PVC Pending, pods using it Pending" }
    },
    components: ["ebs-csi-driver", "efs-csi-driver", "kube-controller-manager", "iam", "kms"],
    symptom: [
      "A PVC stays `Pending`, and so does the pod that mounts it. Events on the PVC say it is waiting for an",
      "external provisioner, that no storage class is set, or that provisioning failed."
    ],
    affected: [
      "The **CSI controller** (EBS or EFS driver) creates volumes on request of the **PV controller**. The",
      "cause is a missing default StorageClass, a driver that is not installed or not running, or the driver's",
      "**IAM** or **KMS** permissions."
    ],
    rootCause: [
      "Dynamic provisioning needs a StorageClass naming a provisioner, a running controller for that",
      "provisioner, and permission for the controller to create the volume.",
      "",
      "- **No class:** the PVC has no `storageClassName` and no class is marked default. New EKS clusters on",
      "  1.30 and later no longer mark `gp2` as default.",
      "- **No provisioner:** `Waiting for a volume to be created ... by the external provisioner",
      "  'ebs.csi.aws.com'` that never ends means nothing is serving that name: the EBS CSI driver add-on is not",
      "  installed, its controller is not running, or the class names a different provisioner than the one",
      "  installed (for example `ebs.csi.eks.amazonaws.com` in EKS Auto Mode).",
      "- **No permission:** the controller's IAM role lacks `ec2:CreateVolume` (managed policy",
      "  `AmazonEBSCSIDriverPolicy`), or the class requests a customer-managed KMS key the role cannot use.",
      "- **Normal:** with `WaitForFirstConsumer`, the PVC waits until a pod using it is scheduled. That is",
      "  expected, not a fault."
    ],
    investigation: [
      {
        title: "Read the PVC's events",
        run: "kubectl describe pvc <pvc> -n catalog | sed -n '/Events/,$p'",
        lookFor: "Which of the four cases above applies."
      },
      {
        title: "Check the StorageClass and the installed drivers",
        run: [
          "kubectl get storageclass",
          "kubectl get csidrivers",
          "kubectl get pods -n kube-system -l app=ebs-csi-controller"
        ],
        lookFor: "No default class, a provisioner name with no matching CSIDriver, or a controller not running."
      },
      {
        title: "Read the CSI controller logs",
        run: [
          "kubectl logs -n kube-system deploy/ebs-csi-controller -c csi-provisioner --tail=50",
          "kubectl logs -n kube-system deploy/ebs-csi-controller -c ebs-plugin --tail=50"
        ],
        lookFor: "`UnauthorizedOperation`, `AccessDenied` on `kms:CreateGrant`, or credential errors."
      },
      {
        title: "Check the driver's IAM role",
        run: [
          "aws eks describe-addon --cluster-name larder-prod --addon-name aws-ebs-csi-driver --query 'addon.[status,serviceAccountRoleArn]'",
          "aws eks list-pod-identity-associations --cluster-name larder-prod --namespace kube-system"
        ],
        lookFor: "No role at all, or a role without `AmazonEBSCSIDriverPolicy` and KMS permissions."
      }
    ],
    resolution: [
      "Install the driver as an EKS add-on with a role (IRSA or Pod Identity) that has",
      "`AmazonEBSCSIDriverPolicy`, plus KMS permissions for encrypted volumes with your own key. Define a",
      "default class explicitly:",
      "",
      "```yaml",
      "apiVersion: storage.k8s.io/v1",
      "kind: StorageClass",
      "metadata:",
      "  name: gp3",
      "  annotations: { storageclass.kubernetes.io/is-default-class: \"true\" }",
      "provisioner: ebs.csi.aws.com",
      "volumeBindingMode: WaitForFirstConsumer",
      "allowVolumeExpansion: true",
      "parameters: { type: gp3, encrypted: \"true\" }",
      "```"
    ],
    prevention: [
      "Ship StorageClasses and the CSI driver with the cluster baseline, never by hand.",
      "Alert on PVCs Pending for more than 5 minutes.",
      "Test a PVC end to end in the cluster's smoke tests after every add-on or IAM change."
    ],
    signals: [
      [4, "waiting for a volume to be created,? either by( the)? external provisioner"],
      [5, "no persistent volumes available for this claim and no storage class is set"],
      [4, "failed to provision volume with StorageClass"],
      [2, "ProvisioningFailed"]
    ],
    samples: [
      "Normal  ExternalProvisioning  2m (x26 over 8m)  persistentvolume-controller  Waiting for a volume to be created either by the external provisioner 'ebs.csi.aws.com' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.",
      "Warning  FailedBinding  20s  persistentvolume-controller  no persistent volumes available for this claim and no storage class is set",
      "Warning  ProvisioningFailed  5s  ebs.csi.aws.com_ebs-csi-controller-7c9d_1f2e  failed to provision volume with StorageClass \"gp3\": rpc error: code = Internal desc = Could not create volume \"pvc-8a1b\": could not create volume in EC2: UnauthorizedOperation: You are not authorized to perform this operation."
    ],
    related: [
      "pending-unbound-pvc",
      "volume-attach-failed",
      "volume-node-affinity-conflict",
      "pod-aws-access-denied"
    ],
    lab: "pending-unbound-pvc",
    runbook: null
  },
  {
    id: "volume-attach-failed",
    title: "AttachVolume or MountVolume failed (EBS)",
    kind: "cause",
    layer: "storage",
    scope: "eks",
    summary: "The EBS CSI driver cannot attach or mount the volume: missing permissions, no access to the KMS key, the instance's attachment limit, or a stuck attachment.",
    propagation: {
      map: "eks",
      origins: [
        { at: "iam", note: "Driver role cannot AttachVolume" },
        { at: "kms", note: "No permission on the volume's KMS key" },
        { at: "ec2", note: "Instance at its volume attachment limit" }
      ],
      path: [
        { at: "ebs-csi-driver", note: "AttachVolume fails" },
        { at: "kubelet", note: "Waits for the device: FailedAttachVolume" }
      ],
      symptom: { at: "application", note: "Stuck in ContainerCreating" }
    },
    components: ["ebs-csi-driver", "csi-node", "iam", "kms", "ec2"],
    symptom: [
      "A pod with an EBS-backed PVC is scheduled but stays in `ContainerCreating`. Events show `AttachVolume.",
      "Attach failed` or `MountVolume.MountDevice failed`; or the scheduler reports nodes that `exceed max",
      "volume count`."
    ],
    affected: [
      "The **EBS CSI controller** attaches volumes through EC2 using its **IAM** role; the **CSI node plugin**",
      "formats and mounts them. Encryption keys in **KMS** and **EC2** attachment limits are frequent causes."
    ],
    rootCause: [
      "- **Permissions:** the controller role lacks `ec2:AttachVolume`, or the volume is encrypted with a",
      "  customer-managed KMS key whose key policy does not allow the role (`kms:CreateGrant`, `kms:Decrypt`).",
      "- **Attachment limits:** each instance supports a limited number of EBS attachments; on many Nitro types",
      "  ENIs and NVMe devices share the slots, so dense nodes with many ENIs run out. The scheduler respects",
      "  the limit the CSI node plugin reports (`exceed max volume count`), unless that count is wrong.",
      "- **Mount failures:** a file system that needs repair, or `fsGroup` ownership changes on volumes with",
      "  millions of files that take longer than the mount timeout.",
      "- **Zone mismatch:** the volume and instance are in different zones (prevented by node affinity unless a",
      "  PV was created by hand without it)."
    ],
    investigation: [
      {
        title: "Read attach and mount events",
        run: [
          "kubectl describe pod <pod> -n <ns> | sed -n '/Events/,$p'",
          "kubectl get volumeattachment | grep <pv-name>"
        ],
        lookFor: "The EC2 or KMS error text inside the CSI message."
      },
      {
        title: "Read the controller and node plugin logs",
        run: [
          "kubectl logs -n kube-system deploy/ebs-csi-controller -c csi-attacher --tail=50",
          "kubectl logs -n kube-system -l app=ebs-csi-node -c ebs-plugin --tail=50 --prefix | grep <pv-name>"
        ],
        lookFor: "`UnauthorizedOperation`, `KMS key is not in a valid state`, `AttachmentLimitExceeded`, mount or fsck errors."
      },
      {
        title: "Check the node's attachment capacity",
        run: [
          "kubectl get csinode <node-name> -o jsonpath='{.spec.drivers[?(@.name==\"ebs.csi.aws.com\")].allocatable.count}'; echo",
          "kubectl get volumeattachments -o json | jq --arg n <node-name> '[.items[] | select(.spec.nodeName==$n)] | length'"
        ],
        lookFor: "Attachments at the allocatable count."
      }
    ],
    resolution: [
      "Grant the controller role `AmazonEBSCSIDriverPolicy` and add it to the KMS key policy (or grant the",
      "KMS actions in IAM). For attachment limits, spread volume-heavy pods (topology spread on",
      "`kubernetes.io/hostname`) or use instance types with more attachment slots. For slow `fsGroup` changes,",
      "set `fsGroupChangePolicy: OnRootMismatch`."
    ],
    prevention: [
      "Test encrypted volume provisioning and attachment whenever KMS keys or IAM change.",
      "Spread stateful pods across nodes, and keep volume-heavy workloads on a dedicated NodePool."
    ],
    signals: [
      [5, "AttachVolume\\.Attach failed for volume"],
      [3, "MountVolume\\.(MountDevice|SetUp) failed for volume \"pvc-"],
      [5, "exceed max volume count"],
      [1, "\\d+/\\d+ nodes are available"],
      [2, "Could not attach volume"]
    ],
    samples: [
      "Warning  FailedAttachVolume  40s  attachdetach-controller  AttachVolume.Attach failed for volume \"pvc-8a1b2c3d\" : rpc error: code = Internal desc = Could not attach volume \"vol-0a1b2c3d4e5f67890\" to node \"i-0abc123def4567890\": UnauthorizedOperation: You are not authorized to perform this operation.",
      "0/5 nodes are available: 2 node(s) exceed max volume count, 3 Insufficient cpu."
    ],
    related: ["pvc-pending-provisioning", "multi-attach-error", "pod-aws-access-denied"],
    lab: null,
    runbook: null
  },
  {
    id: "volume-node-affinity-conflict",
    title: "volume node affinity conflict (EBS volume in another AZ)",
    kind: "cause",
    layer: "storage",
    scope: "eks",
    summary: "The pod's EBS volume lives in one Availability Zone, but the only nodes that can take the pod are in another.",
    propagation: {
      map: "eks",
      origins: [{ at: "ebs", note: "Volume is zonal, pinned to one AZ" }],
      path: [
        { at: "kube-scheduler", note: "No fitting node in that AZ" },
        { at: "karpenter", note: "Cannot launch in that AZ: zones, subnets or limits" }
      ],
      symptom: { at: "application", note: "Pending: volume node affinity conflict" }
    },
    components: ["kube-scheduler", "ebs", "karpenter", "cluster-autoscaler"],
    symptom: [
      "A stateful pod that used to run (often after its node was replaced or the node group was resized) stays",
      "`Pending`. The scheduler reports `volume node affinity conflict` for most nodes, and the remaining",
      "nodes, all in one zone, are full or tainted."
    ],
    affected: [
      "The **scheduler**'s `VolumeBinding` and `VolumeZone` filters keep the pod in the zone where its **EBS**",
      "volume lives. The cause is node capacity in that zone, which depends on the **autoscaler** and node pool",
      "layout."
    ],
    rootCause: [
      "An EBS volume exists in exactly one Availability Zone and can only attach to instances there. Its PV",
      "carries node affinity for `topology.kubernetes.io/zone`. Once bound, the pod can only ever run in that",
      "zone. It becomes unschedulable when:",
      "",
      "- no node exists in that zone (node group scaled in, Spot capacity gone, a NodePool or ASG that does",
      "  not include that zone's subnet);",
      "- nodes exist but are full, tainted or the wrong type, and the autoscaler cannot add one there;",
      "- a Cluster Autoscaler node group spans several AZs, so the autoscaler cannot target the zone the pod needs."
    ],
    investigation: [
      {
        title: "Find the zone the volume requires",
        run: [
          "kubectl get pvc data-orders-db-0 -n shop -o jsonpath='{.spec.volumeName}'; echo",
          "kubectl get pv <pv-name> -o jsonpath='{.spec.nodeAffinity}' | jq"
        ],
        lookFor: "The required `topology.kubernetes.io/zone` value."
      },
      {
        title: "List nodes in that zone and their headroom",
        run: [
          "kubectl get nodes -l topology.kubernetes.io/zone=eu-west-1b",
          "kubectl describe nodes -l topology.kubernetes.io/zone=eu-west-1b | grep -A6 \"Allocated resources\""
        ],
        lookFor: "No nodes, or nodes full and tainted."
      },
      {
        title: "Check the autoscaler can create capacity in that zone",
        run: [
          "kubectl get nodepool general -o jsonpath='{.spec.template.spec.requirements}' | jq '.[] | select(.key==\"topology.kubernetes.io/zone\")'",
          "kubectl get ec2nodeclass general -o jsonpath='{.status.subnets}' | jq"
        ],
        lookFor: "Zone requirements or discovered subnets that exclude the needed zone."
      }
    ],
    resolution: [
      "Give the zone capacity: let Karpenter launch there (zone allowed, subnet discovered), or for Cluster",
      "Autoscaler use one node group per AZ with `--balance-similar-node-groups`. If the data can be rebuilt,",
      "delete the PVC so a new volume is created where capacity exists; to move data, snapshot the volume and",
      "restore it in another zone."
    ],
    prevention: [
      "Use `WaitForFirstConsumer` StorageClasses so new volumes follow scheduling.",
      "Run stateful workloads with one replica per zone (topology spread) and keep capacity in every zone.",
      "With Cluster Autoscaler, use zonal node groups for workloads that use EBS."
    ],
    signals: [
      [5, "volume node affinity conflict"],
      [1, "\\d+/\\d+ nodes are available"],
      [1, "FailedScheduling"]
    ],
    samples: [
      "Warning  FailedScheduling  1m  default-scheduler  0/9 nodes are available: 3 Insufficient memory, 6 node(s) had volume node affinity conflict. preemption: 0/9 nodes are available: 3 No preemption victims found for incoming pod, 6 Preemption is not helpful for scheduling."
    ],
    related: [
      "pending-insufficient-resources",
      "pending-taint-affinity",
      "multi-attach-error",
      "karpenter-not-provisioning"
    ],
    lab: null,
    runbook: "pending-pods-capacity"
  }
]);
