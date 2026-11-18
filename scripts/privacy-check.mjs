// 发布前检查：渲染器仓库里不该出现个人路径、账号、密钥。
// 与技能包那份的区别：这里允许出现 ComfyUI 和 127.0.0.1:8188 —— 那是本仓库描述的对象，不是个人信息。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? ".";
const SKIP = new Set([".git", "node_modules", "out", "build"]);

const RULES = [
  { name: "personal-windows-path", re: /[A-Za-z]:[\\/](Users|ai|data|tools)[\\/]/ },
  { name: "personal-posix-home", re: /\/(Users|home)\/[A-Za-z0-9._-]+\// },
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "api-key", re: /\b(sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-)/ },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "non-loopback-ip", re: /\b(?!127\.0\.0\.1)(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { name: "demo-account", re: /@workstream\.dev/i },
];

const hits = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) { walk(full); continue; }
    if (!/\.(md|json|mjs)$/i.test(entry)) continue;
    readFileSync(full, "utf8").split(/\r?\n/).forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) hits.push({ file: full, line: index + 1, rule: rule.name, text: line.trim().slice(0, 100) });
      }
    });
  }
}

walk(ROOT);
if (!hits.length) {
  console.log(`privacy check: clean (${RULES.length} rules)`);
  process.exit(0);
}
console.log(`privacy check: ${hits.length} hit(s)`);
for (const hit of hits) console.log(`  ${hit.file}:${hit.line} [${hit.rule}] ${hit.text}`);
process.exit(1);
