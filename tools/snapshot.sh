#!/usr/bin/env bash
# Read-only cluster snapshot for an incident channel or a postmortem.
# Usage: tools/snapshot.sh [output-dir]
# Collects nodes, warning events, failing pods (with describe and previous logs), workload status,
# platform add-on health, APIServices, webhooks, PDBs and Karpenter state. Changes nothing.
set -euo pipefail

out="${1:-snapshot-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$out/pods"

run() { # run <file> <command...>: save output, never fail the whole snapshot
  local file="$1"; shift
  { echo "\$ $*"; "$@" 2>&1 || true; } > "$out/$file"
}

echo "writing $out/"
run context.txt         kubectl config current-context
run version.txt         kubectl version
run nodes.txt           kubectl get nodes -o wide -L topology.kubernetes.io/zone,karpenter.sh/nodepool,node.kubernetes.io/instance-type
run node-conditions.txt kubectl get nodes -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,MEM:.status.conditions[?(@.type=="MemoryPressure")].status,DISK:.status.conditions[?(@.type=="DiskPressure")].status,TAINTS:.spec.taints[*].key'
run events-warning.txt  kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp
run pods-not-running.txt kubectl get pods -A -o wide --field-selector=status.phase!=Running,status.phase!=Succeeded
run deployments.txt     kubectl get deployments -A
run statefulsets.txt    kubectl get statefulsets -A
run daemonsets.txt      kubectl get daemonsets -A
run hpa.txt             kubectl get hpa -A
run pdb.txt             kubectl get pdb -A
run pvc.txt             kubectl get pvc -A
run services-lb.txt     kubectl get svc -A --field-selector spec.type=LoadBalancer
run ingresses.txt       kubectl get ingress -A
run apiservices.txt     kubectl get apiservices
run webhooks.txt        kubectl get mutatingwebhookconfigurations,validatingwebhookconfigurations
run kube-system.txt     kubectl get pods -n kube-system -o wide
run top-nodes.txt       kubectl top nodes
run karpenter.txt       kubectl get nodepools,nodeclaims,ec2nodeclasses -o wide

# Describe and previous logs for up to 25 pods that are not Running, or Running but not Ready.
kubectl get pods -A --no-headers \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,READY:.status.containerStatuses[*].ready' 2>/dev/null \
  | awk '$3 != "Succeeded" && ($3 != "Running" || $4 ~ /false/) {print $1, $2}' \
  | head -25 \
  | while read -r ns pod; do
      run "pods/${ns}_${pod}.describe.txt" kubectl describe pod "$pod" -n "$ns"
      run "pods/${ns}_${pod}.previous.log" kubectl logs "$pod" -n "$ns" --all-containers --previous --tail=200
    done

echo "done: $(find "$out" -type f | wc -l) files. Attach $out/ to the incident, or: tar czf $out.tgz $out"
