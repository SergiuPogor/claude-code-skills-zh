#!/usr/bin/env node
/**
 * audit_readme_entries.mjs — 只读体检：采集 README 精选条目的 GitHub 元数据
 *
 * 用于判断哪些条目长期无人维护、低星、疑似失效。只读取，不修改任何文件。
 *
 * 用法：
 *   node scripts/audit_readme_entries.mjs [--out audit.json]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = join(REPO_ROOT, "README.md");
const CACHE_PATH = join(REPO_ROOT, ".audit-cache.json");
const CATEGORY_ORDER = ["star", "platform", "dev", "creative", "agent", "finance", "chinese"];

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const OUT_PATH = outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : null;

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

/** 解析 README，返回 [{category, name, url, repo, lineNumber}] */
function parseEntries(readme) {
  const entries = [];
  let current = null;
  for (const [i, raw] of readme.split("\n").entries()) {
    const line = raw.trim();
    const key = classifyHeader(line);
    if (key !== null) {
      current = key === "academic" ? "dev" : key;
      continue;
    }
    if (line.startsWith("## ") || (line.startsWith("### ") && current !== null)) {
      current = null;
      continue;
    }
    if (current === null || !line.startsWith("|")) continue;
    const first = line.split("|")[1]?.trim() ?? "";
    if (["技能", "说明", "---", "为什么"].some((k) => first.includes(k))) continue;
    const m = first.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (!m) continue;
    const repoMatch = m[2].match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/i);
    if (!repoMatch) continue;
    const repo = `${repoMatch[1]}/${repoMatch[2].replace(/\.git$/, "")}`;
    // 该行在分类表格中的起始行号（用于审计定位，1-based）
    entries.push({ category: current, name: m[1].trim(), url: m[2].trim(), repo, lineNumber: i + 1 });
  }
  return entries;
}

function dedupeByRepo(entries) {
  const seen = new Map();
  for (const e of entries) {
    const key = e.repo.toLowerCase();
    if (!seen.has(key)) seen.set(key, { ...e, categories: [e.category] });
    else seen.get(key).categories.push(e.category);
  }
  return [...seen.values()];
}

