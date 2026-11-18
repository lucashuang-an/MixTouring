import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {runtimeServices} from './runtime-services.mjs';

export function createUpstreamBudget({ path, limit, dailyAmount = null, rates = {}, clock = Date.now }) {
  function readLedger() {
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !Number.isFinite(Date.parse(value.day)) || new Date(value.day).toISOString().slice(0,10) !== value.day || !Number.isSafeInteger(value.calls) || value.calls < 0 || !Number.isFinite(value.reserved) || value.reserved < 0) throw Error('上游额度文件损坏');
    return value;
  }
  let ledger = readLedger();
  return {
    reserve(kind) {
      mkdirSync(dirname(path), { recursive: true });
      const lock = path + '.lock';
      const temporary = path + '.' + process.pid + '.tmp';
      const fd = openSync(lock, 'wx', 0o600);
      try {
        ledger = readLedger();
        const day = new Date(clock()).toISOString().slice(0, 10);
        if (!ledger || day > ledger.day) ledger = { version: 1, day, calls: 0, reserved: 0 };
        const amount = dailyAmount === null ? 0 : rates[kind];
        if (!Number.isFinite(amount) || amount < 0) throw Error('上游费用估算缺少费率');
        const reserved = Math.round((ledger.reserved + amount) * 1e6) / 1e6;
        if (ledger.calls >= limit || dailyAmount !== null && reserved > dailyAmount) {
          throw Object.assign(Error('今日上游调用额度已用尽'), { code: 'UPSTREAM_BUDGET_EXCEEDED' });
        }
        const next = { ...ledger, calls: ledger.calls + 1, reserved };
        writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
        renameSync(temporary, path);
        ledger = next;
      } finally {
        try { unlinkSync(temporary); } catch {}
        closeSync(fd);
        unlinkSync(lock);
      }
    },
    snapshot() { return ledger && { ...ledger }; }
  };
}

export function upstreamBudgetConfig(env = process.env) {
  const limit = Number(env.MT_DAILY_UPSTREAM_LIMIT || 1000);
  const dailyAmount = env.MT_DAILY_BUDGET_CNY ? Number(env.MT_DAILY_BUDGET_CNY) : null;
  const rates = JSON.parse(env.MT_UPSTREAM_COST_CNY || '{}');
  if (!Number.isSafeInteger(limit) || limit < 1 || dailyAmount !== null && (!Number.isFinite(dailyAmount) || dailyAmount <= 0 || ['model','search','map'].some(k => !Number.isFinite(rates[k]) || rates[k] < 0.000001))) throw Error('上游额度配置无效');
  return {limit, dailyAmount, rates};
}
let budget;
export function reserveUpstream(kind) {
  const cloud = runtimeServices();
  if (cloud) return cloud.reserveUpstream(kind);
  if (process.env.MT_PUBLIC !== '1' && !process.env.MT_DAILY_UPSTREAM_LIMIT && !process.env.MT_DAILY_BUDGET_CNY) return;
  budget ||= createUpstreamBudget({
    path: process.env.MT_BUDGET_FILE || fileURLToPath(new URL('../.state/upstream-budget.json', import.meta.url)),
    ...upstreamBudgetConfig()
  });
  budget.reserve(kind);
}
