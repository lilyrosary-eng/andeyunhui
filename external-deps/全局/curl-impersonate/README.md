# curl-impersonate（攻防模块 · 真实 TLS 指纹通道）

本目录是攻防模块（`crates/gongfang-kit`）`tls-impersonate` 通道使用的外部二进制，
用于让爬虫/探测请求呈现**真实浏览器的 TLS ClientHello 与 HTTP/2 指纹**（JA3/JA4/Akamai），
而非 rustls 默认指纹（等价于「机器人裸奔」）。

## 来源与版本

- 项目：curl-impersonate v2.2.3（Windows x86_64 预编译发布包）
- 二进制：`curl-impersonate.exe`（4.1 MiB）
- SHA256：`2F41E813B3547BFBF1694B06D7FEC3FEC2F507DE0D219637B4820512A5C7BDB6`
- `curl --version`：`curl 8.22.0-IMPERSONATE (Windows) libcurl/8.22.0-IMPERSONATE BoringSSL ...`

## 许可

MIT（见 `LICENSE`，版权归 curl_cffi developers）。二进制内嵌的第三方组件许可
（BoringSSL / brotli / c-ares / nghttp2 / nghttp3 / ngtcp2 / zlib / zstd / curl）
随附于同目录 `LICENSE_*` 文件。分发本依赖时需一并保留这些文件。

**选型原因**：BoringSSL 进程内客户端（rquest 等）需 cmake/nasm/perl 工具链，
本项目构建机不具备；curl-impersonate 为预编译独立进程，MIT 协议、零构建依赖、
可随时降级为普通 reqwest 通道，故作为唯一实现路线。

## 支持的目标（`--impersonate <target>`）

chrome99/100/101/104/107/110/116/119/120/123/124/131/133a/136/142/145/146、
edge99/101、firefox133/135/144/147、safari153/155/170/180/184/260、
tor145（另有 `*_android` / `*_ios` 变体）。

本模块 `Strategy.tls_profile` → target 的映射见
`crates/gongfang-kit/src/crawler/impersonate.rs::profile_target`：

| Strategy.tls_profile | curl-impersonate target |
| --- | --- |
| `chrome_122` | `chrome123` |
| `firefox_120` | `firefox133` |
| `safari_17` | `safari170` |

注意：`--impersonate` 会自行决定**全套请求头**（UA / sec-ch-ua / sec-fetch-* / Accept 等）
并自洽（例如 `chrome123` 自带 macOS UA）。调用方**不得**再覆盖 UA/Client Hints，
否则「指纹说 Chrome123、头说 Windows Chrome122」反而是更强的爬虫特征。

## 打包

- `scripts/pack-mujin.mjs` 中声明为 `heavy: true`，因此 **Android 构建与 `BUILD_LITE=1`
  会自动跳过**（Windows x86_64 二进制在移动端无用，且避免 APK 体积膨胀）。
- 打包后：`全局/curl-impersonate.mujin` → 安装时解压到
  `<AppData>/user_external_deps/全局/curl-impersonate/`。
- 开发态直接读 `external-deps/全局/curl-impersonate/`。

## 实测基线（防退化，2026-09-25 本机实测）

复现命令：`cargo run --bin tls_probe --features crawler,tls-impersonate`
（在 `crates/gongfang-kit/` 内执行；回显端点 `https://tls.peet.ws/api/all`）

| 通道 | JA4 | HTTP | Akamai h2 指纹 | GREASE |
| --- | --- | --- | --- | --- |
| rustls/reqwest（未启用本通道） | `t13d1011h1_61a7ad8aa9b6_3fcd1a44f3e3` | 1.1 | 无 | 无 |
| curl-impersonate `chrome123` | `t13d1516h2_8daaf6152771_02713d6af862` | 2 | `52d84b11737d980aef856699f885ca86` | 有 |
| 真实 Chrome（参考基准） | `t13d1516h2_8daaf6152771_...` | 2 | `52d84b11737d980aef856699f885ca86` | 有 |

判定要点：`ja4` 前两段与 `akamai_fingerprint_hash` 必须与真实 Chrome 一致；
若退化成 `t13d1011h1_...` 或 `http_version=1.1`，说明请求没有走本通道
（多半是二进制未定位到 → 已静默降级 rustls，`features.tls_impersonate` 会报 false）。

端点差异（勿误判为退化）：`tls.browserleaks.com/json` 对同一 chrome123 请求报
`t13d1517h2_8daaf6152771_b1ff8ab2d16f`——第三段（GREASE/扩展计数口径）与
`tls.peet.ws` 的 `...1516h2_...` 差 1，但**第二段 `8daaf6152771` 完全一致**，
后者才是密码套件/ALPN 的判别段。跨端点比对时只看第二段与 Akamai 指纹。

## 覆盖与降级

查找顺序（`impersonate::binary_path`）：

1. 环境变量 `CURL_IMPERSONATE_PATH`（显式覆盖，便于调试/替换版本）
2. 宿主注入的搜索根：`user_external_deps/全局/curl-impersonate/` → `external-deps/全局/curl-impersonate/`
3. 开发态兜底：`<repo>/external-deps/全局/curl-impersonate/`
4. `PATH` 中的 `curl-impersonate(.exe)`

找不到二进制时不报错，自动降级回 rustls/reqwest 通道（仅日志告警），
前端 `features.tls_impersonate` 为 false 时把「TLS 指纹」如实显示为「UA 档案」。