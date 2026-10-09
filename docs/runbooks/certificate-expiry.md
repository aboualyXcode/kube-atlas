<!-- Generated from data/runbooks.js by `node scripts/atlas.mjs docs`. Edit the data, then regenerate. -->

# Runbook: Certificate expiry

**Trigger:** `CertificateExpiringSoon` (under 21 days: ticket; under 7 days: page), `CertificateNotReady`, or `x509` errors appearing at a precise time.

**Impact:** at expiry, every client that validates the certificate fails at once: an ingress (users see browser errors), a webhook (cluster writes fail), or service-to-service TLS.

[Open as a flowchart](../../index.html#/operations/runbooks/certificate-expiry)

## Triage (5 minutes)

```sh
kubectl get certificates -A
kubectl get certificates -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\t"}{.status.notAfter}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' | sort -k2
```

For an external endpoint:

```sh
openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -dates -issuer -ext subjectAltName
```

Identify what the certificate protects and who validates it. See [x509-certificate-errors](../failures/x509-certificate-errors.md).

## Diagnose

**Cert-manager certificates.** follow the chain to the failing step. Typical failures: an HTTP01 challenge unreachable through the ALB, a DNS01 Route 53 permission error (the cert-manager role), an ACME rate limit, an issuer pointing at a deleted secret.

```sh
kubectl describe certificate <name> -n <ns> | sed -n '/Status/,$p'
kubectl get certificaterequest,order,challenge -n <ns>
kubectl logs -n cert-manager deploy/cert-manager --tail=100 | grep -i <name>
```

**Webhook certificates.** compare the configuration's `caBundle` with the serving certificate's issuer; check the CA injector (`cainjector`) is running.

**ACM certificates on load balancers.** check validation status and renewal eligibility in ACM (DNS validation records still present).

## Mitigate

Trigger renewal once the cause is fixed: `cmctl renew <name> -n <ns>` (or delete the Certificate's Secret to force reissue, accepting a short gap).

For a webhook with an expired certificate blocking the cluster, set `failurePolicy: Ignore` temporarily while reissuing.

For an imminent external expiry with a broken pipeline, import a manually issued certificate as a stopgap and record it for removal.

## Resolve

Fix the issuance path permanently (permissions, challenge routing, DNS records) and confirm the next renewal will be automatic: cert-manager renews at two thirds of the lifetime by default.

## Verify

`Ready=True`, `notAfter` in the future, clients connecting without errors, and the CA bundle injected where needed.

## Escalate

Page if expiry is under 24 hours away and renewal is still failing, or if a production endpoint is already serving an expired certificate.

## Follow up

Every certificate must be monitored: add blackbox probes for externally served certificates not managed by cert-manager.
