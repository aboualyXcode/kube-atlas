#!/usr/bin/env bash
# DNS health check from inside the cluster.
# Usage: tools/dns-check.sh [namespace] [external-name]
# Shows CoreDNS state, then starts a temporary busybox pod in the namespace (deleted afterwards) to
# print its resolv.conf and resolve an in-cluster name, a short name and an external name.
set -euo pipefail

ns="${1:-default}"
external="${2:-amazon.com}"
pod="dns-check-$RANDOM"

echo "== CoreDNS"
kubectl get deploy coredns -n kube-system -o wide || true
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide || true
kubectl get endpointslices -n kube-system -l kubernetes.io/service-name=kube-dns || true
echo
echo "== Recent CoreDNS errors"
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=200 --prefix 2>/dev/null | grep -E "ERROR|timeout|SERVFAIL" | tail -20 || echo "(none)"
echo
echo "== Lookups from a pod in namespace $ns"
kubectl run "$pod" -n "$ns" --rm -i --restart=Never --image=busybox:1.36 --quiet -- sh -c "
  echo '-- /etc/resolv.conf'; cat /etc/resolv.conf
  for name in kubernetes.default.svc.cluster.local kubernetes.default $external $external.; do
    echo \"-- nslookup \$name\"
    start=\$(date +%s)
    nslookup \"\$name\" >/tmp/out 2>&1 && result=ok || result=FAILED
    echo \"\$result in \$((\$(date +%s) - start))s\"; grep -E 'Address|NXDOMAIN|timed out|can.t find' /tmp/out | head -4
  done
"
echo
echo "A lookup taking ~5s points at dropped packets (docs/failures/dns-timeouts.md);"
echo "a fast NXDOMAIN points at the name or namespace (docs/failures/dns-nxdomain.md)."
