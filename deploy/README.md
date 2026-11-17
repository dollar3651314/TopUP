# 部署（测试环境和生产共用）

一台服务器（Ubuntu 24.04 或 Debian 13），Docker Compose 跑 5 个容器：Nginx → web；worker；Postgres 16；Redis 7。
合并到 `staging` 且 CI 全绿后，CI 构建测试环境的镜像推到 GitHub 镜像仓库；测试服务器每分钟自己来拉，起不来自动换回上一个版本。GitHub 不登录服务器，服务器上不放任何 GitHub 的写权限。
生产走同一套工具，区别见第 10 节：合并到 `main` 后镜像只推 `prod-<提交号>`，管理员在 GitHub 上批准才移动 `production` 标签；生产服务器跟着 `production` 标签走。

```mermaid
flowchart LR
  PR["PR → CI 全绿"] -->|合并到 staging| IMG["CI：构建镜像<br/>标签 = 提交号 + staging"]
  IMG --> REG[("GitHub 镜像仓库")]
  REG -->|每分钟自己来拉| UP["服务器：topup update<br/>备份 → 换新版本 → 3 分钟内健康检查"]
  UP -->|通过| OK["新版本"]
  UP -->|没通过| RB["自动换回上一个版本<br/>记下不再重试"]
  IMG --> SM["CI：staging-smoke<br/>等服务器换好再冒烟检查"]
```

## 1. 文件
| 文件 | 作用 |
|---|---|
| `deploy/compose.yml` | 5 个容器、只有 Nginx 对外（80、443），web 的 8080 只绑本机 18080 给部署脚本看健康检查；web、worker `pull_policy: never`（只用部署工具拉好、打好标签的镜像） |
| `deploy/profiles/staging.env`、`deploy/profiles/production.env` | 按环境的内存上限、Node 堆、Postgres、Redis 参数，本机多留几个旧镜像、本机备份合计上限（第 3 节）；compose 和 `topup.sh` 读同一个文件 |
| `deploy/compose.gateway.yml` | 平台网关模式叠加的一层：Nginx 只发布 `TOPUP_HTTP_PORT`（普通 HTTP），不挂证书（第 10 节） |
| `deploy/nginx/default.conf.template` | HTTPS、http 跳 https、用 IP 访问 443 直接断开、真实 IP（`X-Real-IP`、`X-Forwarded-For` 用 `$remote_addr` 覆盖）、第一道限流 |
| `deploy/nginx-gateway/default.conf.template` | 平台网关模式的 Nginx：只听 8080、真实 IP 默认不信任任何请求头（第 7 节）、第一道限流 |
| `deploy/kit/topup.sh` | 服务器上的命令 `sudo topup …`（下面第 2 节） |
| `deploy/kit/systemd/` | 三个定时器：`topup-update`（每分钟）、`topup-backup`（每天 UTC 19:40）、`topup-watch`（每 5 分钟） |
| `e2e/deploy-drill.sh` | 演练：在开发机上用真实镜像把各种场景跑一遍（测试环境） |
| `e2e/smoke.sh` | 冒烟检查：`bash e2e/smoke.sh <地址> <提交前 7 位> <production\|staging>`（CI 的 `staging-smoke`、`production-smoke` 调用） |

镜像里带着 `deploy/`（`/topup-kit`），服务器每次更新版本时从镜像里取出部署工具包，工具包和应用永远是同一个提交。

## 2. 命令
第一次部署之前（只做一次）：第一次合并到 `staging`、CI 的 image 推送成功之后，把镜像包设成公开——GitHub 头像 → Your profile → Packages → `topup` → Package settings → Danger Zone → Change visibility → Public。服务器不登录 GitHub，是匿名拉镜像；包是私有的话第一步就拉不到。镜像里只有公开仓库的代码，没有密钥。（未验证：GitHub 文档说第一次推送的包默认私有，从公开仓库推送时会不会自动公开没有核实；包页面已经显示 Public 就跳过这一步。）

第一次部署是一条命令（管理员在云控制台的"远程连接"终端里粘贴，镜像名和域名换成实际的；生产的那条见第 10 节）：

```bash
curl -fsSL https://raw.githubusercontent.com/<所有者>/TopUP/staging/deploy/kit/topup.sh -o /tmp/topup.sh && sudo TOPUP_IMAGE=ghcr.io/<所有者小写>/topup bash /tmp/topup.sh install <域名> <证书提醒邮箱>
```

它做 8 步，每步一行 ✓ / ✗，失败时写原因和下一步然后停下；可以重复运行（做完的步骤跳过，已有的口令不重新生成）：
装软件（Docker、certbot、age、jq；`rclone` 只在打开异地备份时才要；机器上已经有 Docker 时不重装、不改 Docker 的设置、不重启 Docker）→ 取部署工具包 → 生成配置文件（内部口令、主密钥随机生成、不显示；测试环境 `TRON_NETWORK=nile`，生产 `mainnet`，对不上就拒绝）→ 停同一台服务器上别的项目（同一时间只运行一个；**生产从不停别的项目，只报出名字**）并检查对外端口（80、443；平台网关模式只查 `TOPUP_HTTP_PORT`；别的容器和本机进程占着都算，TopUP 自己的不算）→ 检查内存和磁盘 → 申请证书（平台网关模式跳过）→ 启动 → 打开定时器。最后打印一份不含密钥的摘要。

