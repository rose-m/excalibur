# Excalibur Helm chart

Helm 3, Kubernetes 1.25+. PropelAuth only. Defaults: one app replica, ClusterIP,
no Ingress, bundled Postgres 17 with an 8 GiB PVC using the default StorageClass.
See [values.yaml](values.yaml) for all options.

## Install

Published releases include a default image matching the chart version. Supply
your public origin and PropelAuth configuration:

```yaml
# deployment-values.yaml
publicUrl: https://draw.example.com
auth:
  url: https://your-project.propelauthtest.com
  existingSecret: excalibur-auth # Kubernetes Secret containing api-key.
ingress:
  enabled: true
  className: nginx
  tls:
    - secretName: excalibur-tls
      hosts: [draw.example.com]
```

```sh
helm upgrade --install excalibur oci://ghcr.io/rose-m/charts/excalibur \
  --version 0.1.0 \
  --namespace excalibur --create-namespace \
  --values deployment-values.yaml --wait --timeout 10m
```

Use an available release version. For a local chart install, replace the OCI URL
with `./charts/excalibur`, omit `--version`, and set `image.repository` and
`image.tag` to an image you have built and pushed.

Ingress host derives from `publicUrl`; register that origin in PropelAuth.
Your proxy must preserve Host, support WebSockets/MCP streaming, and allow
24 MiB requests and long-lived connections. Migrations run at app startup.

For MCP, enable `auth.mcp.enabled` and add `mcp-client-id` and `mcp-client-secret`
to the auth Secret. Configure PropelAuth's `canvases:access` organization scope.

## IPv6 and dual-stack

The app binds to `::` by default, accepting IPv6 and IPv4 on Linux dual-stack
pods. Set `service.host: 0.0.0.0` if you need an IPv4-only listener. Service
IP-family fields are omitted by default, letting the cluster choose its default.
Bundled Postgres already listens on both address families.

For an IPv6-only deployment:

```yaml
service:
  ipFamilyPolicy: SingleStack
  ipFamilies: [IPv6]
postgresql:
  service:
    ipFamilyPolicy: SingleStack
    ipFamilies: [IPv6]
```

For dual-stack, set both Services to `ipFamilyPolicy: PreferDualStack` and
`ipFamilies: [IPv6, IPv4]` (or reverse the order for IPv4-primary). Use
`RequireDualStack` to require both families. The cluster and CNI must support the
requested families; Ingress IPv6 exposure is configured in your Ingress controller.
Changing an existing Service's primary IP family may require recreating it.

## External Postgres

```yaml
postgresql:
  enabled: false
database:
  host: postgres.example.internal
  name: excalibur
  user: excalibur
  existingSecret: excalibur-database # Contains password; override passwordKey if needed.
```

The database must exist and permit migrations. Use `extraEnv` for `PGSSLMODE`.

## AWS Secrets Manager

Requires an existing External Secrets Operator (`external-secrets.io/v1`) and
AWS-enabled SecretStore. With the default `aws-secretsmanager` ClusterSecretStore:

```yaml
auth:
  remoteSecretName: production/excalibur/auth
database:
  remoteSecretName: production/excalibur/database
```

AWS secrets must be JSON: auth uses `api-key` (plus `mcp-client-id` and
`mcp-client-secret` when MCP is enabled); database uses `password`. Key names are
configurable. Override `externalSecrets.secretStoreRef` for another store.

`remoteSecretName` is the AWS name/ARN; `existingSecret` is the Kubernetes target
name (defaults are release-qualified). Auth and database targets must differ. If your platform already syncs
secrets, use `existingSecret` alone. See the
[ESO AWS docs](https://external-secrets.io/latest/provider/aws-secrets-manager/)
for IAM/store setup.

## Operational constraints

- **Single app replica, Recreate upgrades.** Live rooms are process-local.
- Bundled Postgres is not HA. PVCs and chart-managed database Secrets survive uninstall.
- For GitOps, use existing or remote database credentials rather than generated passwords.
- Secret updates do not restart pods; roll out the app after rotation. Updating a
  Secret does not change an existing Postgres role password.
- When moving credentials to ESO, use a new Kubernetes target name to avoid ownership conflicts.
- Readiness checks startup, not ongoing database availability.

## Validate

```sh
helm lint charts/excalibur --strict
python3 scripts/test-helm.py # Requires Node.js/PyYAML; uses kubeconform if installed.
```
