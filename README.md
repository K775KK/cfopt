# cfopt — 用 Globalping 国内三网探针实测 Cloudflare 优选 IP

替代 edgetunnel 的「随机优选」：不再在 CIDR 段里随机抽 IP，而是**用中国大陆
电信/联通/移动的真实探针实测 TCP 连接延迟**，按运营商排序，只保留最快的那些。

## 为什么需要它

edgetunnel 的「随机优选」实现是这样的（`_worker.js` 第 5878 行 `生成随机IP`）：

```js
const randomOffset = Math.floor(Math.random() * Math.pow(2, hostBits));
const randomIP = (ipInt & mask) + randomOffset;
```

纯 `Math.random()`，**零测速**。而 Cloudflare 只把 CIDR 段里的一部分地址在
Anycast 上通告，随机抽到的地址大量是"TCP 不通"或"能连但极慢"的，这就是
"节点很多但一半是死的"的原因。

## 为什么不能直接写个 Worker 来测

Cloudflare 禁止 Worker `connect()` 到自家 IP 段（官方 Error 1003
`Direct IP Access Not Allowed`）。所以测速数据必须在 Cloudflare 之外产生。

Globalping 是 jsDelivr 维护的众包探针网络，中国大陆有约 47 个在线探针，
覆盖三网，正好补上这块。

## 为什么不需要关代理

测速发生在 Globalping 的云端探针上，与你本地网络无关。开着 Clash / TUN
也能正常跑，这是它相对本地跑 CloudflareSpeedTest 的最大优势。

## 用法

```bash
node cfopt.js                                  # 默认：每网 10 个 IP，3 个探针
node cfopt.js --per-isp 12 --top 8             # 每网测 12 个，保留最快 8 个
node cfopt.js --isp ct                         # 只测电信
node cfopt.js --port 8443                      # 换端口（默认 443）
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--per-isp` | 10 | 每个运营商取样测试多少个 IP |
| `--top` | 不限 | 每个运营商保留前几名 |
| `--isp` | 全部 | `ct` / `cu` / `cmcc` |
| `--port` | 443 | 优选端口 |
| `--probes` | 3 | 每次测量用几个探针 |
| `--concurrency` | 5 | 并发测量数，太高会触发限流 |
| `--out` | `result.txt` | 输出文件 |

输出格式即 edgetunnel 的「优选API」格式，每行一条：

```
104.18.39.3:443#电信-50.2ms
104.17.114.106:443#移动-71.3ms
```

## 额度

Globalping 免费额度 250 次测量/小时（按 IP 计）。一次默认运行约消耗
3 网 × 12 IP × 3 探针 = 108 次，6 小时跑一次完全够用。

设置环境变量 `GLOBALPING_TOKEN`（在 https://dash.globalping.io/ 生成）
可提升到 500 次/小时。

## 部署到 GitHub

1. 新建仓库（https://github.com/new），**必须选 Public**。
   private 仓库的 raw 地址需要带 token 才能访问，Cloudflare Worker 拿不到，接入会直接失败。
2. 用 "Upload files" 把 `cfopt.js`、`README.md`、`result.txt`、`result.csv` 传上去。
3. 单独创建 workflow：Add file → Create new file，文件名直接输入
   `.github/workflows/cfopt.yml`（GitHub 会自动建目录），粘贴本仓库里那个文件的内容。
4. 进 Actions 标签页启用，然后手动 Run workflow 跑一次验证。

## 接入 edgetunnel

1. 首次运行后，仓库里会出现 `result.txt`
2. 拿到它的 raw 地址：
   ```
   https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/result.txt
   ```
   （Cloudflare Worker 访问 raw.githubusercontent.com 没有障碍；若填在浏览器
   里打不开是正常的，那是你本地被污染，不影响 Worker 拉取。
   确认仓库是 **Public**，否则这个地址会 404）
3. edgetunnel 后台 →「优选订阅生成」→「自定义优选」→「订阅接口」
   填入上面的地址 → 点「可用性验证」确认能返回 IP 列表
4. **⚠️ 把「随机IP」开关关掉**，否则它会优先走随机逻辑，完全不读这个接口
5. 更新订阅

## 局限

- Globalping 只能测 **TCP 延迟和丢包**，测不了下载带宽。延迟低通常意味着
  路由好、体验顺，但不等于带宽一定高（Cloudflare 对部分国内线路有 QoS）。
- 探针是众包的，数量和位置会变化，结果有波动。
- 中国大陆探针以家宽（`eyeball-network`）为主，这正好是最贴近你的视角，
  但省份覆盖不均，同一运营商不同省份差异可能很大。