环境（`TOPUP_ENV`，staging / production）第一次 install 时写进 `deploy.env`，之后就固定了：按测试环境装过的机器不能直接改成生产（反过来也一样），命令里写的 `TOPUP_ENV` 和 `deploy.env` 不一样时任何命令都直接停下。镜像标签跟着环境：测试环境只用 `staging`，生产只用 `production`（下载、取工具包、自动更新都是）。

| 命令 | 做什么 |
|---|---|
| `sudo topup status` | 版本、容器、健康检查、还没填的变量、备份、证书、内存、磁盘、检查发现的问题 |
| `sudo topup keys` | 哪些密钥已填（只显示名字）、普通设置的值 |
| `sudo topup set-key 变量名` | 填密钥：屏幕上不显示；只接受清单里的名字；拒绝空格、引号、`$` 等；私钥、节点地址、邮箱先检查格式；写完自动重建 web、worker，报告健康检查里对应的一项 |
| `sudo topup set 变量名 值` | 填普通设置（收件人、确认数等） |
| `sudo topup gen-operator` | 只用于测试环境：在服务器上随机生成两个归集发起账户（ETH/BSC 一把、TRON 一把，已有的不重新生成），私钥只写进 `.env`，屏幕上只显示地址（拿去领测试币、登记进合约） |
| `sudo topup admin-token` | 在终端上显示一次运营后台的初始化口令（不进日志）；初始化完成后后台拒绝再次初始化，口令就没用了 |
| `sudo topup gen-test-admin` | 只用于测试环境：生成测试管理员的令牌（给 GitHub 上的自动验收用例 `staging-e2e` 用，第 9 节）。服务器的 `.env` 只写它的 SHA-256（`TEST_ADMIN_TOKEN_SHA256`），令牌原文只在终端上显示一次、不进日志；再运行一次就换新令牌，旧的立刻作废 |
| `sudo topup test-admin-off` | 关掉测试管理员：删掉 `TEST_ADMIN_TOKEN_SHA256`，令牌立刻作废 |
| `sudo topup set TEST_MERCHANT_IP_BYPASS 商户编号` | 只用于测试环境：打开"测试商户免 IP 白名单"（第 9 节末尾），这个商户调开放 API 提币、批量打款时不查 IP 白名单；不是测试环境的服务器上直接拒绝 |
| `sudo topup test-merchant-ip-off` | 关掉"测试商户免 IP 白名单"：删掉 `TEST_MERCHANT_IP_BYPASS` |
| `sudo topup test-mail` | 发一封测试邮件到 `MAIL_TO` |
| `sudo topup backup` | 立刻备份一次（本机加密保存，默认不传到别处） |
| `sudo topup restore-drill` | 恢复演练：本机最近一份备份解密后恢复进临时容器，核对表、行数、Redis、开户文件、主密钥；不碰正在运行的数据，解密出的临时文件用完删除 |
| `sudo topup backup-key`、`restore-drill --from-r2` | 异地备份用（默认关闭，见第 5 节）：生成管理员的备份密钥对（公钥写进 `deploy.env`，私钥只在屏幕上显示一次）；从 R2 下载最新一份、粘贴私钥解密后演练 |
| `sudo topup rollback` | 换回上一个版本，并且不再自动更新到当前版本 |
| `sudo topup retry` | 清掉"不再重试"的记录（`state/skip`），下一分钟重新尝试最新版本 |
| `sudo topup set TOPUP_REAL_IP_FROM 地址段`、`set TOPUP_REAL_IP_HEADER X-Forwarded-For` | 只用于平台网关模式：实测网关后打开真实 IP（第 7 节）；`set TOPUP_REAL_IP_HEADER off` 关 |
| `sudo topup stop` / `start` | 停下（定时器 → 应用 → 备份 → 数据库，数据保留）/ 启动（测试环境先按同样的顺序停别的项目；生产不停别的项目）。`start` 和 `install` 一样先核对：生产必须 `TRON_NETWORK=mainnet`、`.env` 里不能有 `TEST_ADMIN_TOKEN_SHA256`、`TEST_MERCHANT_IP_BYPASS`（只报变量名），测试环境必须 `nile` |

在控制台运行 `set-key` 时用"远程连接"的普通终端，不要用控制台自带的 AI 助手，也不要把任何值发给对话框。

## 3. 内存总账（容器不用交换分区：`mem_limit` = `memswap_limit`）
上限按环境放在 `deploy/profiles/<环境>.env`，`compose.yml` 和 `topup.sh` 第 5 步读同一个文件（第 5 步打印的"容器上限合计"就是 compose 实际生效的上限之和）。

