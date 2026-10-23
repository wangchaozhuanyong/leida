# 原生服务器数据库备份

状态：安装脚本已准备；运行 `--plan` 不会安装、启用定时任务或访问数据库。生产启用属于发布操作，应先获得授权。

备份由 Linux 宿主机的 systemd 监督，使用已有数据库容器，不依赖网站容器的进程和 Docker Compose 项目名称。安装器只需要宿主机已有的 Bash、Docker 和 systemd，不要求宿主机安装 Node。

## 发布时执行

1. 确认宿主机上稳定的 Reset Radar 项目绝对路径，以及数据库容器名。该路径必须有本项目 `package.json` 和 `scripts/backup-database.sh`。备份保存在这个项目的 `backups/database/`，不应放在会自动清理的短期发布目录。
2. 先预览：`bash scripts/install-native-backup.sh --plan '<已核对的宿主机项目绝对路径>' reset-radar-database-1`。
3. 授权后在同一台宿主机安装：`sudo bash scripts/install-native-backup.sh --install '<已核对的宿主机项目绝对路径>' reset-radar-database-1`。

已有同名单元且内容不同会拒绝覆盖，需核对旧配置后再决定。安装会启用定时器，并等待一次实际备份完成；失败不会输出成功结论。

## 策略和验证

- 每天北京时间03:15执行，开机后也会检查；离线错过的日历任务由 `Persistent=true` 补一次。失败后30分钟重试，单次超时30分钟。定时行为依据 [systemd.timer 官方说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)。
- 数据库通过 `docker exec` 调用本地 `pg_dump`，不读取或打印数据库密码，不开放数据库端口。
- 新备份使用独立文件名，权限受限；先保留`.partial`，通过非空与`pg_restore --list`检查后才改为`.dump`，不覆盖已有备份、不自动删除历史文件。
- 检查：`systemctl list-timers reset-radar-backup.timer`、`systemctl show reset-radar-backup.service -p Result -p ExecMainStatus -p ExecMainExitTimestamp`、`journalctl -u reset-radar-backup.service -n 30 --no-pager`。
- 目录检查只能证明归档结构可读；还需在独立恢复库验证表及记录，不能对生产库执行清空或覆盖恢复。
- 本机备份不能覆盖整机或磁盘损失。不要把修复测试生成的`outputs/.../backup-fixture/`归档当作业务备份。

本轮已经在无外部网络、无开放端口的本地隔离 PostgreSQL 中验证备份和恢复，恢复后的发布记录为27条测试记录。这不代表服务器定时任务已安装或生产业务备份已经恢复验证。
