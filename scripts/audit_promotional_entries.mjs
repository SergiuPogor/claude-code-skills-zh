#!/usr/bin/env node
/**
 * audit_promotional_entries.mjs — 只读体检：排查疑似纯引流 / 广告 / 低质条目
 *
 * 判据全部来自可核验信号，不做主观猜测。检测项：
 *   1. 无真实可复用资产：文件树里找不到 SKILL.md / skills / .claude-plugin /
 *      agents / commands / AGENTS.md / CLAUDE.md 等任一。
 *   2. 强导流：README 中同一非 GitHub 域名出现 ≥5 次，且仓库缺少可安装资产。
 *   3. 空壳 / 模板：仓库文件数极少，且无资产。
 *   4. 纯口号 README：正文过短（<400 字符）且无可安装路径。
 *   5. 星数异常：创建时间很短却星数极高（结合资产缺失判断）。
 *
 * 只读取，不修改任何文件。结果写入 .audit-promo.json，人工复核后再决定处置。
 *
 * 用法：
 *   node scripts/audit_promotional_entries.mjs [--limit N]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = join(REPO_ROOT, "README.md");
const META_CACHE = join(REPO_ROOT, ".audit-cache.json");
const PROMO_CACHE = join(REPO_ROOT, ".audit-promo.json");

const ASSET_PATTERNS = [
  /(^|\/)SKILL\.md$/i,
  /\.skill\.md$/i,
  /(^|\/)skills\//i,
  /\.claude-plugin\//i,
  /(^|\/)plugin\.json$/i,
  /(^|\/)marketplace\.json$/i,
  /(^|\/)agents?\//i,
  /(^|\/)commands?\//i,
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)\.mcp\.json$/i,
  // 合法的 Agent 生态项目：MCP Server、CLI、桌面应用等，同样属于可复用资产
  /(^|\/)mcp/i,
  /(^|\/)src\//i,
  /(^|\/)packages\//i,
];

const argv = process.argv.slice(2);
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : Infinity;

function classifyHeader(line) {
  const t = line.trim();
  if (!t.startsWith("### ")) return null;
  if (t.includes("🏆") && (t.includes("万星") || t.includes("热门与高潜"))) return "star";
  if (t.includes("平台运营") || t.includes("自媒体")) return "platform";
  if (t.includes("💻") && t.includes("开发效率")) return "dev";
  if (t.includes("🎨") && t.includes("内容创作")) return "creative";
  if (t.includes("🔬") && t.includes("学术科研")) return "academic";
  if (t.includes("🤖") && t.includes("Agent")) return "agent";
  if (t.includes("💰") && (t.includes("金融") || t.includes("商业"))) return "finance";
  if (t.includes("🌏") && t.includes("中文专属")) return "chinese";
  return null;
}

function parseEntries(readme) {
  const out = [];
  let cur = null;
  for (const [i, raw] of readme.split("\n").entries()) {
    const line = raw.trim();
    const key = classifyHeader(line);
    if (key !== null) {
      cur = key === "academic" ? "dev" : key;
      continue;
    }
    if (line.startsWith("## ") || (line.startsWith("### ") && cur !== null)) {
      cur = null;
      continue;
    }
    if (cur === null || !line.startsWith("|")) continue;
    const first = line.split("|")[1]?.trim() ?? "";
    if (["技能", "说明", "---", "为什么"].some((k) => first.includes(k))) continue;
    const m = first.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (!m) continue;
    const rm = m[2].match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/i);
    if (!rm) continue;
    out.push({
      category: cur,
      name: m[1].trim(),
      desc: (line.split("|")[2] ?? "").trim(),
      repo: `${rm[1]}/${rm[2].replace(/\.git$/, "")}`,
      lineNumber: i + 1,
    });
  }
  const seen = new Map();
  for (const e of out) {
    const k = e.repo.toLowerCase();
    if (!seen.has(k)) seen.set(k, e);
  }
  return [...seen.values()];
}

/** 一次 GraphQL 取文件树 + README 文本（限制文本长度以控制响应体） */
function fetchDetails(repos) {
  const lines = ["query {"];
  repos.forEach((repo, i) => {
    const [owner, name] = repo.split("/");
    lines.push(
      `  r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {` +
        ` stargazerCount createdAt pushedAt` +
        ` tree: object(expression: "HEAD:") { ... on Tree { entries { name type } } }` +
        ` readme: object(expression: "HEAD:README.md") { ... on Blob { text } } }`,
    );
  });
  lines.push("}");

  let out;
  try {
    out = execFileSync("gh", ["api", "graphql", "-f", `query=${lines.join("\n")}`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    out = err.stdout;
    if (!out || !out.trim()) throw err;
  }
  const payload = JSON.parse(out);
  const missing = new Map();
  for (const err of payload.errors ?? []) {
    const p = (err.path ?? [])[0];
    if (typeof p === "string" && p.startsWith("r")) {
      const idx = Number(p.slice(1));
      if (Number.isInteger(idx)) missing.set(repos[idx], err.type ?? "ERROR");
    }
  }
  const data = payload.data ?? {};
  const result = new Map();
  repos.forEach((repo, i) => {
    const node = data[`r${i}`];
    if (node) result.set(repo, node);
    else result.set(repo, { missing: true, reason: missing.get(repo) ?? "NO_DATA" });
  });
  return result;
}

function analyze(entry, detail, meta) {
  const flags = [];
  const notes = [];

  if (!detail || detail.missing) {
    return { ...entry, flags: ["MISSING"], notes: ["仓库不可访问"] };
  }

  const files = (detail.tree?.entries ?? []).map((e) => (e.type === "tree" ? `${e.name}/` : e.name));
  // 兼容 readme.md / README_zh.md 等大小写与变体命名：根目录存在任一 readme 变体，
  // 就不能因为 README.md 为空而判定「无文档」。
  const hasReadmeVariant = files.some((f) => /^readme/i.test(f));
  const readme = detail.readme?.text ?? "";

  const hasAsset = ASSET_PATTERNS.some((p) => files.some((f) => p.test(f)));
  if (!hasAsset) {
    // 再检查 README 里是否给出可安装路径（有时资产在子目录且未出现在根树）
    const installHint = /npx\s+skills\s+add|claude\s+plugin\s+marketplace\s+add|\/plugin\s+marketplace\s+add|npm\s+i(nstall)?\s+-g|pip\s+install|brew\s+install|git\s+clone/.test(readme);
    if (installHint) notes.push("根树无资产，但 README 有安装命令");
    else flags.push("NO_ASSET");
  }

  // 导流检测
  const domains = new Map();
  for (const m of readme.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const d = m[1].toLowerCase();
    if (d.endsWith("github.com") || d.endsWith("githubusercontent.com")) continue;
    if (d === "img.shields.io" || d.endsWith("shields.io")) continue;
    domains.set(d, (domains.get(d) ?? 0) + 1);
  }
  const topDomain = [...domains.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topDomain && topDomain[1] >= 5) {
    flags.push(`PROMO_DOMAIN(${topDomain[0]}×${topDomain[1]})`);
  }

  // 空壳仓库
  if (files.length <= 4 && !hasAsset) flags.push(`SPARSE(${files.length} files)`);

  // 纯口号 README：README.md 为空、也没有任何 readme 变体时才算
  if (!hasReadmeVariant) flags.push("NO_README");

  // 星数异常：创建 < 90 天且星数 > 5000
  const ageDays = detail.createdAt ? Math.floor((Date.now() - Date.parse(detail.createdAt)) / 86400000) : null;
  if (ageDays !== null && ageDays < 90 && detail.stargazerCount > 5000 && !hasAsset) {
    flags.push(`SUSPICIOUS_STARS(${detail.stargazerCount}/${ageDays}d)`);
  }

  // 描述与 README 都缺可安装信息
  if (!/npx\s+skills|plugin|skill|install|安装|pip|npm|clone/i.test(readme) && !hasAsset && readme.length > 0) {
    flags.push("NO_INSTALL_HINT");
  }

  return {
    ...entry,
    stars: meta?.stars ?? null,
    createdAt: detail.createdAt,
    pushedAt: detail.pushedAt,
    fileCount: files.length,
    readmeLength: readme.length,
    hasAsset,
    topDomain: topDomain ? `${topDomain[0]}×${topDomain[1]}` : null,
    files: files.slice(0, 12),
    flags,
    notes,
  };
}

function main() {
  const readme = readFileSync(README_PATH, "utf8");
  const entries = parseEntries(readme);
  const meta = new Map();
  if (existsSync(META_CACHE)) {
    const cache = JSON.parse(readFileSync(META_CACHE, "utf8"));
    for (const [repo, v] of Object.entries(cache)) meta.set(repo, v);
  }

  const cache = existsSync(PROMO_CACHE) ? JSON.parse(readFileSync(PROMO_CACHE, "utf8")) : {};
  const pending = entries.map((e) => e.repo).filter((r) => !(r in cache)).slice(0, LIMIT);
  console.log(`条目 ${entries.length} 个，待抓取详情 ${pending.length} 个`);

  const BATCH = 15;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    process.stdout.write(`  ${i + 1}-${i + batch.length}/${pending.length} … `);
    try {
      const got = fetchDetails(batch);
      for (const [repo, v] of got) {
        cache[repo] = {
          missing: Boolean(v.missing),
          reason: v.reason ?? null,
          stargazerCount: v.stargazerCount ?? null,
          createdAt: v.createdAt ?? null,
          pushedAt: v.pushedAt ?? null,
          tree: v.tree ?? null,
          readmeText: (v.readme?.text ?? "").slice(0, 60000),
        };
      }
      writeFileSync(PROMO_CACHE, JSON.stringify(cache), "utf8");
      console.log("ok");
    } catch (err) {
      console.log(`失败：${String(err.message).split("\n")[0].slice(0, 70)}`);
      writeFileSync(PROMO_CACHE, JSON.stringify(cache), "utf8");
      console.log(`  已保存 ${Object.keys(cache).length} 条，可重跑续传`);
      return;
    }
  }

  const results = entries.map((e) => {
    const c = cache[e.repo];
    const detail = c
      ? {
          missing: c.missing,
          reason: c.reason,
          stargazerCount: c.stargazerCount,
          createdAt: c.createdAt,
          pushedAt: c.pushedAt,
          tree: c.tree,
          readme: { text: c.readmeText },
        }
      : null;
    return analyze(e, detail, meta.get(e.repo));
  });

  const flagged = results.filter((r) => r.flags.length > 0);
  console.log(`\n=== 命中可疑信号的条目 ${flagged.length} / ${results.length} ===`);
  const order = ["MISSING", "NO_ASSET", "SUSPICIOUS_STARS", "PROMO_DOMAIN", "SPARSE", "TINY_README", "NO_INSTALL_HINT"];
  flagged.sort((a, b) => {
    const ra = order.findIndex((o) => a.flags.some((f) => f.startsWith(o)));
    const rb = order.findIndex((o) => b.flags.some((f) => f.startsWith(o)));
    return ra - rb;
  });
  for (const r of flagged) {
    console.log(`\n[${r.flags.join(" | ")}] ${r.repo}`);
    console.log(`  ${r.category} | ${r.stars}⭐ | 文件 ${r.fileCount} | README ${r.readmeLength} 字符 | L${r.lineNumber}`);
    console.log(`  描述: ${r.desc.slice(0, 110)}`);
    if (r.files?.length) console.log(`  根文件: ${r.files.join(", ")}`);
    if (r.topDomain) console.log(`  主外链域名: ${r.topDomain}`);
    if (r.notes?.length) console.log(`  说明: ${r.notes.join("; ")}`);
  }

  const summary = {};
  for (const r of results) for (const f of r.flags) summary[f.replace(/\(.*/, "")] = (summary[f.replace(/\(.*/, "")] ?? 0) + 1;
  console.log("\n=== 信号统计 ===");
  for (const [k, v] of Object.entries(summary).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
}

main();
