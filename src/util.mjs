import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ 基础工具 */

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 四舍五入到 n 位小数，避免 digest 里出现 0.30000000000000004 */
export function round(value, digits = 3) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function uniq(list) {
  return [...new Set(list)];
}

export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function nowISO() {
  return new Date().toISOString();
}

/**
 * 返回本地时区下的 YYYY-MM-DD。
 * 不用 toISOString()，因为它会转成 UTC，东八区的晚上会算成前一天。
 */
export function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isValidDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * 当前 UTC 日期。GitHub 的 created: 限定符按 UTC 日历日计算，
 * 所以「扫描哪一天」这件事统一用 UTC，避免东八区晚上跑到前一天去。
 */
export function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** 在 YYYY-MM-DD 上加减天数 */
export function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 把各种时间表示统一成 ISO 字符串，失败返回 null */
export function toISO(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/* ------------------------------------------------------------------ 小工具 */

/**
 * 解析 .env 文件。只支持 KEY=VALUE、# 注释、可选引号，够用且不引入依赖。
 * 不覆盖已经存在的真实环境变量——CI 里传的变量优先级更高。
 */
export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    parsed[key] = value;
  }
  return parsed;
}

/**
 * 把 .env 加载进 process.env，但只在变量尚未定义时写入。
 */
export function applyEnvFile(filePath) {
  const parsed = loadEnvFile(filePath);
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/* ------------------------------------------------------------------ 日志 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code, text) {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const color = {
  dim: (t) => paint('2', t),
  bold: (t) => paint('1', t),
  green: (t) => paint('32', t),
  yellow: (t) => paint('33', t),
  red: (t) => paint('31', t),
  cyan: (t) => paint('36', t),
};

let quiet = false;

export function setQuiet(value) {
  quiet = Boolean(value);
}

export function isQuiet() {
  return quiet;
}

export const log = {
  info(...args) {
    if (!quiet) console.log(...args);
  },
  step(label, detail) {
    if (quiet) return;
    console.log(`${color.cyan('▸')} ${label}${detail ? ` ${color.dim(detail)}` : ''}`);
  },
  warn(...args) {
    console.warn(`${color.yellow('!')}`, ...args);
  },
  error(...args) {
    console.error(`${color.red('✗')}`, ...args);
  },
  ok(...args) {
    if (!quiet) console.log(`${color.green('✓')}`, ...args);
  },
};

/* ------------------------------------------------------------------ 路径 */

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveFrom(cwd, maybeRelative) {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(cwd, maybeRelative);
}

/** 写文件，自动建目录，保证末尾有换行 */
export function writeTextFile(filePath, text) {
  ensureDir(path.dirname(filePath));
  const normalized = text.endsWith('\n') ? text : `${text}\n`;
  fs.writeFileSync(filePath, normalized, 'utf8');
  return filePath;
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJsonFile(filePath, value) {
  return writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/* ------------------------------------------------------------------ 文本处理 */

/** 把任意文本压成适合做关键词匹配的小写单空格字符串 */
export function normalizeText(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 包含式关键词匹配。
 * 对短关键词（<=3 字符）要求词边界，避免 "rag" 命中 "storage"、"go" 命中 "google"。
 */
export function includesKeyword(haystack, keyword) {
  const needle = normalizeText(keyword);
  if (!needle) return false;
  if (needle.length > 3) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

/** 中英文都能截断的字符计数展示 */
export function formatCount(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatDelta(n) {
  if (n > 0) return `+${n}`;
  return String(n);
}

/** 简易串行队列，保证对同一 API 的请求不并发、且间隔可控 */
export function createSerialQueue({ minIntervalMs = 0 } = {}) {
  let chain = Promise.resolve();
  let lastStart = 0;

  return function enqueue(task) {
    const run = async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      return task();
    };
    // 关键：把结果和错误都串到同一条链上，保证前一个任务失败不影响后续排队
    const result = chain.then(run, run);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
