import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { clamp, ensureDir, nowISO } from './util.mjs';

/**
 * SQLite 存储层。
 *
 * 三张表是这个项目的核心资产：
 *   repos      —— 见过哪些项目
 *   snapshots  —— 每个项目每次被观测到的 star 数（GitHub 不提供 star 历史 API，这份数据只能自己攒）
 *   weights    —— 你的反馈沉淀成的兴趣权重
 *
 * 注意：node:sqlite 只接受 null / number / bigint / string / Uint8Array，
 * 传 boolean 或 undefined 会直接抛错，所以统一走 toParam()。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  full_name       TEXT PRIMARY KEY,
  owner           TEXT,
  name            TEXT,
  url             TEXT,
  description     TEXT,
  homepage        TEXT,
  language        TEXT,
  topics_json     TEXT NOT NULL DEFAULT '[]',
  stars           INTEGER NOT NULL DEFAULT 0,
  forks           INTEGER NOT NULL DEFAULT 0,
  open_issues     INTEGER NOT NULL DEFAULT 0,
  size_kb         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT,
  pushed_at       TEXT,
  license         TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  is_fork         INTEGER NOT NULL DEFAULT 0,
  has_readme      INTEGER NOT NULL DEFAULT 0,
  readme_chars    INTEGER NOT NULL DEFAULT 0,
  readme_text     TEXT,
  node_id         TEXT,
  first_seen_stars INTEGER NOT NULL DEFAULT 0,
  first_seen_date TEXT,
  last_seen_date  TEXT,
  extra_json      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_repos_first_seen ON repos(first_seen_date);

CREATE TABLE IF NOT EXISTS snapshots (
  full_name    TEXT NOT NULL,
  taken_on     TEXT NOT NULL,
  stars        INTEGER NOT NULL DEFAULT 0,
  forks        INTEGER NOT NULL DEFAULT 0,
  open_issues  INTEGER NOT NULL DEFAULT 0,
  captured_at  TEXT NOT NULL,
  PRIMARY KEY (full_name, taken_on)
);

CREATE TABLE IF NOT EXISTS scores (
  full_name      TEXT NOT NULL,
  run_date       TEXT NOT NULL,
  heuristic      REAL NOT NULL DEFAULT 0,
  heuristic_json TEXT NOT NULL DEFAULT '{}',
  llm_score      REAL,
  llm_json       TEXT,
  final_score    REAL NOT NULL DEFAULT 0,
  model          TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (full_name, run_date)
);

CREATE TABLE IF NOT EXISTS runs (
  run_date      TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  source        TEXT NOT NULL,
  candidates    INTEGER NOT NULL DEFAULT 0,
  after_filter  INTEGER NOT NULL DEFAULT 0,
  scored        INTEGER NOT NULL DEFAULT 0,
  shown         INTEGER NOT NULL DEFAULT 0,
  digest_path   TEXT,
  stats_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name  TEXT NOT NULL,
  action     TEXT NOT NULL,
  note       TEXT,
  tags_json  TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_full_name ON feedback(full_name);

CREATE TABLE IF NOT EXISTS weights (
  key        TEXT PRIMARY KEY,
  value      REAL NOT NULL DEFAULT 0,
  hits       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

function toParam(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * 轻量迁移：给已存在的数据库补上后加的列。
 * 这个项目还在早期，schema 会变；与其让用户删库，不如自己补列。
 */
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

