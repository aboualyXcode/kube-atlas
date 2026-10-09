#!/usr/bin/env bash
# Read-only EKS checks that catch the AWS side of common incidents and upgrade blockers.
# Usage: tools/eks-preflight.sh <cluster> <region> [--publish-metrics]
# Checks endpoint access and logging, add-on health, upgrade insights, access entries, subnet free
# addresses and load balancer discovery tags. With --publish-metrics, also writes the minimum subnet
# free-address percentage to CloudWatch (Larder/EKS SubnetFreeAddressPercentMin), which the
# SubnetFreeAddressesLow alarm in observability/cloudwatch-alarms.yaml watches. Run it on a schedule.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <cluster> <region> [--publish-metrics]" >&2
  exit 2
fi
cluster="$1"; region="$2"; publish="${3:-}"
aws_() { aws --region "$region" "$@"; }
warn=0
flag() { echo "  WARN: $*"; warn=$((warn + 1)); }

echo "== Cluster $cluster ($region)"
aws_ eks describe-cluster --name "$cluster" \
  --query 'cluster.{version:version,status:status,platform:platformVersion,auth:accessConfig.authenticationMode,public:resourcesVpcConfig.endpointPublicAccess,private:resourcesVpcConfig.endpointPrivateAccess,publicCidrs:resourcesVpcConfig.publicAccessCidrs}' \
  --output table
[[ "$(aws_ eks describe-cluster --name "$cluster" --query 'cluster.resourcesVpcConfig.endpointPrivateAccess' --output text)" == "True" ]] \
  || flag "private endpoint access is off: nodes reach the API through the internet"
logging=$(aws_ eks describe-cluster --name "$cluster" --query 'cluster.logging.clusterLogging[?enabled].types[]' --output text)
if [[ "$logging" != *audit* ]]; then flag "audit logging is not enabled (enabled: ${logging:-none})"; fi

echo "== Add-ons"
for addon in $(aws_ eks list-addons --cluster-name "$cluster" --query 'addons[]' --output text); do
  read -r version status <<<"$(aws_ eks describe-addon --cluster-name "$cluster" --addon-name "$addon" --query 'addon.[addonVersion,status]' --output text)"
  printf '  %-28s %-26s %s\n' "$addon" "$version" "$status"
  [[ "$status" == "ACTIVE" ]] || flag "add-on $addon is $status"
done

echo "== Upgrade insights"
aws_ eks list-insights --cluster-name "$cluster" \
  --query 'insights[].[category,insightStatus.status,name]' --output text | sed 's/^/  /' || true
if aws_ eks list-insights --cluster-name "$cluster" --query 'insights[].insightStatus.status' --output text | grep -qE 'ERROR'; then
  flag "upgrade insights report ERROR: fix before upgrading (docs/runbooks/cluster-upgrade.md)"
fi

echo "== Access entries"
aws_ eks list-access-entries --cluster-name "$cluster" --query 'accessEntries[]' --output text | tr '\t' '\n' | sed 's/^/  /'

echo "== Subnets"
subnets=$(aws_ eks describe-cluster --name "$cluster" --query 'cluster.resourcesVpcConfig.subnetIds[]' --output text)
vpc=$(aws_ eks describe-cluster --name "$cluster" --query 'cluster.resourcesVpcConfig.vpcId' --output text)
discovered=$(aws_ ec2 describe-subnets --filters "Name=tag:karpenter.sh/discovery,Values=$cluster" --query 'Subnets[].SubnetId' --output text)
min_pct=100
printf '  %-26s %-12s %-18s %6s %5s  %s\n' SUBNET AZ CIDR FREE PCT ROLE
for s in $(echo "$subnets $discovered" | tr ' \t' '\n' | sort -u); do
  read -r az cidr free elb ielb <<<"$(aws_ ec2 describe-subnets --subnet-ids "$s" \
    --query 'Subnets[0].[AvailabilityZone,CidrBlock,AvailableIpAddressCount,Tags[?Key==`kubernetes.io/role/elb`]|[0].Value,Tags[?Key==`kubernetes.io/role/internal-elb`]|[0].Value]' --output text)"
  size=$(( 2 ** (32 - ${cidr#*/}) - 5 ))
  pct=$(( free * 100 / size ))
  if (( pct < min_pct )); then min_pct=$pct; fi
  role="-"
  if [[ "$elb" == "1" ]]; then role="public-elb"; elif [[ "$ielb" == "1" ]]; then role="internal-elb"; fi
  printf '  %-26s %-12s %-18s %6s %4s%%  %s\n' "$s" "$az" "$cidr" "$free" "$pct" "$role"
  if (( pct < 20 )); then flag "$s ($az) has only $pct% free addresses (docs/runbooks/pod-ip-exhaustion.md)"; fi
done
public_tagged=$(aws_ ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" "Name=tag:kubernetes.io/role/elb,Values=1" --query 'length(Subnets)' --output text)
if (( public_tagged < 2 )); then flag "fewer than two subnets tagged kubernetes.io/role/elb=1: internet-facing load balancers will fail (docs/failures/loadbalancer-pending.md)"; fi

if [[ "$publish" == "--publish-metrics" ]]; then
  aws_ cloudwatch put-metric-data --namespace Larder/EKS --metric-name SubnetFreeAddressPercentMin \
    --dimensions "ClusterName=$cluster" --unit Percent --value "$min_pct"
  echo "== Published SubnetFreeAddressPercentMin=$min_pct"
fi

echo
if (( warn > 0 )); then echo "$warn warning(s)"; exit 1; fi
echo "no warnings"
