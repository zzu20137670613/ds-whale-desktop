'use strict';

/**
 * 心跳层：专门治「长驻进程 + 跨天 + 依赖外部接口」这一类毛病。
 *
 * 为什么需要它（两个真实 bug 的共同病根）：
 *   1. **跨天补签不触发**。上游的签到写在 reconcile() 里，条件是
 *      `if (!memory.lastGrowthTick)` —— 也就是**一个进程只签一次**。
 *      电脑不关机、桌宠长驻，进程"活在昨天"，今天永远不会补签。
 *      而 Chromium 对不可见窗口的定时器会节流、系统睡眠唤醒还会让累加计时漂移，
 *      所以"启动时判一次"的做法必然失效。
 *   2. **余额/花费数字消失**。她的动作是**事件驱动**（有消息就切姿势），
 *      数字是**轮询拉取**（余额接口），两者寿命不同，于是出现"动作活着、数字死了"。
 *      接口超时后上游只把 ok 置 false，既不重试也不记账，界面就一直空着。
 *
 * 做法（**绝不累加时间，只看绝对日期**）：
 *   · 每分钟一个 tick，读**本地日期**和 localStorage 的 `whale-moe:lastSignin` 比较，
 *     不相等就补签（补签逻辑委托给注入进上游的 `__dshWhaleMoeSigninToday`，
 *     它复用上游自己的 applyGrowth/applyQuestSignal/syncWeekSignin，不重写养成规则）；
 *   · 同一个 tick 里顺带刷余额（失败重试 + 记下"最后一次成功时间"）；
 *   · 再挂 visibilitychange / focus / pageshow —— 睡眠唤醒或窗口重新可见时**立刻补判一次**，
 *     不用等到下一个整分钟。
 *
 * vendor 零改动：补签与余额同步的钩子由 src/server.js 在**服务时**注入（见 MASCOT_PATCH）。
 */

(function () {
  'use strict';

  const api = window.whaleShell || { log: () => {} };

  /** 心跳周期：一分钟。 */
  const TICK_MS = 60 * 1000;
  /** 签到日期键（与上游 dsh-whale-moe.js 的 dayKeyOf 同一格式：不补零）。 */
  const SIGNIN_KEY = 'whale-moe:lastSignin';
  /** 余额失败后的重试节奏（毫秒）；用完后保持最后一档。 */
  const BALANCE_RETRY_MS = [10 * 1000, 30 * 1000];

  /** 对外快照：探针与壳层渲染都读它。 */
  const state = {
    at: 0,
    date: '',
    tickCount: 0,
    reason: '',
    signin: { checkedAt: 0, date: '', signed: false, already: false, error: '' },
    balance: {
      ok: null,
      amount: null,
      currency: '',
      tier: '',
      at: 0,
      lastOkAt: 0,
      lastOkAmount: null,
      error: '',
      attempts: 0,
    },
  };
  window.__dshWhaleHeartbeat = state;

  /** 本地日期键。**必须与上游 dayKeyOf 完全一致**，否则补签判断会一直不相等。 */
  function dayKey(now) {
    const d = new Date(now);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function readLastSignin() {
    try {
      return localStorage.getItem(SIGNIN_KEY) || '';
    } catch (error) {
      return '';
    }
  }

  // ---------------------------------------------------------------- 跨天补签
  /** 读本地日期 → 与上次签到比较 → 不等就补签。只做绝对日期比较，不累加。 */
  function checkSignin(now) {
    const today = dayKey(now);
    const last = readLastSignin();
    state.signin.checkedAt = now;
    state.signin.date = today;
    state.signin.error = '';

    if (last === today) {
      state.signin.signed = false;
      state.signin.already = true;
      return;
    }

    const hook = window.__dshWhaleMoeSigninToday;
    if (typeof hook !== 'function') {
      state.signin.error = 'hook-missing';
      api.log('error', '心跳：补签钩子缺失（mascot 补丁未注入？）');
      return;
    }

    const out = hook() || {};
    state.signin.already = Boolean(out.already);
    state.signin.signed = Boolean(out.signed);
    state.signin.error = out.error || '';
    if (state.signin.signed) {
      api.log('info', `心跳：跨天补签成功（${last || '无记录'} -> ${today}，连续 ${out.streak || '?'} 天）`);
    } else if (state.signin.error) {
      api.log('error', `心跳：补签失败 ${state.signin.error}`);
    }
  }

  // ---------------------------------------------------------------- 余额刷新
  let balanceInFlight = false;
  let balanceRetryTimer = null;
  let balanceRetryIndex = 0;

  function scheduleBalanceRetry() {
    if (balanceRetryTimer) {
      return;
    }
    const wait = BALANCE_RETRY_MS[Math.min(balanceRetryIndex, BALANCE_RETRY_MS.length - 1)];
    balanceRetryIndex += 1;
    balanceRetryTimer = window.setTimeout(() => {
      balanceRetryTimer = null;
      syncBalance('retry');
    }, wait);
  }

  async function syncBalance(reason) {
    const hook = window.__dshWhaleMoeSyncBalance;
    if (typeof hook !== 'function') {
      state.balance.error = 'hook-missing';
      return;
    }
    if (balanceInFlight) {
      return;
    }
    balanceInFlight = true;
    try {
      const out = (await hook()) || {};
      state.balance.attempts += 1;
      state.balance.at = Date.now();
      if (out.ok) {
        state.balance.ok = true;
        state.balance.amount = out.amount;
        state.balance.currency = out.currency || 'CNY';
        state.balance.tier = out.tier || '';
        state.balance.lastOkAt = Date.now();
        state.balance.lastOkAmount = out.amount;
        state.balance.error = '';
        balanceRetryIndex = 0;
        if (balanceRetryTimer) {
          window.clearTimeout(balanceRetryTimer);
          balanceRetryTimer = null;
        }
      } else {
        state.balance.ok = false;
        state.balance.error = out.reason || 'unavailable';
        scheduleBalanceRetry();
      }
    } catch (error) {
      state.balance.ok = false;
      state.balance.error = String((error && error.message) || error);
      scheduleBalanceRetry();
    } finally {
      balanceInFlight = false;
      if (typeof window.__dshWhaleRefreshHud === 'function') {
        window.__dshWhaleRefreshHud();
      }
      if (state.balance.ok === false) {
        api.log('error', `心跳：余额刷新失败（${reason || 'tick'}） ${state.balance.error}`);
      }
    }
  }

  // ---------------------------------------------------------------- 心跳
  function tick(reason) {
    const now = Date.now();
    state.at = now;
    state.reason = reason || 'tick';
    state.tickCount += 1;
    state.date = dayKey(now);

    checkSignin(now);
    // 每次心跳都补一次余额：接口在时它是"最新值"，接口挂时它负责重试。
    // 成功的那一次会顺带把上游自己的 60 秒节流时间一起推进，不会重复拉。
    syncBalance(reason);
  }

  // 启动即判一次（等价于上游"启动时判一次"，但之后不会就此停摆）
  tick('boot');

  // 每分钟一个 tick：日期检查 + 余额刷新 + 超时判定都在这一个地方做
  window.setInterval(() => tick('interval'), TICK_MS);

  // 睡眠唤醒 / 窗口重新可见 / 切回前台 → 立刻补判一次，不等下一个整分钟
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      tick('visible');
    }
  });
  window.addEventListener('focus', () => tick('focus'));
  window.addEventListener('pageshow', () => tick('pageshow'));
})();