export function openStore({ dataDir = 'data', file = 'metascan.db' } = {}) {
  ensureDir(dataDir);
  const dbPath = path.join(dataDir, file);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // v0.1 早期版本没有这一列，它记录「第一次见到这个项目时有多少 star」
  ensureColumn(db, 'repos', 'first_seen_stars', "INTEGER NOT NULL DEFAULT 0");

  const stmt = (sql) => db.prepare(sql);
  const cached = new Map();
  const run = (sql, ...params) => {
    let prepared = cached.get(sql);
    if (!prepared) {
      prepared = stmt(sql);
      cached.set(sql, prepared);
    }
    return prepared.run(...params.map(toParam));
  };
  const all = (sql, ...params) => {
    let prepared = cached.get(sql);
    if (!prepared) {
      prepared = stmt(sql);
      cached.set(sql, prepared);
    }
    return prepared.all(...params.map(toParam));
  };
  const get = (sql, ...params) => {
    let prepared = cached.get(sql);
    if (!prepared) {
      prepared = stmt(sql);
      cached.set(sql, prepared);
    }
    return prepared.get(...params.map(toParam));
  };

  return {
    path: dbPath,
    raw: db,

    /* ------------------------------------------------------------ repos */

    upsertRepo(repo, { runDate } = {}) {
      const existing = get('SELECT first_seen_date FROM repos WHERE full_name = ?', repo.fullName);
      const firstSeen = existing?.first_seen_date ?? runDate ?? null;
      run(
        `INSERT INTO repos (
           full_name, owner, name, url, description, homepage, language, topics_json,
           stars, forks, open_issues, size_kb, created_at, pushed_at, license,
           archived, is_fork, has_readme, readme_chars, readme_text, node_id,
           first_seen_stars, first_seen_date, last_seen_date, extra_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(full_name) DO UPDATE SET
           owner = excluded.owner,
           name = excluded.name,
           url = excluded.url,
           description = excluded.description,
           homepage = excluded.homepage,
           language = excluded.language,
           topics_json = excluded.topics_json,
           stars = excluded.stars,
           forks = excluded.forks,
           open_issues = excluded.open_issues,
           size_kb = excluded.size_kb,
           created_at = excluded.created_at,
           pushed_at = excluded.pushed_at,
           license = excluded.license,
           archived = excluded.archived,
           is_fork = excluded.is_fork,
           has_readme = excluded.has_readme,
           readme_chars = excluded.readme_chars,
           readme_text = COALESCE(excluded.readme_text, repos.readme_text),
           node_id = COALESCE(excluded.node_id, repos.node_id),
           last_seen_date = excluded.last_seen_date,
           extra_json = excluded.extra_json`,
        repo.fullName,
        repo.owner ?? null,
        repo.name ?? null,
        repo.url ?? null,
        repo.description ?? null,
        repo.homepage ?? null,
        repo.language ?? null,
        JSON.stringify(repo.topics ?? []),
        Math.round(repo.stars ?? 0),
        Math.round(repo.forks ?? 0),
        Math.round(repo.openIssues ?? 0),
        Math.round(repo.sizeKb ?? 0),
        repo.createdAt ?? null,
        repo.pushedAt ?? null,
        repo.license ?? null,
        repo.archived ? 1 : 0,
        repo.isFork ? 1 : 0,
        repo.hasReadme ? 1 : 0,
        Math.round(repo.readmeChars ?? 0),
        repo.readmeText ?? null,
        repo.nodeId ?? null,
        // 基线只写一次：ON CONFLICT 的 UPDATE 子句里刻意不包含它
        Math.round(repo.stars ?? 0),
        firstSeen,
        runDate ?? null,
        JSON.stringify(repo.extra ?? {}),
      );
    },

    getRepo(fullName) {
      const row = get('SELECT * FROM repos WHERE full_name = ?', fullName);
      return row ? rowToRepo(row) : null;
    },

    listRepos({ limit = 200, sinceDate = null } = {}) {
      const rows = sinceDate
        ? all('SELECT * FROM repos WHERE first_seen_date >= ? ORDER BY first_seen_date DESC, stars DESC LIMIT ?', sinceDate, limit)
        : all('SELECT * FROM repos ORDER BY first_seen_date DESC, stars DESC LIMIT ?', limit);
      return rows.map(rowToRepo);
    },

    countRepos() {
      return get('SELECT COUNT(*) AS n FROM repos').n;
    },

    /**
     * 作者先验：这个 owner 历史上被我们收录过多少个项目、最好成绩如何。
     * 冷启动阶段为空，评分会退化成中性值。
     */
    getAuthorStats() {
      const rows = all(`
        SELECT r.owner AS owner,
               COUNT(*) AS repo_count,
               COALESCE(MAX(s.heuristic), 0) AS best_score
        FROM repos r
        LEFT JOIN scores s ON s.full_name = r.full_name
        WHERE r.owner IS NOT NULL
        GROUP BY r.owner
      `);
      const map = new Map();
      for (const row of rows) {
        map.set(row.owner, { repoCount: row.repo_count, bestScore: row.best_score ?? 0 });
      }
      return map;
    },

    /* -------------------------------------------------------- snapshots */

    /** 记录一次 star 观测。同一天重复观测时以最后一次为准。 */
    snapshotRepo(fullName, { stars, forks = 0, openIssues = 0, takenOn, capturedAt = nowISO(), overwrite = true }) {
      run(
        `INSERT INTO snapshots (full_name, taken_on, stars, forks, open_issues, captured_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(full_name, taken_on) DO ${overwrite ? 'UPDATE' : 'NOTHING'}${overwrite ? ` SET
           stars = excluded.stars,
           forks = excluded.forks,
           open_issues = excluded.open_issues,
           captured_at = excluded.captured_at` : ''}`,
        fullName,
        takenOn,
        Math.round(stars ?? 0),
        Math.round(forks),
        Math.round(openIssues),
        capturedAt,
      );
    },

    /**
     * 返回某个项目从「第一次见到它」到「最新一次观测」的 star 走势。
     *
     * 基线取自 repos.first_seen_stars 而不是 snapshots 的第一行：
     * snapshots 按 (仓库, 日期) 唯一，同一天多次运行只会留下一条，
     * 而基线必须永远是首次发现那一刻的值，否则 delta 会被自己的后续运行抹平。
     */
    getStarTrend(fullName) {
      const repo = get(
        'SELECT first_seen_date, first_seen_stars, stars FROM repos WHERE full_name = ?',
        fullName,
      );
      if (!repo) return null;

      const latest = get(
        'SELECT taken_on, stars FROM snapshots WHERE full_name = ? ORDER BY taken_on DESC, captured_at DESC LIMIT 1',
        fullName,
      );
      const count = get('SELECT COUNT(*) AS n FROM snapshots WHERE full_name = ?', fullName).n;
      if (!latest) return null;

      const baseline = repo.first_seen_stars || repo.stars || 0;
      return {
        firstStars: baseline,
        latestStars: latest.stars,
        delta: latest.stars - baseline,
        firstOn: repo.first_seen_date,
        latestOn: latest.taken_on,
        observationDays: count,
      };
    },

    /* ----------------------------------------------------------- scores */

    saveScore({
      fullName,
      runDate,
      heuristic = 0,
      heuristicDetail = {},
      llmScore = null,
      llmDetail = null,
      finalScore = 0,
      model = null,
    }) {
      run(
        `INSERT INTO scores (full_name, run_date, heuristic, heuristic_json, llm_score, llm_json, final_score, model, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(full_name, run_date) DO UPDATE SET
           heuristic = excluded.heuristic,
           heuristic_json = excluded.heuristic_json,
           llm_score = excluded.llm_score,
           llm_json = excluded.llm_json,
           final_score = excluded.final_score,
           model = excluded.model`,
        fullName,
        runDate,
        heuristic,
        JSON.stringify(heuristicDetail ?? {}),
        llmScore,
        llmDetail ? JSON.stringify(llmDetail) : null,
        finalScore,
        model,
        nowISO(),
      );
    },

    getScore(fullName, runDate) {
      return get('SELECT * FROM scores WHERE full_name = ? AND run_date = ?', fullName, runDate) ?? null;
    },

    /* ------------------------------------------------------------- runs */

    startRun({ runDate, source, startedAt = nowISO() }) {
      run(
        `INSERT INTO runs (run_date, started_at, source)
         VALUES (?,?,?)
         ON CONFLICT(run_date) DO UPDATE SET started_at = excluded.started_at, source = excluded.source`,
        runDate,
        startedAt,
        source,
      );
    },

    finishRun({ runDate, candidates, afterFilter, scored, shown, digestPath, stats = {} }) {
      run(
        `UPDATE runs SET finished_at = ?, candidates = ?, after_filter = ?, scored = ?, shown = ?, digest_path = ?, stats_json = ?
         WHERE run_date = ?`,
        nowISO(),
        candidates,
        afterFilter,
        scored,
        shown,
        digestPath ?? null,
        JSON.stringify(stats ?? {}),
        runDate,
      );
    },

    getRun(runDate) {
      return get('SELECT * FROM runs WHERE run_date = ?', runDate) ?? null;
    },

    listRuns({ limit = 30 } = {}) {
      return all('SELECT * FROM runs ORDER BY run_date DESC LIMIT ?', limit);
    },

    /* --------------------------------------------------------- feedback */

    recordFeedback({ fullName, action, note = null, tags = [] }) {
      run(
        'INSERT INTO feedback (full_name, action, note, tags_json, created_at) VALUES (?,?,?,?,?)',
        fullName,
        action,
        note,
        JSON.stringify(tags),
        nowISO(),
      );
    },

    listFeedback({ limit = 50, fullName = null } = {}) {
      const rows = fullName
        ? all('SELECT * FROM feedback WHERE full_name = ? ORDER BY id DESC LIMIT ?', fullName, limit)
        : all('SELECT * FROM feedback ORDER BY id DESC LIMIT ?', limit);
      return rows.map((row) => ({ ...row, tags: JSON.parse(row.tags_json || '[]') }));
    },

    /* ---------------------------------------------------------- weights */

    getWeights() {
      const rows = all('SELECT key, value, hits FROM weights');
      const map = new Map();
      for (const row of rows) map.set(row.key, { value: row.value, hits: row.hits });
      return map;
    },

    bumpWeight(key, delta, { alpha = 0.35 } = {}) {
      const existing = get('SELECT value, hits FROM weights WHERE key = ?', key);
      const current = existing?.value ?? 0;
      // 指数滑动平均：反复反馈会向目标值收敛，而不是无限累加
      const next = clamp(current + alpha * (delta - current), -1, 1);
      run(
        `INSERT INTO weights (key, value, hits, updated_at)
         VALUES (?,?,1,?)
         ON CONFLICT(key) DO UPDATE SET value = ?, hits = hits + 1, updated_at = ?`,
        key,
        next,
        nowISO(),
        next,
        nowISO(),
      );
      return next;
    },

    resetWeights() {
      run('DELETE FROM weights');
    },

    /* -------------------------------------------------------------- misc */

    stats() {
      const repoCount = get('SELECT COUNT(*) AS n FROM repos').n;
      const snapshotCount = get('SELECT COUNT(*) AS n FROM snapshots').n;
      const feedbackCount = get('SELECT COUNT(*) AS n FROM feedback').n;
      const runCount = get('SELECT COUNT(*) AS n FROM runs').n;
      const scoreCount = get('SELECT COUNT(*) AS n FROM scores').n;
      const byAction = all('SELECT action, COUNT(*) AS n FROM feedback GROUP BY action');
      return { repoCount, snapshotCount, feedbackCount, runCount, scoreCount, feedbackByAction: byAction };
    },

    close() {
      cached.clear();
      db.close();
    },
  };
}

export function rowToRepo(row) {
  return {
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    url: row.url,
    description: row.description,
    homepage: row.homepage,
    language: row.language,
    topics: JSON.parse(row.topics_json || '[]'),
    stars: row.stars,
    forks: row.forks,
    openIssues: row.open_issues,
    sizeKb: row.size_kb,
    createdAt: row.created_at,
    pushedAt: row.pushed_at,
    license: row.license,
    archived: Boolean(row.archived),
    isFork: Boolean(row.is_fork),
    hasReadme: Boolean(row.has_readme),
    readmeChars: row.readme_chars,
    readmeText: row.readme_text ?? null,
    nodeId: row.node_id,
    firstSeenDate: row.first_seen_date,
    firstSeenStars: row.first_seen_stars,
    lastSeenDate: row.last_seen_date,
    extra: JSON.parse(row.extra_json || '{}'),
  };
}
