#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
backup_dir="$project_root/backups/database"
umask 077
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
if [ "$#" -eq 0 ]; then
  database_exec=(docker compose exec -T database)
elif [ "$#" -eq 2 ] && [ "$1" = '--container' ] && [[ "$2" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]]; then
  database_exec=(docker exec -i "$2")
else
  echo '用法：backup-database.sh [--container 已有数据库容器名]' >&2
  exit 2
fi
# macOS requires the random X characters at the end of the mktemp template.
temporary_file="$(mktemp "$backup_dir/.radar-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")"
partial_file="$temporary_file.partial"
mv -n "$temporary_file" "$partial_file"
if test -e "$temporary_file"; then
  echo '临时备份目标已存在，未覆盖；请检查备份目录。' >&2
  exit 1
fi
partial_name="${partial_file##*/}"
backup_file="$backup_dir/${partial_name#.}"
backup_file="${backup_file%.partial}.dump"
# Failed or interrupted output remains .partial and never masquerades as a usable backup.
if ! "${database_exec[@]}" pg_dump --username=radar --dbname=radar --format=custom > "$partial_file" 2>/dev/null; then
  echo '数据库备份失败，未完成的文件保留为 .partial；现有备份未覆盖。' >&2
  exit 1
fi
if ! test -s "$partial_file" || ! "${database_exec[@]}" pg_restore --list < "$partial_file" >/dev/null 2>&1; then
  echo '备份文件为空或未通过目录校验，已保留 .partial；不得用于恢复。' >&2
  exit 1
fi
if test -e "$backup_file"; then
  echo '同名备份已存在，未覆盖；本次结果保留为 .partial。' >&2
  exit 1
fi
mv -n "$partial_file" "$backup_file"
if test -e "$partial_file"; then
  echo '备份目标已存在，未覆盖；本次结果保留为 .partial。' >&2
  exit 1
fi
echo "本机数据库备份完成：$backup_file"
printf 'BACKUP_FILE=%s\n' "$backup_file"
