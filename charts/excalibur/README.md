# Excalibur Helm chart

Helm 3, Kubernetes 1.25+. PropelAuth only. Defaults: one app replica, ClusterIP,
no Ingress, bundled Postgres 17 with an 8 GiB PVC using the default StorageClass.
See [values.yaml](values.yaml) for all options.

## Install

Supply your built image, public origin, and PropelAuth configuration:

```yaml
# deployment-values.yaml
image:
  repository: registry.example.com/excalibur
  tag: YOUR_TAG
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
helm upgrade --install excalibur ./charts/excalibur \
  --namespace excalibur --create-namespace \
  --values deployment-values.yaml --wait --timeout 10m
```

Ingress host derives from `publicUrl`; register that origin in PropelAuth.
Your proxy must preserve Host, support WebSockets/MCP streaming, and allow
24 MiB requests and long-lived connections. Migrations run at app startup.

For MCP, enable `auth.mcp.enabled` and add `mcp-client-id` and `mcp-client-secret`
to the auth Secret. Configure PropelAuth's `canvases:access` organization scope.

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
