#!/usr/bin/env node
/**
 * cfopt.js —— 用 Globalping 国内三网探针实测 CF 优选 IP
 *
 * 原理：
 *   1. 从 cmliu 的三网 CIDR 列表按运营商分别取样
 *   2. 每个 IP 用「该运营商自己的探针」做 TCP:443 ping
 *   3. 取平均延迟排序，输出 IP:端口#备注 格式
 *
 * 为什么不用 ICMP：Cloudflare 不回 ICMP，必须 TCP ping（等同 cfst 的 -httping 思路）
 * 为什么按运营商分开测：跨网测出来的延迟没有参考价值
 *
 * 用法：
 *   node cfopt.js                  # 每网取 10 个 IP，每 IP 3 个探针
 *   node cfopt.js --per-isp 20     # 每网取 20 个 IP
 *   node cfopt.js --top 8          # 每个运营商只保留最快 8 个
 *   node cfopt.js --isp ct         # 只测电信
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CACHE_DIR = path.join(__dirname, ".cache");

const API = "https://api.globalping.io/v1";
const CIDR_BASE = "https://raw.githubusercontent.com/cmliu/cmliu/main";

// 可选：设置 GLOBALPING_TOKEN 可把额度从 250 次/小时提升到 500 次/小时
const GP_TOKEN = process.env.GLOBALPING_TOKEN || "";
const GP_HEADERS = GP_TOKEN
  ? { "Content-Type": "application/json", Authorization: `Bearer ${GP_TOKEN}` }
  : { "Content-Type": "application/json" };

// 三网真实家宽/骨干 ASN（来自 Globalping 实测在线探针）
const ISP = {
  ct: {
    name: "电信",
    asns: [4134, 134762, 23724],
    cidr: "CF-CIDR/ct.txt",
    cidrFallback: "CF-CIDR.txt",
  },
  cu: {
    name: "联通",
    asns: [4837, 17621, 9929],
    cidr: "CF-CIDR/cu.txt",
    cidrFallback: "CF-CIDR.txt",
  },
  cmcc: {
    name: "移动",
    asns: [9808, 56040, 56041, 56046, 56045, 56048, 24445],
    cidr: "CF-CIDR/cmcc.txt",
    cidrFallback: "CF-CIDR.txt",
  },
};

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : def;
};
const PER_ISP = parseInt(arg("per-isp", "10"), 10);
const TOP = parseInt(arg("top", "0"), 10) || Infinity;
const ONLY = arg("isp", "");
const PORT = parseInt(arg("port", "443"), 10);
const PROBES = parseInt(arg("probes", "3"), 10);
const CONCURRENCY = parseInt(arg("concurrency", "5"), 10);
const OUT = arg("out", path.join(__dirname, "result.txt"));

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

function cidrToIps(cidr) {
  const [base, lenStr] = cidr.trim().split("/");
  const len = parseInt(lenStr, 10);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(base) || isNaN(len)) return [];
  const hostBits = 32 - len;
  if (hostBits < 2) return [];
  const baseInt = base
    .split(".")
    .reduce((a, p, i) => a + parseInt(p, 10) * Math.pow(256, 3 - i), 0);
  return { baseInt, hostBits, mask: len };
}

/** 在一个 CIDR 里随机取 n 个可用主机地址 */
function sampleFromCidr(cidr, n) {
  const info = cidrToIps(cidr);
  if (!info) return [];
  const { baseInt, hostBits } = info;
  const size = Math.pow(2, hostBits);
  const maskBase = baseInt; // 已经对齐
  const used = new Set();
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 50) {
    const off = 1 + Math.floor(Math.random() * (size - 2));
    if (used.has(off)) continue;
    used.add(off);
    const ipInt = maskBase + off;
    out.push(
      [(ipInt >>> 24) & 255, (ipInt >>> 16) & 255, (ipInt >>> 8) & 255, ipInt & 255].join(".")
    );
  }
  return out;
}

/**
 * 拉文本。优先 curl（读系统代理，GitHub raw 在国内必须走代理），
 * 失败再退回 node fetch（在无代理环境如 GitHub Actions 上直接可用）。
 * 成功结果缓存到 .cache/，网络全挂时可用旧缓存。
 */
async function fetchText(url, timeoutMs = 30000) {
  const cacheFile = path.join(CACHE_DIR, Buffer.from(url).toString("base64").replace(/[/+=]/g, "_").slice(-80) + ".txt");

  // 1) curl
  try {
    const out = execFileSync(
      "curl",
      ["-sL", "--max-time", String(Math.ceil(timeoutMs / 1000)), url],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs + 5000 }
    );
    if (out && out.trim()) {
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, out, "utf8");
      } catch {}
      return out;
    }
  } catch (e) {
    log(`  curl 抓取失败(${e.code || e.message})，尝试 node fetch`);
  }

  // 2) node fetch
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const txt = await r.text();
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, txt, "utf8");
      } catch {}
      return txt;
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    // 3) 缓存兜底
    if (fs.existsSync(cacheFile)) {
      log(`  网络不可用，使用本地缓存`);
      return fs.readFileSync(cacheFile, "utf8");
    }
    throw new Error(`抓取失败: ${url} (${e.message})`);
  }
}

