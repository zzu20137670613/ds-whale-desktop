'use strict';

/**
 * 余额差额估算「今日消耗」。
 *
 * 适用场景：桌宠没接 DSH（读不到会话账本）时，usage-today 拿不到 turn 数据，
 * 「今日消耗」就没有数据源。退路：拿"今天首次读到的余额"当基准，
 * 当前余额 − 基准 = 今天花掉的。
 *
 * 语义与边界（跟用户对齐过，防止误读）：
 *   · 基准余额：今天第一次成功读到余额时取样；本地日期一变（0 点后首次
 *     读取）自动重取样；落盘 userData/balance-diff.json 兜底 —— 桌宠重启、
 *     当天再查不多算，重启当天不丢；
 *   · 差额 = 基准 − 当前，挖到 0 为止：充值 / 多端共用同一 Key 导致余额
 *     变多时，负数按 0 显示，并标 recharged；
 *   · 查询频率限制：距上次真实 fetch 不足 60 秒用缓存，避免点一次余额
 *     查询就打一次官方接口；
 *   · 精度与延迟：余额只到分，小额对话可能差出 0.00；扣费到账有延迟，
 *     刚扣完立刻查可能没数 —— 这是估算，不是账单。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FETCH_MIN_MS = 60 * 1000;

/** 本地日期键 YYYY-MM-DD（与 src/usage-today.js 同一约定，按本地时区切天）。 */
function localDateKey(at = Date.now()) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class BalanceDiff {
  /**
   * @param {object} options
   * @param {string} options.file            落盘路径（userData/balance-diff.json）
   * @param {() => Promise<number|null>} options.fetchBalance 取当前余额（元），失败返回 null
   * @param {number} [options.fetchMinMs]    真实 fetch 的最小间隔，默认 60 秒
   * @param {(message:string)=>void} [options.log]
   */
  constructor({ file, fetchBalance, fetchMinMs, log }) {
    if (!file || typeof fetchBalance !== 'function') {
      throw new Error('BalanceDiff: file 与 fetchBalance 必填');
    }
    this.file = file;
    this.fetchBalance = fetchBalance;
    this.fetchMinMs = fetchMinMs || DEFAULT_FETCH_MIN_MS;
    this.log = log || (() => {});

    this.store = null; // { date, baseline }
    this.lastFetchAt = 0; // 最近一次真实 fetch 的时刻（毫秒）
    this.lastAmount = null; // 最近一次真实 fetch 到的余额（缓存）
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && typeof raw.date === 'string' && Number.isFinite(Number(raw.baseline))) {
        this.store = { date: raw.date, baseline: Number(raw.baseline) };
      }
    } catch (error) {
      /* 文件不存在或读不了都正常 */
    }
    return this.store;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.store));
    } catch (error) {
      this.log(`无法落盘基准余额: ${error.message}`);
    }
  }

  /**
   * 确保今天有基准余额（启动时调一次；跨天后第一次估算也会自动重取）。
   * 注意：基准取样的 fetch **不写 current 缓存** —— 否则刚取完基准的 60 秒内，
   * 所有估算都会拿"基准时刻的余额"当当前余额，差数恒为 0。
   * @returns {Promise<number|null>} 今天的基准余额；取不到（余额接口不可用）返回 null。
   */
  async ensureBaseline() {
    const dk = localDateKey();
    if (this.store && this.store.date === dk) {
      return this.store.baseline;
    }
    const amount = await this.fetchBalance();
    if (amount === null) return null;
    this.store = { date: dk, baseline: amount };
    this.save();
    this.log(`今日基准余额 ${amount.toFixed(2)} 元（${dk}）`);
    return amount;
  }

  /**
   * 估算今日消耗。
   * @returns {Promise<{ok:true, date:string, amount:number, baseline:number, current:number, recharged:boolean} | {ok:false, reason:string}>}
   */
  async estimateToday() {
    const dk = localDateKey();
    if (!this.store || this.store.date !== dk) {
      await this.ensureBaseline();
    }
    if (!this.store || this.store.date !== dk) {
      return { ok: false, reason: '余额接口不可用，取不到今日基准' };
    }
    const baseline = this.store.baseline;

    // 60 秒内用缓存，避免每次点余额查询都打官方接口
    let current = this.lastAmount;
    if (current === null || Date.now() - this.lastFetchAt >= this.fetchMinMs) {
      const amount = await this.fetchBalance();
      if (amount === null && current === null) {
        return { ok: false, reason: '当前余额也取不到' };
      }
      if (amount !== null) {
        this.lastFetchAt = Date.now();
        this.lastAmount = amount;
        current = amount;
      }
    }

    const diff = baseline - current;
    return {
      ok: true,
      date: dk,
      baseline,
      current,
      recharged: diff < 0,
      amount: diff > 0 ? diff : 0,
    };
  }
}

module.exports = { BalanceDiff, localDateKey };