### 测试环境
按 1.6 GB 的测试服务器定：停掉别的项目后 `free -m` 的 available 约 1,050 MB（服务器上阿里云监控、Docker 自己等常驻程序已经算在里面）。

| 容器 | 上限 | 怎么来的 | 实测峰值（MB） |
|---|---|---|---|
| postgres | 256 MB | `shared_buffers` 48 MB + 20 个连接（web、worker 各最多 3 个）× 约 5 MB + `maintenance_work_mem` 32 MB + 进程本身 | 190（压力测试，含缓存；进程 RSS 48） |
| redis | 80 MB | `maxmemory 48mb`（写满报错、不淘汰数据）+ 进程和 AOF 重写 | 6 |
| web | 256 MB | Node 堆 `--max-old-space-size=144` + 代码、缓冲区约 100 MB | 150 |
| worker | 256 MB | 同 web | 39 |
| nginx | 32 MB | 实际 5 MB 左右 | 5 |
| 合计 | 880 MB | 再留 100 MB 给容器之外的 Docker 进程（5 个 containerd-shim、每个对外端口一个 docker-proxy，实测 RSS 合计约 77 MB）：启动前要求服务器可用内存 ≥ 980 MB（`install`、`start` 会检查，不够就不启动） | |

### 生产（8 GB 内存、4 核的虚拟机；机器上可能还有别的项目在跑，不停它们）
| 容器 | 上限 | 参数 |
|---|---|---|
| postgres | 1,024 MB | `shared_buffers=256MB`、`effective_cache_size=1GB`、`max_connections=40`（`work_mem` 4 MB、`maintenance_work_mem` 32 MB 不变） |
| redis | 256 MB | `maxmemory 192mb`，写满报错、不淘汰数据（noeviction） |
| web | 512 MB | Node 堆 `--max-old-space-size=384` |
| worker | 512 MB | 同 web |
| nginx | 64 MB | |
| 合计 | 2,368 MB | 再留 100 MB：启动前要求可用内存 ≥ 2,468 MB。别的项目照常运行，第 5 步按实际剩下的可用内存检查 |

生产的数是按测试环境实测峰值放宽来的（推断，没有在生产机上压测过）：Postgres 的共享缓冲按 8 GB 机器常用的四分之一以下取 256 MB、连接数翻倍；web、worker 堆放宽到 384 MB；Redis 给开户资料留余量。上线前在生产机上按下面同样的做法实测一次再定。

实测峰值的做法：开发机上用演练环境（`e2e/deploy-drill.sh` 同样的部署方式）部署后采样每个容器的内存（`docker stats` 口径，即用量减去不活跃的文件缓存），期间跑：静态页面、健康检查和各接口的并发请求（20、60 并发各 60 秒，含 2 MB 的大请求体）；负载中同时备份；自动更新到新版本；Postgres 建 40 万行的表和索引、12 个连接同时排序和全表扫描。全程没有容器被杀（`OOMKilled=false`、重启 0 次）。测试数据很少，数据多了以后 Postgres 主要多占文件缓存（可以回收），共享缓冲最多 48 MB 不变。上线到生产换更大的服务器时，可以按这张表放宽。

