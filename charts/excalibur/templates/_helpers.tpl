{{- define "excalibur.name" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "excalibur.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "excalibur.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "excalibur.publicHost" -}}
{{- /* Match the server's URL.host casing and default-port normalization. */ -}}
{{- $url := urlParse .Values.publicUrl -}}
{{- $host := lower $url.host -}}
{{- $port := regexFind ":[0-9]+$" $host -}}
{{- if $port -}}
  {{- $host = trimSuffix $port $host -}}
  {{- $number := int (default "0" (regexReplaceAll "^0+" (trimPrefix ":" $port) "")) -}}
  {{- if not (or (and (eq (lower $url.scheme) "https") (eq $number 443)) (and (eq (lower $url.scheme) "http") (eq $number 80))) -}}
    {{- $host = printf "%s:%d" $host $number -}}
  {{- end -}}
{{- end -}}
{{- $host -}}
{{- end -}}

{{- define "excalibur.authSecret" -}}
{{- default (printf "%s-auth" (include "excalibur.name" .)) .Values.auth.existingSecret -}}
{{- end -}}

{{- define "excalibur.databaseHost" -}}
{{- if .Values.postgresql.enabled -}}
{{- include "excalibur.name" . -}}-postgresql
{{- else -}}
{{- required "database.host is required when postgresql.enabled=false" .Values.database.host -}}
{{- end -}}
{{- end -}}

{{- define "excalibur.databasePort" -}}
{{- if .Values.postgresql.enabled -}}5432{{- else -}}{{ .Values.database.port }}{{- end -}}
{{- end -}}

{{- define "excalibur.databaseSecret" -}}
{{- default (printf "%s-database" (include "excalibur.name" .)) .Values.database.existingSecret -}}
{{- end -}}

{{- define "excalibur.databaseEnv" -}}
- name: PGHOST
  value: {{ include "excalibur.databaseHost" . | quote }}
- name: PGPORT
  value: {{ include "excalibur.databasePort" . | quote }}
- name: PGDATABASE
  value: {{ .Values.database.name | quote }}
- name: PGUSER
  value: {{ .Values.database.user | quote }}
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "excalibur.databaseSecret" . }}
      key: {{ .Values.database.passwordKey | quote }}
{{- end -}}
