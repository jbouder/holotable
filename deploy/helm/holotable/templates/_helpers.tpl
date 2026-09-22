{{/*
Name helpers, the standard Helm set.
*/}}
{{- define "holotable.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "holotable.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "holotable.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "holotable.labels" -}}
helm.sh/chart: {{ include "holotable.chart" . }}
{{ include "holotable.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: holotable
{{- end }}

{{- define "holotable.selectorLabels" -}}
app.kubernetes.io/name: {{ include "holotable.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "holotable.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "holotable.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "holotable.migrateServiceAccountName" -}}
{{- if .Values.migrations.serviceAccount.create -}}
{{- default (printf "%s-migrate" (include "holotable.fullname" .)) .Values.migrations.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.migrations.serviceAccount.name -}}
{{- end -}}
{{- end }}

{{/*
Images. A digest wins over a tag, so a deployment can be pinned to exact bytes
the way the Dockerfile pins its own base.
*/}}
{{- define "holotable.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
{{- end }}

{{- define "holotable.migrateImage" -}}
{{- if .Values.migrations.image.digest -}}
{{ .Values.migrations.image.repository }}@{{ .Values.migrations.image.digest }}
{{- else -}}
{{- $tag := .Values.migrations.image.tag | default (printf "%s-migrate" .Chart.AppVersion) -}}
{{ .Values.migrations.image.repository }}:{{ $tag }}
{{- end -}}
{{- end }}

{{/*
The Secret the app reads its credentials from. Either one the chart created or
one that already exists; never both.
*/}}
{{- define "holotable.secretName" -}}
{{- if .Values.secrets.create -}}
{{ include "holotable.fullname" . }}
{{- else -}}
{{ .Values.secrets.existingSecret }}
{{- end -}}
{{- end }}

{{/*
The non-secret environment, rendered into both ConfigMaps from one place so the
Job and the app cannot be handed different settings.
*/}}
{{- define "holotable.configData" -}}
# The drain budget the Deployment's terminationGracePeriodSeconds is sized
# against. Kept here rather than in `config` so the two cannot drift.
SHUTDOWN_GRACE_MS: {{ .Values.app.shutdownGraceMs | quote }}
{{- range $key, $value := .Values.config }}
{{ $key }}: {{ $value | toString | quote }}
{{- end }}
{{- end }}

{{/*
`envFrom` for the app container: the chart's ConfigMap, the credential Secret if
there is one, then whatever else the operator wired up. Rendered in that order,
so a later source wins on a duplicate key.
*/}}
{{- define "holotable.envFrom" -}}
- configMapRef:
    name: {{ include "holotable.fullname" . }}
{{- if include "holotable.secretName" . }}
- secretRef:
    name: {{ include "holotable.secretName" . }}
{{- end }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
`envFrom` for the migration Job. Same sources, except that the ConfigMap is the
Job's own hook copy: a pre-install hook runs before any ordinary release
resource exists, so mounting the app's ConfigMap fails a first install with
`configmap "…" not found`. The chart-managed Secret is a hook for the same
reason; an `existingSecret` and anything in `extraEnvFrom` are the operator's
to create beforehand.
*/}}
{{- define "holotable.migrateEnvFrom" -}}
- configMapRef:
    name: {{ include "holotable.fullname" . }}-migrate
{{- if include "holotable.secretName" . }}
- secretRef:
    name: {{ include "holotable.secretName" . }}
{{- end }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
`terminationGracePeriodSeconds`.

Unset, it is derived: the drain budget, plus the preStop sleep that precedes
it, plus five seconds of slack. Set explicitly, it is checked — a value below
the drain budget means the kubelet sends SIGKILL while the server is still
awaiting in-flight queries, which is the one way to turn a graceful shutdown
back into an abrupt one.
*/}}
{{- define "holotable.terminationGracePeriodSeconds" -}}
{{- $drain := int (ceil (divf (int .Values.app.shutdownGraceMs) 1000)) -}}
{{- $preStop := int .Values.app.preStopSleepSeconds -}}
{{- $floor := add $drain $preStop -}}
{{- $set := .Values.terminationGracePeriodSeconds -}}
{{- if or (kindIs "invalid" $set) (eq (toString $set) "") -}}
{{- add $floor 5 -}}
{{- else -}}
{{- $explicit := int $set -}}
{{- if lt $explicit $floor -}}
{{- fail (printf "terminationGracePeriodSeconds is %d, below the %ds this pod needs to drain (app.shutdownGraceMs %dms + app.preStopSleepSeconds %ds). The kubelet would SIGKILL the server mid-drain; raise it to at least %d or leave it empty to derive it." $explicit $floor (int .Values.app.shutdownGraceMs) $preStop $floor) -}}
{{- end -}}
{{- $explicit -}}
{{- end -}}
{{- end }}

{{/*
`config` becomes a ConfigMap, which is clear text to anyone who can read the
namespace. A credential put there would be readable by every `kubectl get
configmap` and would ride along in `helm get manifest`. Refuse to render
instead of leaking quietly. The list matches the credential-bearing variables
in `.env.example`; the suffixes catch the per-source `secret_ref` families
(`<REF>_USERNAME` / `<REF>_PASSWORD`) and anything new shaped like them.
*/}}
{{- define "holotable.assertNoSecretsInConfig" -}}
{{- $exact := list "DATABASE_URL" "TIMESCALEDB_URL" -}}
{{- $suffixes := list "_SECRET" "_TOKEN" "_PASSWORD" "_API_KEY" "_KEY" -}}
{{- range $key, $value := .Values.config -}}
{{- $upper := upper $key -}}
{{- if has $upper $exact -}}
{{- fail (printf "config.%s is a credential and `config` is rendered into a ConfigMap in clear text. Put it in the Secret named by secrets.existingSecret, or supply it through extraEnvFrom." $key) -}}
{{- end -}}
{{- range $suffix := $suffixes -}}
{{- if hasSuffix $suffix $upper -}}
{{- fail (printf "config.%s looks like a credential (it ends in %s) and `config` is rendered into a ConfigMap in clear text. Put it in the Secret named by secrets.existingSecret, or supply it through extraEnvFrom." $key $suffix) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end }}