## 4. 两个配置文件（只在服务器上，权限 600，不进仓库、不进镜像）
- `deploy.env`：部署用。`install` 生成：`TOPUP_DIR`、`TOPUP_IMAGE`、`TOPUP_ENV`（staging / production，之后不能改）、`DOMAIN`、`CERT_EMAIL`、`CERT_NAME`、`LE_DIR`、`WEBROOT_DIR`（这四项平台网关模式没有）、`POSTGRES_PASSWORD`、`REDIS_PASSWORD`；平台网关模式另有 `TOPUP_GATEWAY=platform`、`TOPUP_HTTP_PORT`、`TOPUP_REAL_IP_HEADER=off`、`TOPUP_REAL_IP_FROM=`（第 7 节）；`BACKUP_OFFSITE=off`（异地备份默认关）。只有打开异地备份时才用到：`backup-key` 写 `BACKUP_AGE_RECIPIENT`；管理员填 `R2_ACCOUNT_ID`、`R2_BUCKET`（`set`）和 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`（`set-key`）。本机备份的加密密钥在 `state/backup-identity`（服务器生成，600）。
- `.env`：应用用，变量见仓库根目录 `.env.example`。`install` 生成 `APP_SECRET`、`ADMIN_SETUP_TOKEN`，设 `TRON_NETWORK=nile`（生产 `mainnet`；生产的 `.env` 里不放 `TEST_ADMIN_TOKEN_SHA256`、`TEST_MERCHANT_IP_BYPASS` 这两行）；
其余由管理员用 `set-key` / `set` 填。`APP_ENV`、`PUBLIC_URL`、`DATABASE_URL`、`REDIS_URL`、`BLOB_DIR`、`TRUST_PROXY=1`、`HOST`、`PORT` 由 `compose.yml` 决定，不放进 `.env`。

## 5. 备份和恢复
- 内容：`pg_dump`（Postgres）、Redis 快照（开户资料和管理员会话在 Redis 里）、开户文件目录、两个配置文件（主密钥 `APP_SECRET` 丢了开户资料就解不开）。
- 什么时候：每天 UTC 19:40；每次自动更新前；`stop` 前。
- **默认只在本机、加密**：`backup/topup-<时间>-<标签>.tar.age`，用 `age` 加密（收件人 = 服务器自己生成的 `state/backup-identity`；管理员跑过 `backup-key` 的话也加上他的公钥），打包时直接写进 `age`，磁盘上不留明文整包。目录 700、文件 600。
- 加密防的是：备份文件被单独拷走（下载、误传）。防不了：有服务器 root 权限的人（他本来就能读 `.env`）；整台服务器丢失（备份跟着丢）。测试环境只有测试数据，这个风险可以接受；上生产前再定异地备份。
- 保留：超过 7 天的删掉；本机备份合计超过上限时从最旧的删起（测试环境 2 GB、生产 1 GB，`deploy/profiles/` 的 `TOPUP_BACKUP_MAX_MB`；运行时的同名环境变量可以临时改）；无论如何至少留最新 3 份。以前版本留下的明文 `.tar` 会被删掉。
- 镜像：本机留正在用的、上一个，再加几个旧版本（测试环境 3 个，合计 5；生产 1 个，合计 3。`TOPUP_KEEP_IMAGES`）；环境标签（`staging`、`production`）不删。
- 异地备份上传到 R2 的 `topup-<环境>/` 目录（`topup-staging/`、`topup-production/`），`restore-drill --from-r2` 也从同一个目录下载。
- 异地（Cloudflare R2）：**默认关闭**（`BACKUP_OFFSITE=off`），没配置不报错。以后要开：`sudo topup backup-key`（管理员私钥存进密码管理器）→ `set BACKUP_OFFSITE r2` → 填 `R2_…` → 装 `rclone`；上传的是同一份密文（配置只经环境变量交给 `rclone`）。打开了但没配好：本机照样备份，只提示、记 `r2=not_configured`；上传失败才报错。
- 恢复演练：`sudo topup restore-drill`（本机那份，用本机密钥解密到临时目录，用完删除）；打开异地后可以 `--from-r2`（下载 R2 上最新一份，管理员粘贴私钥解密，私钥只在内存盘里用完即删）。

## 6. 检查和告警
- 自动更新只看"应用活着"：提交号对得上、数据库、Redis、主密钥、web 的收付款初始化成功（健康检查里有 `wallet` 一项）、换版本之后新的 worker 跑过一轮（扫链时间晚于开始等待的时间，旧 worker 留下的不算）。邮件、节点 Key 没填不算失败（换回旧版本也解决不了）。
- web 和 worker 同时启动时都会建表：建表在数据库锁里做（`server/pay/schema.js` 的 `migrate`），不会互相撞。
- `topup-watch` 每 5 分钟：web 没响应、健康检查 `ok=false`（列出哪几项）、worker 停了、磁盘 ≥ 85% 或剩不到 2 GB（16 GB 的小盘放不下下一次更新）、`.env` 和环境对不上（例如生产的 `TRON_NETWORK` 不是 `mainnet`）、可用内存 < 100 MB、超过 26 小时没备份、上一次备份没加密、上传 R2 失败（只在打开异地时）、有版本更新失败被跳过、证书 14 天内过期、不是测试环境的服务器 `.env` 里有 `TEST_ADMIN_TOKEN_SHA256` 或 `TEST_MERCHANT_IP_BYPASS`。**状态变化时**用应用自己的发信设置发一封邮件给 `MAIL_TO`（问题不变不重复发，恢复时再发一封）。
- 服务器整台宕机时它发不出邮件：要从外部定时探测，另外开（默认不开）。

## 7. 真实 IP
Nginx 用 `$remote_addr` 覆盖 `X-Real-IP` 和 `X-Forwarded-For`；web 设 `TRUST_PROXY=1`，付款页和开放 API 的按 IP 限流、商户的 IP 白名单（提币、批量打款）用这个值。域名的 DNS 要选"仅解析"（不经过 CDN 代理），否则所有访客的 `$remote_addr` 都是 CDN 的地址。web 的端口只绑 `127.0.0.1`（绕过 Nginx 直连时应用会相信请求头）。`e2e/deploy-drill.sh` 场景 3 实测了这两点。

### 平台网关模式（生产现在用的）
机器没有公网 IP，访客 → 平台网关（TLS）→ 机器的 `TOPUP_HTTP_PORT` → Nginx。Nginx 看到的 `$remote_addr` 是**网关的地址**。网关用哪个请求头带访客 IP（`X-Forwarded-For` 还是 `X-Real-IP`）、从哪些地址连过来，**还没有实测**，所以默认不信任任何请求头（访客自己带的也不算）：

- 默认（`TOPUP_REAL_IP_HEADER=off`）：所有访客在应用看来都是网关的地址。后果：按 IP 限流大家共用一个额度（第一道限流每秒 20 个请求、应用里的限流也一样）；**商户的 IP 白名单在生产上未验证、不能用**——白名单里填商户自己的 IP 会一直 403，填网关的地址又等于谁都能过。三条链都没开通，现在没有影响；开通收付款、给商户开 API 之前必须先做下面的实测。`sudo topup status` 和 install 的摘要里有一行"真实 IP：关"提醒。
- 怎么实测（未验证，按这个做）：从自己的电脑访问一次平台地址，在机器上 `docker logs --tail 5 topup-nginx-1`。访问日志每行开头是连进来的地址（网关），后面是 `xff="…"`、`xri="…"` 两个请求头：哪个里面有自己电脑的公网 IP，就是网关用的头；开头的地址（多访问几次，看是不是总在同一个网段）就是网关的地址段。
- 打开：`sudo topup set TOPUP_REAL_IP_FROM <网关地址段>`（多个用逗号隔开，例如 `10.0.0.0/8`），再 `sudo topup set TOPUP_REAL_IP_HEADER X-Forwarded-For`（或 `X-Real-IP`）。`topup.sh` 生成 `state/nginx/realip.conf`（`set_real_ip_from` + `real_ip_header` + `real_ip_recursive on`）并重启 Nginx：只有从网关地址段连进来的请求，才按这个头取访客 IP；`X-Forwarded-For` 里取最右边一个不在网关地址段里的地址（访客自己在最左边塞的假地址不算）。两项都填了才打开，`set TOPUP_REAL_IP_HEADER off` 关。
- 本机实测过（开发机，nginx:1.27-alpine）：关的时候应用拿到的是连进来的地址、访客自己带的 `X-Forwarded-For` 不起作用；打开后拿到的是 `X-Forwarded-For` 里最右边那个不可信的地址。InstaBox 网关本身的行为没有测过。
- 以后换成自己的域名经 Cloudflare 代理（上线前另测）时，网关前面又多一层 CDN，`TOPUP_REAL_IP_FROM` 和请求头要重新实测。


## 8. 演练
```bash
docker build --build-arg APP_ENV=staging -t topup-drill-base .
sudo bash e2e/deploy-drill.sh topup-drill-base
```
在临时目录里跑 11 个场景（外加发起账户生成、初始化口令）：第一次部署（另一个项目占着 80、443）、重复运行、经 Nginx 访问和真实 IP、填密钥（名字和值写错）、自动更新成功、新版本起不来自动换回、手动回滚和重试、备份和恢复演练、每 5 分钟检查、内存不够和 stop / start、新版本"没活"（web 初始化失败；新 worker 不扫链而旧 worker 的扫链时间还新鲜）也要换回。演练模式不装软件、不碰 systemd、证书自签名，所以这三样要在第一次真实部署时逐步确认。

## 9. 测试管理员（只在测试环境）
给测试经理在测试环境上跑大量运营后台操作（打款审核、驳回、改上限、凑批到"待签名"、归集确认、对账），不用管理员每次输动态码。代码在 `server/pay/test-admin.js`，用例在 `e2e/staging-e2e/`，流程是 `.github/workflows/staging-e2e.yml`。

```mermaid
flowchart LR
  S["服务器：sudo topup gen-test-admin<br/>随机生成令牌"] -->|".env 只存 SHA-256"| APP["测试环境的 web<br/>只认 /api/wallet/ 白名单动作"]
  S -->|"令牌只在终端上显示一次"| A["管理员"]
  A -->|"自己填"| GH["GitHub 环境 staging-e2e<br/>只允许 staging、e2e-run/** + Required reviewers<br/>密钥 STAGING_TEST_ADMIN_TOKEN"]
  T["测试经理：写用例、合并到 staging、<br/>手动运行 staging-e2e"] --> WF["staging-e2e 流程"]
  A -->|"每次运行点批准"| WF
  GH --> WF -->|"请求头带令牌"| APP
