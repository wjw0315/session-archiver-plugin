/**
 * session-archiver：自动归档 idle 超过 N 天的 Paseo 会话（含主会话）。
 *
 * 安全设计（吸收 session-janitor 教训与上游 #2886 事故）：
 * - 只碰 lastStatus ∈ {idle, closed, error} 且 lastActivityAt 早于阈值的会话
 * - running/initializing、requiresAttention、protectedLabels 命中者永不归档
 * - dryRun 默认开：先只记录「将归档」名单，看过名单后再关 dryRun
 * - 归档前把索引 json 拷贝到 backup/；Paseo 的 archive 本身是 soft delete（可 Unarchive）
 * - 每轮有数量上限与时间上限，串行执行
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { archiverScanNow, archiverSetConfig, archiverStatus, type ArchiverStatus } from "./shared/contract";

const exec = promisify(execFile);

const PASEO_CLI = path.join(os.homedir(), ".local/bin/paseo");
const PASEO_HOME = path.join(os.homedir(), ".paseo");
const AGENTS_DIR = path.join(PASEO_HOME, "agents");
const DATA_DIR = path.join(PASEO_HOME, "plugin-data/session-archiver");
const BACKUP_DIR = path.join(DATA_DIR, "backup");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LOG_PATH = path.join(DATA_DIR, "log.jsonl");
const LOG_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_DEADLINE_MS = 30_000;
const ARCHIVABLE: Record<string, true> = { idle: true, closed: true, error: true };

interface Config {
  idleDays: number;        // idle 超过多少天才归档
  intervalMin: number;     // 扫描间隔（分钟）
  dryRun: boolean;         // true=只记录名单不动手
  enabled: boolean;        // 总开关（false 时完全不扫）
  maxPerSweep: number;     // 每轮最多归档个数
  protectedLabels: string[]; // 会话 labels 命中任一值则跳过
}

const DEFAULTS: Config = {
  idleDays: 14,
  intervalMin: 30,
  dryRun: true,
  enabled: false,
  maxPerSweep: 50,
  protectedLabels: [],
};

interface AgentRow {
  id: string;
  title?: string;
  lastStatus?: string;
  lastActivityAt?: string;
  archivedAt?: string;
  requiresAttention?: boolean;
  labels?: string[];
  file: string;
}

interface LogEntry {
  at: string;
  mode: "plan" | "execute";
  scanned: number;
  candidates: number;
  archived: { id: string; title: string; ok: boolean; detail: string }[];
}

function loadConfig(): Config {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg: Config): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function appendLog(entry: LogEntry): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
  } catch { /* 首次无日志 */ }
  lines.push(JSON.stringify(entry));
  if (lines.length > LOG_LIMIT) lines = lines.slice(-LOG_LIMIT);
  fs.writeFileSync(LOG_PATH, lines.join("\n") + "\n");
}

/** 遍历 agents/<cwd-slug>/<uuid>.json（跳过点开头目录），收集候选 */
function scanCandidates(cfg: Config, now: number): { rows: AgentRow[]; candidates: AgentRow[] } {
  const rows: AgentRow[] = [];
  const candidates: AgentRow[] = [];
  const cutoff = now - cfg.idleDays * DAY_MS;
  let slugs: string[] = [];
  try {
    slugs = fs.readdirSync(AGENTS_DIR);
  } catch {
    return { rows, candidates };
  }
  for (const slug of slugs) {
    if (slug.startsWith(".")) continue; // 排除 .backup 之类
    const dir = path.join(AGENTS_DIR, slug);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const file = path.join(dir, f);
      let a: AgentRow & Record<string, unknown>;
      try {
        a = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch { continue; }
      const row: AgentRow = {
        id: String(a.id ?? f.replace(/\.json$/, "")),
        title: typeof a.title === "string" ? a.title : "",
        lastStatus: typeof a.lastStatus === "string" ? a.lastStatus : undefined,
        lastActivityAt: typeof a.lastActivityAt === "string" ? a.lastActivityAt : undefined,
        archivedAt: typeof a.archivedAt === "string" ? a.archivedAt : undefined,
        requiresAttention: Boolean(a.requiresAttention),
        labels: Array.isArray(a.labels) ? a.labels.map(String) : [],
        file,
      };
      rows.push(row);
      const t = row.lastActivityAt ? Date.parse(row.lastActivityAt) : NaN;
      const stale = Number.isFinite(t) && t < cutoff;
      const safeState = ARCHIVABLE[row.lastStatus ?? ""];
      const unprotected = !(row.labels ?? []).some((l) => cfg.protectedLabels.includes(l));
      if (stale && safeState && !row.archivedAt && !row.requiresAttention && unprotected) candidates.push(row);
    }
  }
  return { rows, candidates };
}

