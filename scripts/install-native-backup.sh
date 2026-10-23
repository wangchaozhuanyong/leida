#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 3 ] || { [ "$1" != '--plan' ] && [ "$1" != '--install' ]; }; then
  echo '用法：install-native-backup.sh --plan|--install 绝对项目目录 已有数据库容器名' >&2
  exit 2
fi
radar_mode="$1"
radar_root="$2"
radar_container="$3"
if [[ "$radar_root" != /* ]] || [[ "$radar_root" == *$'\n'* ]] || [[ "$radar_root" == *$'\r'* ]] || [[ "$radar_root" == *%* ]] || [[ "$radar_root" == *'$'* ]] || ! [[ "$radar_container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]]; then
  echo '备份项目路径或数据库容器无效' >&2; exit 2
fi
radar_root="$(cd "$radar_root" && pwd -P)"
if ! test -f "$radar_root/scripts/backup-database.sh" || ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"moyao-reset-radar"' "$radar_root/package.json"; then
  echo '该目录不是可核验的 Reset Radar 项目' >&2; exit 2
fi
radar_quoted_root="${radar_root//\\/\\\\}"
radar_quoted_root="${radar_quoted_root//\"/\\\"}"
render_service() {
  cat <<UNIT
[Unit]
Description=Reset Radar database backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory="$radar_quoted_root"
ExecStart=/bin/bash "$radar_quoted_root/scripts/backup-database.sh" --container $radar_container
TimeoutStartSec=1800
Restart=on-failure
RestartSec=30min
UMask=0077
StandardOutput=journal
StandardError=journal
UNIT
}
render_timer() {
  cat <<'UNIT'
[Unit]
Description=Daily Reset Radar database backup

[Timer]
OnBootSec=5min
OnCalendar=*-*-* 03:15:00 Asia/Shanghai
Persistent=true
Unit=reset-radar-backup.service

[Install]
WantedBy=timers.target
UNIT
}
if [ "$radar_mode" = '--plan' ]; then
  echo '# reset-radar-backup.service'; render_service
  echo '# reset-radar-backup.timer'; render_timer
  exit 0
fi
if [ "$(uname -s)" != 'Linux' ] || [ "$(id -u)" != '0' ]; then
  echo '仅允许在已授权的 Linux 宿主机以 root 安装；预览请使用 --plan' >&2; exit 1
fi
radar_service='/etc/systemd/system/reset-radar-backup.service'
radar_timer='/etc/systemd/system/reset-radar-backup.timer'
# Check both before writing either; different existing units require explicit review.
if { test -e "$radar_service" && ! cmp -s "$radar_service" <(render_service); } || { test -e "$radar_timer" && ! cmp -s "$radar_timer" <(render_timer); }; then
  echo '已有备份单元内容不同，未覆盖，请先核对' >&2; exit 1
fi
umask 022
set -o noclobber
if ! test -e "$radar_service"; then render_service > "$radar_service"; fi
if ! test -e "$radar_timer"; then render_timer > "$radar_timer"; fi
systemctl daemon-reload
systemctl enable --now reset-radar-backup.timer
systemctl start reset-radar-backup.service
systemctl is-active reset-radar-backup.timer
# Success here includes one real backup exit, not just enabling a timer.
systemctl show reset-radar-backup.service --property=Result --property=ExecMainStatus --property=ExecMainExitTimestamp
