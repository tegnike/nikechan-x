#!/usr/bin/env bash
set -euo pipefail

profile_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_name="ai.hermes.gateway-nikechan-hermes.service"
service_src="$profile_dir/systemd/$service_name"
service_dst="/etc/systemd/system/$service_name"

if [[ ! -f "$service_src" ]]; then
  echo "missing service: $service_src" >&2
  exit 1
fi

cp "$service_src" "$service_dst"
systemctl daemon-reload
systemctl enable "$service_name"
systemctl restart "$service_name"
systemctl status "$service_name" --no-pager
