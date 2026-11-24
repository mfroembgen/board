{{- define "board.url" -}}
https://{{ required "host is required" .Values.host }}/api/board
{{- end -}}