async function archiveOne(row: AgentRow): Promise<{ ok: boolean; detail: string }> {
  // 归档前备份索引（archive 是 soft delete 可 Unarchive，备份是第二道保险）
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(row.file, path.join(BACKUP_DIR, `${row.id}.json`));
  } catch { /* 备份失败不阻断，归档仍可逆 */ }
  try {
    await exec(PASEO_CLI, ["archive", row.id, "--json"], { timeout: 20_000 });
    return { ok: true, detail: "archived" };
  } catch (e) {
    return { ok: false, detail: String((e as Error).message).slice(0, 200) };
  }
}

let sweeping = false;

// ---- 模块级状态（供 UI RPC 查询）----
const statusState = {
  lastSweepAt: null as string | null,
  lastMode: null as string | null,
  scanned: 0,
  candidates: 0,
  totalArchived: 0,
  rows: [] as { id: string; title: string; status: string; days: number }[],
  history: [] as { at: string; mode: string; candidates: number; archived: number; ok: number }[],
};

function statusNow(): ArchiverStatus {
  return { config: loadConfig(), ...statusState };
}

async function scanNow(): Promise<ArchiverStatus> {
  await runSweep({ force: true });
  return statusNow();
}

function applyConfigPatch(patch: Partial<Config>): ArchiverStatus {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  reschedule(next.intervalMin);
  return statusNow();
}

async function runSweep(opts: { force?: boolean } = {}): Promise<void> {
  if (sweeping) return;
  const cfg = loadConfig();
  if (!cfg.enabled && !opts.force) return;
  sweeping = true;
  const started = Date.now();
  try {
    const { rows, candidates } = scanCandidates(cfg, started);
    const targets = candidates.slice(0, cfg.maxPerSweep);
    const archived: LogEntry["archived"] = [];
    const execute = cfg.enabled && !cfg.dryRun;
    if (execute) {
      for (const row of targets) {
        if (Date.now() - started > SWEEP_DEADLINE_MS) break;
        const r = await archiveOne(row);
        archived.push({ id: row.id, title: row.title ?? "", ...r });
      }
    }
    statusState.lastSweepAt = new Date(started).toISOString();
    statusState.lastMode = execute ? "execute" : "plan";
    statusState.scanned = rows.length;
    statusState.candidates = candidates.length;
    statusState.totalArchived += archived.filter((a) => a.ok).length;
    statusState.rows = candidates.slice(0, 50).map((r) => ({
      id: r.id,
      title: r.title ?? "",
      status: r.lastStatus ?? "",
      days: Math.round((started - (Date.parse(r.lastActivityAt ?? "") || started)) / DAY_MS),
    }));
    appendLog({
      at: statusState.lastSweepAt,
      mode: execute ? "execute" : "plan",
      scanned: rows.length,
      candidates: candidates.length,
      archived,
    });
    statusState.history = [...statusState.history, {
      at: statusState.lastSweepAt,
      mode: execute ? "execute" : "plan",
      candidates: candidates.length,
      archived: archived.length,
      ok: archived.filter((a) => a.ok).length,
    }].slice(-20);
  } finally {
    sweeping = false;
  }
}

let sweepTimer: NodeJS.Timeout | undefined;

function reschedule(intervalMin: number): void {
  const ms = Math.max(5, intervalMin) * 60 * 1000;
  clearInterval(sweepTimer);
  sweepTimer = setInterval(() => { void runSweep(); }, ms);
}

export default function contribute(server: PluginServerContext): () => void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) saveConfig(loadConfig());
  const cfg = loadConfig();
  server.handle(archiverStatus, async () => statusNow());
  server.handle(archiverScanNow, async () => scanNow());
  server.handle(archiverSetConfig, async (patch) => applyConfigPatch(patch));
  reschedule(cfg.intervalMin);
  // 起动后 2 分钟跑第一轮（避开 daemon 启动高峰）
  const first = setTimeout(() => { void runSweep(); }, 2 * 60 * 1000);
  console.log(
    `[session-archiver] 已启动：每 ${cfg.intervalMin} 分钟扫描，idle>${cfg.idleDays} 天归档候选；dryRun=${cfg.dryRun} enabled=${cfg.enabled}`,
  );
  return () => {
    clearInterval(sweepTimer);
    clearTimeout(first);
    console.log("[session-archiver] 已停止");
  };
}
