"""Render-test the chart without a cluster. Requires Helm, Node.js, and PyYAML."""

from pathlib import Path
import shutil
import subprocess
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "charts" / "excalibur"


def render(*settings, release="excalibur"):
    command = ["helm", "template", release, str(CHART), "--namespace", "test"]
    for setting in settings:
        command.extend(["--set", setting])
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    if shutil.which("kubeconform"):
        subprocess.run(
            ["kubeconform", "-strict", "-summary", "-schema-location", "default", "-schema-location", "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"],
            input=result.stdout, check=True, capture_output=True, text=True,
        )
    return list(yaml.safe_load_all(result.stdout))


def resource(documents, kind):
    return next(document for document in documents if document["kind"] == kind)


def app(documents):
    return resource(documents, "Deployment")["spec"]["template"]["spec"]


def environment(container):
    return {entry["name"]: entry for entry in container["env"]}


class ChartTests(unittest.TestCase):
    def test_defaults(self):
        documents = render()
        deployment = resource(documents, "Deployment")
        self.assertEqual(deployment["spec"]["replicas"], 1)
        self.assertEqual(deployment["spec"]["strategy"]["type"], "Recreate")
        self.assertEqual(deployment["metadata"]["name"], "excalibur")
        container = app(documents)["containers"][0]
        env = environment(container)
        self.assertEqual(env["AUTH_MODE"]["value"], "propelauth")
        self.assertEqual(env["PGHOST"]["value"], "excalibur-postgresql")
        self.assertNotIn("PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID", env)
        self.assertFalse(any(doc["kind"] == "ExternalSecret" for doc in documents))
        for probe in ["startupProbe", "readinessProbe", "livenessProbe"]:
            headers = container[probe]["httpGet"]["httpHeaders"]
            self.assertIn({"name": "Host", "value": "excalibur.example.com"}, headers)
        database = resource(documents, "StatefulSet")
        self.assertEqual(database["spec"]["volumeClaimTemplates"][0]["spec"]["resources"]["requests"]["storage"], "8Gi")
        secret = resource(documents, "Secret")
        self.assertEqual(secret["metadata"]["annotations"]["helm.sh/resource-policy"], "keep")
        self.assertEqual(env["PGPASSWORD"]["valueFrom"]["secretKeyRef"]["name"], secret["metadata"]["name"])

    def test_external_database(self):
        documents = render("postgresql.enabled=false", "database.host=db.internal", "database.port=6543", "database.existingSecret=external-db", "database.passwordKey=db-password")
        self.assertFalse(any(doc["kind"] in ["StatefulSet", "PersistentVolumeClaim", "Secret"] for doc in documents))
        self.assertEqual(len([doc for doc in documents if doc["kind"] == "Service"]), 1)
        pod = app(documents)
        for container in [pod["containers"][0], pod["initContainers"][0]]:
            env = environment(container)
            self.assertEqual(env["PGHOST"]["value"], "db.internal")
            self.assertEqual(env["PGPORT"]["value"], "6543")
            self.assertEqual(env["PGPASSWORD"]["valueFrom"]["secretKeyRef"], {"name": "external-db", "key": "db-password"})

    def test_ingress_and_mcp(self):
        documents = render("ingress.enabled=true", "ingress.className=nginx", "publicUrl=https://draw.example.com", "ingress.tls[0].secretName=web-tls", "ingress.tls[0].hosts[0]=draw.example.com", "auth.mcp.enabled=true")
        ingress = resource(documents, "Ingress")
        self.assertEqual(ingress["spec"]["rules"][0]["host"], "draw.example.com")
        self.assertEqual(ingress["spec"]["tls"][0]["secretName"], "web-tls")
        env = environment(app(documents)["containers"][0])
        for name in ["PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID", "PROPELAUTH_REQUEST_VALIDATION_CLIENT_SECRET"]:
            self.assertEqual(env[name]["valueFrom"]["secretKeyRef"]["name"], "excalibur-auth")

    def test_authenticated_port_forward(self):
        documents = render("publicUrl=http://localhost:3000")
        container = app(documents)["containers"][0]
        self.assertEqual(environment(container)["AUTH_MODE"]["value"], "propelauth")
        self.assertIn("PROPELAUTH_API_KEY", environment(container))
        self.assertEqual(container["readinessProbe"]["httpGet"]["httpHeaders"][0]["value"], "localhost:3000")

    def test_probe_hosts_match_application_url_normalization(self):
        for url in [
            "https://draw.example.com:443",
            "http://localhost:80",
            "https://DRAW.example.com",
            "https://DRAW.example.com:8443",
            "http://DRAW.example.com:443",
            "https://DRAW.example.com:0443",
            "http://LOCALHOST:03000",
            "http://[::1]:80",
            "https://[::1]:8443",
        ]:
            with self.subTest(url=url):
                expected = subprocess.run(
                    ["node", "-e", "console.log(new URL(process.argv[1]).host)", url],
                    check=True, capture_output=True, text=True,
                ).stdout.strip()
                documents = render(f"publicUrl={url}")
                container = app(documents)["containers"][0]
                for probe in ["startupProbe", "readinessProbe", "livenessProbe"]:
                    self.assertEqual(container[probe]["httpGet"]["httpHeaders"], [{"name": "Host", "value": expected}])

    def test_ingress_normalizes_hostname_case(self):
        documents = render("ingress.enabled=true", "publicUrl=https://DRAW.example.com:443")
        self.assertEqual(resource(documents, "Ingress")["spec"]["rules"][0]["host"], "draw.example.com")

    def test_remote_auth_secret_targets_are_release_scoped(self):
        targets = []
        for release in ["blue", "green"]:
            documents = render(f"auth.remoteSecretName=production/{release}/auth", "auth.mcp.enabled=true", release=release)
            target = resource(documents, "ExternalSecret")["spec"]["target"]["name"]
            targets.append(target)
            self.assertEqual(target, f"{release}-excalibur-auth")
            env = environment(app(documents)["containers"][0])
            for name in ["PROPELAUTH_API_KEY", "PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID", "PROPELAUTH_REQUEST_VALIDATION_CLIENT_SECRET"]:
                self.assertEqual(env[name]["valueFrom"]["secretKeyRef"]["name"], target)
        self.assertEqual(len(set(targets)), 2)

    def test_aws_secrets_manager(self):
        documents = render("auth.remoteSecretName=production/excalibur/auth", "database.remoteSecretName=production/excalibur/database", "auth.mcp.enabled=true")
        self.assertFalse(any(doc["kind"] == "Secret" for doc in documents))
        external = {doc["metadata"]["name"]: doc["spec"] for doc in documents if doc["kind"] == "ExternalSecret"}
        self.assertEqual(set(external), {"excalibur-auth", "excalibur-database"})
        for name, spec in external.items():
            self.assertEqual(spec["secretStoreRef"], {"name": "aws-secretsmanager", "kind": "ClusterSecretStore"})
            self.assertEqual(spec["target"]["name"], name)
            self.assertEqual(spec["target"]["creationPolicy"], "Owner")
            self.assertEqual(spec["refreshInterval"], "1h")
        self.assertEqual(external["excalibur-auth"]["data"], [
            {"secretKey": key, "remoteRef": {"key": "production/excalibur/auth", "property": key}}
            for key in ["api-key", "mcp-client-id", "mcp-client-secret"]
        ])
        self.assertEqual(external["excalibur-database"]["data"], [
            {"secretKey": "password", "remoteRef": {"key": "production/excalibur/database", "property": "password"}}
        ])

    def test_external_database_remote_secret_and_custom_store(self):
        documents = render("postgresql.enabled=false", "database.host=db.internal", "database.remoteSecretName=production/rds", "database.existingSecret=rds-password", "database.passwordKey=db-password", "externalSecrets.secretStoreRef.name=team-aws", "externalSecrets.secretStoreRef.kind=SecretStore")
        self.assertFalse(any(doc["kind"] in ["StatefulSet", "Secret"] for doc in documents))
        external = resource(documents, "ExternalSecret")["spec"]
        self.assertEqual(external["target"]["name"], "rds-password")
        self.assertEqual(external["secretStoreRef"], {"name": "team-aws", "kind": "SecretStore"})
        self.assertEqual(external["data"][0]["remoteRef"], {"key": "production/rds", "property": "db-password"})
        env = environment(app(documents)["containers"][0])
        self.assertEqual(env["PGPASSWORD"]["valueFrom"]["secretKeyRef"], {"name": "rds-password", "key": "db-password"})

    def test_auth_remote_secret_only_fetches_enabled_credentials(self):
        documents = render("auth.remoteSecretName=production/auth", "auth.existingSecret=team-auth", "auth.apiKeyKey=apiKey", release="blue")
        external = resource(documents, "ExternalSecret")["spec"]
        self.assertEqual(external["target"]["name"], "team-auth")
        self.assertEqual(external["data"], [{"secretKey": "apiKey", "remoteRef": {"key": "production/auth", "property": "apiKey"}}])
        self.assertEqual(environment(app(documents)["containers"][0])["PROPELAUTH_API_KEY"]["valueFrom"]["secretKeyRef"]["name"], "team-auth")

    def test_existing_bundled_database_secret(self):
        documents = render("database.existingSecret=managed-db", "postgresql.persistence.storageClass=fast")
        self.assertFalse(any(doc["kind"] == "Secret" for doc in documents))
        database = resource(documents, "StatefulSet")["spec"]
        self.assertEqual(database["volumeClaimTemplates"][0]["spec"]["storageClassName"], "fast")
        env = environment(database["template"]["spec"]["containers"][0])
        self.assertEqual(env["POSTGRES_PASSWORD"]["valueFrom"]["secretKeyRef"]["name"], "managed-db")

    def test_unsafe_or_incomplete_settings_fail(self):
        for settings in [
            ["auth.mode=invalid"],
            ["auth.mode=development"],
            ["auth.mode=development", "auth.mcp.enabled=true"],
            ["auth.mode=development", "ingress.enabled=true"],
            ["postgresql.enabled=false", "database.existingSecret=db"],
            ["postgresql.enabled=false", "database.host=db.internal"],
            ["extraEnv[0].name=AUTH_MODE", "extraEnv[0].value=development"],
            ["auth.remoteSecretName=prod/auth", "externalSecrets.secretStoreRef.name="],
            ["auth.remoteSecretName=prod/auth", "externalSecrets.secretStoreRef.kind=Invalid"],
            ["database.remoteSecretName=prod/db", "database.password=plaintext"],
            ["auth.remoteSecretName=prod/auth", "database.existingSecret=excalibur-auth"],
        ]:
            with self.subTest(settings=settings), self.assertRaises(subprocess.CalledProcessError):
                render(*settings)


if __name__ == "__main__":
    unittest.main()