```

- 怎么触发：GitHub 只在流程文件已经在默认分支（`main`）上时才给手动触发（进 `main` 之前手动触发返回 404），所以另有推送触发（和 `testnet-deploy.yml` 的 `testnet-run/**` 同一个办法）：从最新的 `staging` 拉一个 `e2e-run/<名字>` 分支推上去就跑；只跑部分用例时在这个分支里放 `e2e/staging-e2e/run-files.txt`（空白分隔的用例文件，格式和手动的 `files` 一样，`run.mjs` 同样核对），没有这个文件跑全部。推送触发让还没合并的代码也能拿到令牌（只剩审批一道），所以是临时的：**删除时间**——只含这个流程文件的 PR 合并进 `main` 后，下一个往 `staging` 的 PR 就删掉推送触发，同时请管理员删掉环境里 `e2e-run/**` 那条分支规则；之后只用手动触发。
- 安全边界在哪里：只有 GitHub 环境 `staging-e2e` 的 Required reviewers 算数（管理员批准这一次运行，密钥才交给它）。Deployment branches 只允许 `staging` 和 `e2e-run/**`，但能推 `e2e-run/**` 分支的人连流程文件都能改，所以分支限制和流程里 job 上的 `if` 都只是防手误。管理员每次批准前都要看这次运行用的提交。智能体不批准部署（公司制度仓库里的规则）：主会话推送触发后，把这次运行的链接交给管理员批准。
- 谁持有什么：令牌原文在管理员手里（生成时看一眼、填进 GitHub）和 GitHub 环境密钥里；服务器只有哈希；仓库里没有；运行日志里 GitHub 会遮盖原文。**但运行中的用例代码能读到令牌**：`run.mjs` 只给用例进程它要的几个环境变量，`lib.mjs` 读进令牌后马上从环境里删掉、用例只拿到请求函数，这只能防无意泄露，挡不住合并进 `staging` 的故意作恶的用例代码。真正的保护是 Required reviewers（每次运行前看一眼这次的提交）加上定期换令牌（`sudo topup gen-test-admin`）。
- 日志公开：仓库是公开的，运行日志谁都能看。用例只输出通过 / 失败、HTTP 状态和错误码（`lib.mjs` 的 `ok()`、`expectError()`），不输出接口返回的内容，也不上传报告。写新用例只许用 `assert.ok(条件, 说明)` 和 `ok()`、`expectError()`：`assert.equal`、`deepEqual`、`strictEqual`（还有 `match`）失败时 node 会把实际值（接口返回）打印进日志，`test/staging-e2e-kit.test.js` 的静态检查会拦下；用例文件里也不许 `console.*`、`JSON.stringify`、`process.stdout.write`（同一个检查，覆盖这个目录的每个 `.mjs`，`lib.mjs` 发请求序列化请求体、`run.mjs` 打印一行提交号是认可的例外）。
- 生产没有：应用只在 `APP_ENV=staging` 且 `TRON_NETWORK=nile` 时认它；配了以太坊 / BSC 节点的，节点的链 ID 要在测试网白名单里（Sepolia 11155111、Holesky 17000、Hoodi 560048、BSC 测试网 97），不在或查不到时这次不认（TRON 节点本身是不是 Nile 没有另外核对，只看 `TRON_NETWORK`）；生产的 `.env` 里有这个变量时 web、worker 拒绝启动（自动更新会换回旧版本），`topup-watch` 也会发邮件；`gen-test-admin` 在不是测试环境的服务器上直接拒绝。
- 能做：读运营后台的数据；打款审核、驳回、解除挂起、凑批到"待签名"、作废没签名的批次、改打款上限（免动态码）；归集凑批、确认、作废；对账、异常到账标记。改东西的动作只收 POST。
- 不能做（服务器返回 403）：签名、交签名、改授权额度、确认作废（已广播的批次）、改归集门槛、切换钱包提供方、开通商户、重发邀请、改商户、开户审核后台（`/api/kyb/`）的任何接口；以后新加的动作默认不给。
- 开户和商户资料：商户列表（`merchants`，里面有联系人邮箱和待开通的开户申请）、客户列表和详情（`customers`、`customer`，里面有客户姓名）不给（403）。其余返回里带商户名、名称、邮箱、公司名的（打款审核、提币列表、归集地址、异常到账、概览的商户排行等）统一打码成"首字 + ***"（`maskForTestAdmin`，链名除外）。另外不管哪个字段，内容里邮箱形式的部分（含 `%40`、全角＠）都打码成"首字***"（不留 @；没有 @ 的字符串直接原样返回，两边限长，很长的交易原文不会拖慢）：这只是兜底，不是完整的个人信息清洗（电话、住址、姓名这类不按内容识别）；客户编号、驳回原因这类自由文本可能放了邮箱，按字段名列不全，所以按内容兜底；单元测试核对白名单里所有只读动作的返回都没有 @。商户编号、地址、金额照常给。
- 审计：业务动作的操作人记成 `test-admin`；每个 POST 另记一条 `test_admin.request`（动作名、成功或错误码）。
- 造打款单（可选）：用例要新建打款单时，用测试环境里一个测试商户的开放 API Key（同一个 GitHub 环境的密钥 `STAGING_E2E_MERCHANT_KEY`、`STAGING_E2E_MERCHANT_SECRET`，管理员在测试环境的商户后台生成后自己填）；没填时这类用例跳过。
- 演练（`e2e/deploy-drill.sh`）里有测试管理员的生成和关闭两项检查。
- 换令牌：再运行一次 `sudo topup gen-test-admin`，把新令牌填进 GitHub（旧令牌立刻作废）。怀疑泄露时先 `sudo topup test-admin-off`。

### 管理员的设置顺序（先关卡、后密钥）
1. GitHub 仓库 → Settings → Environments → New environment，名字 `staging-e2e`。
2. **先**设 Deployment branches and tags：Selected branches，加两条：`staging` 和 `e2e-run/**`（第二条是因为流程文件进 `main` 之前只能靠推送 `e2e-run/` 分支触发；进了 `main`、删掉推送触发后，这条也可以删）。
3. **再**打开 Required reviewers，加管理员自己。注意：审批只挡得住和审批人不是同一个 GitHub 账号的人。**现在智能体就是用仓库所有者（管理员）自己的 GitHub 账号操作的**，它也能通过接口自己批准这次运行，所以 Required reviewers 在技术上挡不住智能体，只能挡住别的账号和手误；测试网部署用的 GitHub 环境 `testnet` 也是同一个问题。智能体批不批准部署、要不要换成单独账号，按公司制度仓库里的规则处理（另行请管理员定）。
4. 最后才填密钥：服务器上 `sudo topup gen-test-admin`，把显示的令牌填进这个环境的 Environment secrets → `STAGING_TEST_ADMIN_TOKEN`，然后 `clear`。
5. 以后每次有人运行 `staging-e2e`（智能体推送触发后会把运行链接发给管理员）：先看这次运行用的提交（`e2e/staging-e2e/` 和流程文件有没有改动、改了什么），没问题再点批准。

### 测试商户免 IP 白名单（只在测试环境）
开放 API 的提币（`POST /api/v1/withdrawals/`）和批量打款（`POST /api/v1/payouts/batch/`）要求请求 IP 在商户的 IP 白名单里。GitHub 上跑 `staging-e2e` 的机器每次 IP 都不一样，白名单写不进去，所以给**一个**测试商户免这一项检查。代码在 `server/pay/test-admin.js`（`testMerchantIpBypass`）和 `server/pay/api-v1.js`（`needIp`）。

- 怎么开：服务器上 `sudo topup set TEST_MERCHANT_IP_BYPASS 商户编号`（商户编号是运营后台商户列表里 `m_` 开头的那一列，就是用例用的那个测试商户，也就是 `STAGING_E2E_MERCHANT_KEY` 所属的商户）。写进 `.env` 后自动重建 web、worker，最后一行显示"测试商户免 IP 白名单：开着"。
- 怎么关：`sudo topup test-merchant-ip-off`（删掉这一行，自动生效）。
- 怎么看：`sudo topup status` 里有一行"测试商户免 IP 白名单：开着 / 关着"（读健康检查的 `test_merchant_ip_bypass`，只给是否，不给商户编号）；`sudo topup keys` 的普通设置里能看到商户编号。web、worker 启动时日志里有一行 `TEST_MERCHANT_IP_BYPASS on`。
- 生效条件和测试管理员完全一样：`APP_ENV=staging` 且 `TRON_NETWORK=nile`；配了以太坊 / BSC 节点的，链 ID 要在测试网白名单里（11155111、17000、560048、97），不在或查不到时这次不免。条件不满足就当没配。
- 只免 IP 白名单这一项：签名、时间戳、幂等键、余额、打款上限、逐行校验都照旧；别的商户不受影响（白名单为空照样 403）。
- 生产没有：生产的 `.env` 里有这个变量时 web、worker 拒绝启动（说明里只有变量名），`topup-watch` 也会发邮件；`set` 在不是测试环境的服务器上直接拒绝。
- 风险：拿到这个测试商户 API Key 和 Secret 的人可以从任何 IP 用它提币、批量打款（测试网的币）。Key、Secret 只在 GitHub 环境 `staging-e2e` 的密钥里，怀疑泄露时先 `sudo topup test-merchant-ip-off`，再在商户后台重新生成密钥。

## 10. 生产（先搭起来，不算上线）
生产机是管理员自己的一台小虚拟机：Debian 13（trixie）、4 核、8 GB 内存、16 GB 磁盘（约 11 GB 空闲）、已经装好 Docker；**网卡上没有公网 IP**，外面进来只能走平台自带的端口发布（`instabox-port publish 8080` → `https://8080-<编号>.<平台域名>`，TLS 在平台网关做，没有自定义域名）。现在的目标是"生产环境起来、三条链都 not_enabled"，不算上线。

```mermaid
flowchart LR
  M["PR 合并到 main → CI 全绿"] --> IP["CI：image-production<br/>构建 APP_ENV=production<br/>只推 prod-提交号"]
  IP --> PR["CI：promote-production<br/>GitHub 环境 production<br/>管理员点批准"]
  PR -->|"production 标签指到 prod-提交号<br/>（不重新构建）"| REG[("GitHub 镜像仓库")]
  REG -->|"每分钟自己来拉 :production"| BOX["生产机：topup update<br/>备份 → 换新版本 → 健康检查<br/>没通过自动换回"]
  PR --> SM["CI：production-smoke<br/>等生产换好 → e2e/smoke.sh … production"]
  U["访客"] -->|HTTPS| GW["平台网关（TLS）"] -->|"HTTP 8080"| NG["Nginx（只听 8080）"] --> WEB["web"]
```

### 和测试环境的区别
| | 测试环境 | 生产 |
|---|---|---|
| 镜像标签 | `staging`（合并到 `staging` 就推） | `production`（合并到 `main` 后先推 `prod-<提交号>`，管理员批准才移动 `production`） |
| `TRON_NETWORK` | 必须 `nile` | 必须 `mainnet`（对不上 install、start 都拒绝，自动更新也不换版本） |
| 测试变量 | 可以开测试管理员、测试商户免 IP 白名单 | `.env` 里有 `TEST_ADMIN_TOKEN_SHA256` 或 `TEST_MERCHANT_IP_BYPASS` 时 install、start 拒绝（只报变量名）；`gen-test-admin`、`set TEST_MERCHANT_IP_BYPASS` 直接拒绝；健康检查里也没有这两项 |
| 别的项目 | 停掉（同一时间只运行一个） | **从不停**，只报出名字 |
| 对外 | Nginx 80、443，Let's Encrypt 证书 | 平台网关模式：Nginx 只发布 `TOPUP_HTTP_PORT`（8080）的普通 HTTP，不申请证书；`PUBLIC_URL` = `https://<平台发布的主机名>` |
| 内存上限合计 | 880 MB | 2,368 MB（第 3 节） |
| 本机备份上限 / 多留旧镜像 | 2 GB / 3 个 | 1 GB / 1 个（16 GB 的盘） |
| 异地备份 | 关 | 关（管理员定的：整台机器丢了数据也跟着丢） |
| 收付款 | `config/wallets.json` 的 staging 一节 | production 一节合约地址全空：ETH、BSC、TRON 都 not_enabled |

### 第一次部署（在生产机的终端里粘贴，`<所有者>`、主机名换成实际的）
前提：至少有一次合并到 `main` 经管理员批准、`promote-production` 成功（镜像仓库里有 `production` 标签），镜像包是公开的（第 2 节）。平台上先把 8080 发布出去，拿到 `https://8080-<编号>.<平台域名>`。

```bash
curl -fsSL https://raw.githubusercontent.com/<所有者>/TopUP/main/deploy/kit/topup.sh -o /tmp/topup.sh && sudo TOPUP_IMAGE=ghcr.io/<所有者小写>/topup TOPUP_ENV=production TOPUP_GATEWAY=platform TOPUP_HTTP_PORT=8080 bash /tmp/topup.sh install 8080-<编号>.<平台域名>
```

- 只写主机名（不要 `https://` 和斜杠），不写证书邮箱。重复运行用同一条命令。
- 第 1 步：机器上已经有 Docker，不重装、不写 `/etc/docker/daemon.json`、不重启 Docker（会把机器上别的容器一起重启）；只补 `age`、`jq`、`curl`、`openssl` 里缺的。
- 第 4 步：8080 被别的容器或本机程序占着就停下并说出是谁；80、443 不查。
- 第 5 步：可用内存要 ≥ 2,468 MB，磁盘至少剩 5 GB。
- 装好以后：`sudo topup status` 看状态；邮件、TronGrid Key 等用 `set-key` / `set` 填（第 2 节）。三条链都没开通，不用填节点和发起账户。
- 以后换成自己的域名（经 Cloudflare 代理，上线前另测）：要重新定 `DOMAIN`、真实 IP（第 7 节），现在的工具不支持原地改域名，到时候另出方案。

### 管理员在 GitHub 上要做的（只做一次）
1. Settings → Environments → New environment，名字 `production`；打开 Required reviewers，加管理员自己；Deployment branches 选 Selected branches，只加 `main`。
2. Settings → Secrets and variables → Actions → Repository secrets，新建 `PRODUCTION_URL`，值是平台发布的地址（`https://8080-<编号>.<平台域名>`，不带最后的斜杠）。没填时 `production-smoke` 跳过（只警告）。
3. 以后每次合并到 `main`：CI 全绿后 `promote-production` 等批准；批准前看一眼这次的提交。批准后生产机一分钟内开始换版本，`production-smoke` 等它换好再检查。不批准就不会上生产（`prod-<提交号>` 镜像推了也不影响生产）。

注意：同一个 `main` 上又合并了新的提交时，CI 的并发设置会取消前一次还在等批准的运行（只批准最新的那次就行）。Required reviewers 挡不住用管理员自己账号操作的智能体（第 9 节第 3 条同样的问题），智能体不批准部署按公司制度处理。

### 未验证（第一次真实部署时逐步确认）
- 平台网关怎么转发：转到机器的哪个地址（Nginx 发布在 `0.0.0.0:8080`，没有公网 IP，只有平台网关能连进来）、带不带 `Host`（Nginx 一律用 `DOMAIN` 作 `Host` 转给应用，不依赖网关）、带哪个访客 IP 的请求头（第 7 节）。
- Debian 13 上的第 1 步、systemd 定时器、`ss`（本机只用假命令和演练模式测过）。
- 生产的内存上限是推断的，没有在生产机上压测（第 3 节）。
- CI 的 `promote-production` 用 `docker buildx imagetools create` 改标签、`production-smoke`：要等第一次合并到 `main` 才真正跑。