/** 一次 GraphQL 查询一批仓库（每批 50 个别名） */
function fetchBatch(repos) {
  const lines = ["query {"];
  repos.forEach((repo, i) => {
    const [owner, name] = repo.split("/");
    lines.push(
      `  r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {` +
        ` stargazerCount isArchived isFork pushedAt createdAt licenseInfo { key }` +
        ` primaryLanguage { name } description }`,
    );
  });
  lines.push("}");

  let out;
  try {
    out = execFileSync("gh", ["api", "graphql", "-f", `query=${lines.join("\n")}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // gh 在部分仓库 404 时会返回非零退出码，但 stdout 仍带完整 data。
    // 因此优先解析 stdout，只有完全无输出时才向上抛出。
    out = err.stdout;
    if (!out || !out.trim()) throw err;
  }
  const payload = JSON.parse(out);
  const result = new Map();
  const errors = payload.errors ?? [];
  for (const err of errors) {
    const path = (err.path ?? [])[0];
    if (typeof path === "string" && path.startsWith("r")) {
      const idx = Number(path.slice(1));
      if (Number.isInteger(idx)) result.set(repos[idx], { missing: true, reason: err.type ?? "ERROR" });
    }
  }
  const data = payload.data ?? {};
  repos.forEach((repo, i) => {
    const node = data[`r${i}`];
    if (node) result.set(repo, node);
    else if (!result.has(repo)) result.set(repo, { missing: true, reason: "NO_DATA" });
  });
  return result;
}

function main() {
  const readme = readFileSync(README_PATH, "utf8");
  const entries = dedupeByRepo(parseEntries(readme));
  console.log(`解析到 ${entries.length} 个唯一 GitHub 仓库`);

  // 增量缓存：中断后重跑只补齐缺失项，避免重复消耗 API 配额。
  let cache = {};
  if (existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      console.log(`  已加载缓存 ${Object.keys(cache).length} 条`);
    } catch {
      cache = {};
    }
  }

  const pending = entries.map((e) => e.repo).filter((repo) => !(repo in cache));
  console.log(`  待查询 ${pending.length} 个`);

  const BATCH = 25;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    process.stdout.write(`  查询 ${i + 1}-${i + batch.length}/${pending.length} … `);
    try {
      const got = fetchBatch(batch);
      for (const [repo, value] of got) cache[repo] = value;
      writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf8");
      console.log("ok");
    } catch (err) {
      console.log(`失败（${String(err.message).split("\n")[0].slice(0, 60)}），已保存进度`);
      writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf8");
      console.log(`  可重新运行本脚本续传（已完成 ${Object.keys(cache).length} 条）`);
      return;
    }
  }

  const rows = entries.map((e) => {
    const m = cache[e.repo] ?? { missing: true, reason: "UNKNOWN" };
    return {
      repo: e.repo,
      name: e.name,
      categories: e.categories,
      lineNumber: e.lineNumber,
      stars: m.missing ? null : m.stargazerCount,
      archived: m.missing ? null : m.isArchived,
      fork: m.missing ? null : m.isFork,
      pushedAt: m.missing ? null : m.pushedAt,
      createdAt: m.missing ? null : m.createdAt,
      license: m.missing ? null : (m.licenseInfo?.key ?? null),
      language: m.missing ? null : (m.primaryLanguage?.name ?? null),
      description: m.missing ? null : m.description,
      missing: Boolean(m.missing),
      missingReason: m.missing ? m.reason : null,
    };
  });

  const now = Date.now();
  const days = (iso) => (iso ? Math.floor((now - Date.parse(iso)) / 86400000) : null);
  rows.sort((a, b) => (a.stars ?? -1) - (b.stars ?? -1));

  const summary = {
    total: rows.length,
    missing: rows.filter((r) => r.missing).length,
    archived: rows.filter((r) => r.archived === true).length,
    forks: rows.filter((r) => r.fork === true).length,
    noLicense: rows.filter((r) => !r.missing && !r.license).length,
    zeroStar: rows.filter((r) => r.stars === 0).length,
    under5: rows.filter((r) => r.stars !== null && r.stars < 5).length,
    stale180: rows.filter((r) => r.pushedAt && days(r.pushedAt) > 180).length,
    stale365: rows.filter((r) => r.pushedAt && days(r.pushedAt) > 365).length,
  };

  console.log("\n=== 汇总 ===");
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);

  console.log("\n=== 失效/归档/fork ===");
  for (const r of rows.filter((x) => x.missing || x.archived || x.fork)) {
    console.log(`  [${r.missing ? "MISSING" : r.archived ? "ARCHIVED" : "FORK"}] ${r.repo} (${r.categories.join(",")}) ${r.missingReason ?? ""}`);
  }

  console.log("\n=== 0 星条目 ===");
  for (const r of rows.filter((x) => x.stars === 0)) {
    console.log(`  ${r.repo} (${r.categories.join(",")}) 创建 ${r.createdAt?.slice(0, 10)} 最后推送 ${r.pushedAt?.slice(0, 10)}`);
  }

  console.log("\n=== 1-4 星条目 ===");
  for (const r of rows.filter((x) => x.stars !== null && x.stars > 0 && x.stars < 5)) {
    console.log(`  ${r.stars}⭐ ${r.repo} (${r.categories.join(",")}) 最后推送 ${r.pushedAt?.slice(0, 10)}`);
  }

  console.log("\n=== 超过 180 天未推送（按星标升序）===");
  for (const r of rows.filter((x) => x.pushedAt && days(x.pushedAt) > 180).sort((a, b) => a.stars - b.stars)) {
    console.log(`  ${r.stars}⭐ ${r.repo} (${r.categories.join(",")}) 最后推送 ${r.pushedAt.slice(0, 10)} (${days(r.pushedAt)} 天前)`);
  }

  if (OUT_PATH) {
    writeFileSync(OUT_PATH, JSON.stringify({ summary, rows }, null, 2), "utf8");
    console.log(`\n已写出 ${OUT_PATH}`);
  }
}

main();