async function createMeasurement(target, asns) {
  const body = {
    type: "ping",
    target,
    locations: asns.map((asn) => ({ asn })),
    limit: PROBES,
    measurementOptions: { protocol: "TCP", port: PORT, packets: 3 },
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 40000);
  try {
    const r = await fetch(`${API}/measurements`, {
      method: "POST",
      headers: GP_HEADERS,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || "create failed");
    return j.id;
  } finally {
    clearTimeout(t);
  }
}

async function waitMeasurement(id, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2500);
    const r = await fetch(`${API}/measurements/${id}`, { headers: GP_HEADERS });
    if (!r.ok) continue;
    const j = await r.json();
    if (j.status === "finished") return j;
  }
  return null;
}

/** 汇总一次测量的结果，返回 {avg, loss, ok, probes} */
function summarize(m) {
  const rs = (m.results || []).filter((x) => x.result && x.result.status === "finished");
  if (!rs.length) return { ok: false, avg: null, loss: 100, probes: 0 };
  const avgs = [];
  let lossSum = 0;
  for (const x of rs) {
    const st = x.result.stats || {};
    if (typeof st.avg === "number") avgs.push(st.avg);
    lossSum += typeof st.loss === "number" ? st.loss : (st.rcv < st.rcvd ? 100 : 0);
  }
  if (!avgs.length) return { ok: false, avg: null, loss: 100, probes: rs.length };
  avgs.sort((a, b) => a - b);
  const median = avgs[Math.floor(avgs.length / 2)];
  return {
    ok: true,
    avg: Math.round(median * 10) / 10,
    best: Math.round(avgs[0] * 10) / 10,
    loss: Math.round((lossSum / rs.length) * 10) / 10,
    probes: rs.length,
  };
}

/** 简单并发池 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------- 主流程 ----------
async function run() {
  const isps = ONLY ? [ONLY] : Object.keys(ISP);
  const allOut = [];
  const report = [];

  for (const key of isps) {
    const cfg = ISP[key];
    if (!cfg) {
      log(`跳过未知运营商: ${key}`);
      continue;
    }
    log(`\n=== ${cfg.name} (${key}) ===`);

    // 1. 拉 CIDR
    let cidrs = [];
    try {
      cidrs = (await fetchText(`${CIDR_BASE}/${cfg.cidr}`))
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s));
    } catch (e) {
      log(`  拉取 ${cfg.cidr} 失败: ${e.message}，改用全量段`);
    }
    if (!cidrs.length) {
      cidrs = (await fetchText(`${CIDR_BASE}/${cfg.cidrFallback}`))
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s));
    }
    log(`  CIDR 段: ${cidrs.length} 条`);

    // 2. 均匀取样（每个段都覆盖到，避免集中在小段）
    const perCidr = Math.max(1, Math.ceil(PER_ISP / cidrs.length));
    const ips = [];
    for (const c of cidrs) {
      for (const ip of sampleFromCidr(c, perCidr)) {
        if (!ips.includes(ip)) ips.push(ip);
      }
      if (ips.length >= PER_ISP * 2) break;
    }
    const picked = ips.slice(0, PER_ISP);
    log(`  候选 IP: ${picked.length} 个`);

    // 3. 并发测量
    let done = 0;
    const res = await pool(picked, CONCURRENCY, async (ip) => {
      const id = await createMeasurement(ip, cfg.asns);
      const m = await waitMeasurement(id);
      done++;
      process.stderr.write(`\r  测速进度 ${done}/${picked.length}  ${ip}      `);
      if (!m) return { ip, ok: false, avg: null, loss: 100, probes: 0 };
      return { ip, ...summarize(m) };
    });
    process.stderr.write("\n");

    const ok = res
      .filter((r) => r && r.ok && r.avg !== null && r.loss < 100)
      .sort((a, b) => a.avg - b.avg);

    log(`  有效结果: ${ok.length}/${picked.length}`);
    if (!ok.length) {
      log(`  ⚠ ${cfg.name} 全部失败，可能探针不可达或额度耗尽`);
      continue;
    }

    const top = ok.slice(0, TOP === Infinity ? ok.length : TOP);
    for (const r of top) {
      const line = `${r.ip}:${PORT}#${cfg.name}-${r.avg}ms`;
      allOut.push(line);
      report.push({ isp: cfg.name, ...r });
    }
    for (const r of top) {
      log(`    ${r.ip}:${PORT}  ${String(r.avg).padStart(7)}ms  丢包 ${r.loss}%  探针 ${r.probes}`);
    }
  }

  // 4. 输出
  if (!allOut.length) {
    log("\n没有产出任何可用 IP，不覆盖原结果文件。");
    process.exitCode = 2;
    return;
  }
  fs.writeFileSync(OUT, allOut.join("\n") + "\n", "utf8");
  log(`\n已写入 ${OUT}  (${allOut.length} 条)`);

  // 5. 顺便存一份 CSV 备查
  const csvPath = OUT.replace(/\.txt$/, "") + ".csv";
  const csv = ["运营商,IP,平均延迟ms,最快ms,丢包率%,探针数"]
    .concat(
      report.map(
        (r) => `${r.isp},${r.ip},${r.avg},${r.best ?? ""},${r.loss},${r.probes}`
      )
    )
    .join("\n");
  fs.writeFileSync(csvPath, csv + "\n", "utf8");
  log(`已写入 ${csvPath}`);

  // 6. 直接打印到 stdout，便于管道
  console.log(allOut.join("\n"));
}

run().catch((e) => {
  log("致命错误: " + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
