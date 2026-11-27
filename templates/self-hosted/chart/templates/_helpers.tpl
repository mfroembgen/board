{{- define "board.url" -}}
https://{{ required "host is required" .Values.host }}/api/board
{{- end -}}

{{- define "board.spaces" -}}
{{- $pairs := list -}}
{{- range $space, $channel := . -}}
{{- $pairs = append $pairs (printf "%s=%s" $space $channel) -}}
{{- end -}}
{{- join "," $pairs -}}
{{- end -}}
