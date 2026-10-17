'use strict';

/**
 * 壳胶水（渲染进程）。
 *
 * 核心职责只有一个：**点击穿透的实时判定**。
 *
 * 窗口是整屏透明置顶的，默认让所有鼠标事件穿过去（setIgnoreMouseEvents(true, {forward:true})）。
 * 只在指针真正压到桌宠（或它弹出的菜单/特效）上时，才临时把窗口切回"接收鼠标"，
 * 这样既不会挡住桌面操作，桌宠的点击/拖拽/右键菜单又全部照常。
 *
 * 判定方式利用了上游 CSS 的结构：容器 pointer-events:none，可交互部件 pointer-events:auto，
 * 所以 elementFromPoint 命中到 html/body 以外的东西就意味着"压到桌宠了"。
 */
(function () {
  'use strict';

  const api = window.whaleShell;
  if (!api) {
    return;
  }

  // ---------- 日志回传（无界面时靠它排查）----------
  api.log('info', 'shell bridge ready');
  window.addEventListener('error', (event) => {
    api.log('error', `window.onerror: ${event.message} @ ${event.filename}:${event.lineno}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    api.log('error', `unhandledrejection: ${(reason && reason.message) || reason}`);
  });
  window.addEventListener('load', () => {
    const root = document.querySelector('[data-dsh-whale-root]');
    const frames = root ? root.querySelectorAll('img[data-dsh-whale-frame], img[data-dsh-whale-layer]').length : 0;
    api.log('info', `dom ready: whaleRoot=${Boolean(root)} imgNodes=${frames} bodyChildren=${document.body.children.length}`);
  });

  // ---------- 点击穿透 ----------
  let interactive = null;
  /** 诊断用：渲染进程最后收到的鼠标信息，经 /__shell/state 暴露。 */
  let lastMouse = null;

  function setInteractive(next) {
    if (next === interactive) {
      return;
    }
    interactive = next;
    api.setInteractive(next);
  }

  function hitTest(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    return Boolean(el) && el !== document.documentElement && el !== document.body;
  }

  /** 统一入口：页内 mousemove 与主进程光标轮询都走这里。 */
  function applyCursor(clientX, clientY, source) {
    const hit = hitTest(clientX, clientY);
    const el = document.elementFromPoint(clientX, clientY);
    lastMouse = {
      x: Math.round(clientX),
      y: Math.round(clientY),
      hit,
      source,
      target: el ? el.tagName + (el.getAttributeNames ? '[' + el.getAttributeNames().join(',') + ']' : '') : null,
      at: Date.now(),
    };
    setInteractive(hit);
    // 悬浮联动：压到她身上（含浮层）→ 显示状态浮层；离开 → 收起（见 syncHudWithHover）
    syncHudWithHover(hit);
  }

  window.addEventListener(
    'mousemove',
    (event) => applyCursor(event.clientX, event.clientY, 'mousemove'),
    { passive: true }
  );

  // 主通道：主进程轮询屏幕光标（不依赖 Windows 的鼠标事件转发，见 preload.js 注释）
  if (typeof api.onCursor === 'function') {
    api.onCursor((pos) => {
      if (pos && typeof pos.x === 'number') {
        applyCursor(pos.x, pos.y, 'poll');
      }
    });
  }

  window.addEventListener('mouseleave', () => {
    lastMouse = { x: null, y: null, hit: false, leave: true, at: Date.now() };
    setInteractive(false);
    // 提前触发收起，不用等主进程下一轮光标轮询（最长 80ms）
    syncHudWithHover(false);
  });

  // 兜底：窗口失焦后一律回到穿透，避免"卡在接收鼠标"把桌面点不动
  window.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!document.querySelector('[data-dsh-whale-context]')) {
        setInteractive(false);
      }
    }, 400);
  });

  // 启动即穿透
  setInteractive(false);

  // ---------- 右键菜单越界修正 ----------
  // 上游 showContextMenu 用写死的 180x160 估算菜单尺寸夹取位置
  // （vendor/whale/dsh-whale-moe.js 第 610-611 行），但菜单高度随项目数变化
  // —— 实测 8 项就有 292px 高，贴屏幕右下角时必然溢出（实测右溢 14px、下溢 132px）。
  //
  // 修在壳层而不是改上游素材：一旦改了 vendor/whale，`npm run sync:upstream`
  // 就会把它冲掉。这里改为在菜单出现后用**实测尺寸**重新夹取回视口内。
  const CONTEXT_SELECTOR = '[data-dsh-whale-context]';
  const EDGE_MARGIN = 8;
  const clampObservers = new WeakMap();

  function clampIntoViewport(menu) {
    if (!menu || !menu.isConnected) {
      return;
    }
    const rect = menu.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 视口比菜单还小时退化为贴左上角，至少不出现负坐标
    const maxLeft = Math.max(EDGE_MARGIN, vw - rect.width - EDGE_MARGIN);
    const maxTop = Math.max(EDGE_MARGIN, vh - rect.height - EDGE_MARGIN);
    const nextLeft = Math.round(Math.min(Math.max(rect.left, EDGE_MARGIN), maxLeft));
    const nextTop = Math.round(Math.min(Math.max(rect.top, EDGE_MARGIN), maxTop));
    // 只在确有偏差时写回，避免与下面的 style 观察器互相触发
    if (Math.abs(nextLeft - rect.left) > 0.5) {
      menu.style.left = `${nextLeft}px`;
    }
    if (Math.abs(nextTop - rect.top) > 0.5) {
      menu.style.top = `${nextTop}px`;
    }
  }

  function watchMenu(menu) {
    stripNonInteractionItems(menu);
    injectOpenDshItem(menu);
    clampIntoViewport(menu);
    // 布局可能要到下一帧才稳定，再夹一次兜底
    requestAnimationFrame(() => clampIntoViewport(menu));
    if (clampObservers.has(menu)) {
      return;
    }
    const observer = new MutationObserver(() => clampIntoViewport(menu));
    observer.observe(menu, { attributes: true, attributeFilter: ['style'] });
    clampObservers.set(menu, observer);
  }

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) {
          continue;
        }
        if (node.matches(CONTEXT_SELECTOR)) {
          watchMenu(node);
        } else if (typeof node.querySelectorAll === 'function') {
          node.querySelectorAll(CONTEXT_SELECTOR).forEach(watchMenu);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- 桌宠右键菜单只留"对她做的事" ----------
  // 上游菜单里「打开看板娘设置」属于应用级配置，按职责划分应该走
  // 托盘 → 设置窗口，所以壳层把它从桌宠菜单里摘掉。
  //
  // 只在"页面上确实没有 DSH 设置入口"时摘：将来若把这个页面嵌回 DSH，
  // 上游原有的行为应当原样保留，我们不抢。
  const NON_INTERACTION_ITEMS = ['打开看板娘设置'];

  /** 页面里到底有没有 DSH 的设置入口。 */
  function hasDshSettingsEntry() {
    if (document.querySelector('[data-slot="sidebar.settings"] button')) {
      return true;
    }
    const trigger = document.querySelector('[data-slot="settings.trigger"]');
    if (trigger && typeof trigger.closest === 'function' && trigger.closest('button')) {
      return true;
    }
    return Array.from(document.querySelectorAll('button')).some(
      (node) => (node.textContent || '').trim() === '设置'
    );
  }

  function stripNonInteractionItems(menu) {
    if (hasDshSettingsEntry()) {
      return;
    }
    for (const button of menu.querySelectorAll('button')) {
      const label = (button.textContent || '').trim();
      if (NON_INTERACTION_ITEMS.includes(label)) {
        button.remove();
        api.log('info', `已从桌宠右键菜单摘掉「${label}」（它属于设置，已移到托盘 → 设置窗口）`);
      }
    }
  }

  // ---------- 桌宠右键菜单：补一条「打开DSH」 ----------
  /**
   * 上游的菜单是它自己拼的（vendor/whale 里的 showContextMenu），壳层不改素材，
   * 只在菜单出现后往「关闭菜单」前面插一条 —— 与摘掉「打开看板娘设置」同一时机。
   *
   * 这件事为什么该在桌宠菜单里：它跟"设置"不同，是**唤起 DSH 本身**，
   * 属于"对她做的/通过她做的一件事"，和投喂、夸夸是一个层级的动作。
   *
   * 主进程那边保证：DSH 已经在跑就只开浏览器（绝不重启 —— 重启会把用户
   * 正在聊的会话一起带走），没跑才拉起来。
   */
  const OPEN_DSH_LABEL = '打开DSH';

  function injectOpenDshItem(menu) {
    if (menu.querySelector('[data-dsh-open-dsh]')) {
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = OPEN_DSH_LABEL;
    button.setAttribute('data-dsh-open-dsh', 'true');
    button.addEventListener('click', (event) => {
      // 上游给菜单项的约定：点击即收起菜单（点外面收起的那套逻辑也认这个）
      event.stopPropagation();
      menu.remove();
      openDsh();
    });

    const close = Array.from(menu.querySelectorAll('button')).find(
      (node) => (node.textContent || '').trim() === '关闭菜单'
    );
    if (close) {
      menu.insertBefore(button, close);
    } else {
      menu.append(button);
    }
  }

  /**
   * 「打开DSH」：已经在跑就开浏览器，没跑就拉起来再开。
   *
   * 停留时长用主进程的默认值（5 秒，同余额查询），这里不再传 ——
   * 少一个常量就少一处能对不上的地方。
   */
  async function openDsh() {
    if (typeof api.openDsh !== 'function') {
      api.log('error', '打开DSH：预加载通道不可用');
      return;
    }
    api.log('info', '打开DSH：开始');
    try {
      const result = await api.openDsh();
      /*
       * 台词要跟**真实结果**对齐：主进程把"浏览器到底开没开成"也回报过来了
       * （opened），不能出现"她说打开了、实际没打开"这种谎报。
       */
      const failedToOpen = result && result.opened === false && result.dryRun !== true;
      const line = !result || !result.ok
        ? 'DSH 没起来…你看看运行日志吧'
        : failedToOpen
          ? 'DSH 是开着的，可浏览器没调起来…'
          : result.running
            ? 'DSH 已经开着啦，这就给你打开～'
            : 'DSH 起来了，浏览器已经给你打开～';
      api.log('info', `打开DSH：${line} ${(result && result.url) || ''} ${(result && result.error) || ''}`);
      if (typeof api.say === 'function') {
        await api.say(line);
      }
    } catch (error) {
      api.log('error', `打开DSH 失败：${(error && error.message) || error}`);
    }
  }

  // ---------- 页面内偏好面板：补一个能关掉它的入口 ----------
  // 上游面板只能靠齿轮 ⚙ 开合，而齿轮在台词气泡里、气泡 4.5 秒后自动隐藏，
  // 于是面板一打开就没有可点的关闭入口 —— 这是上游在独立宿主下的设计缺口。
  // 壳层给它注入一个 × 按钮，并补上「点外面关闭 / Esc 关闭」。
  let panelCloseTarget = null;

  function ensurePanelClose() {
    // 桌宠 DOM 变动很频繁，这里先做最便宜的短路
    if (panelCloseTarget && panelCloseTarget.isConnected) {
      return;
    }
    const panel = document.querySelector('[data-dsh-whale-prefs]');
    if (!panel) {
      return;
    }
    // 上游给 [data-dsh-whale-prefs] button 定了 flex 行样式，
    // 所以这里必须用内联样式（内联优先于样式表）把它压成一个小圆钮。
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-dsh-whale-prefs-close', 'true');
    button.title = '关闭设置';
    button.setAttribute('aria-label', '关闭设置');
    button.textContent = '×';
    button.style.cssText = [
      'position:absolute',
      'top:4px',
      'right:6px',
      'display:block',
      'width:18px',
      'height:18px',
      'padding:0',
      'margin:0',
      'line-height:16px',
      'font-size:14px',
      'text-align:center',
      'color:inherit',
      'background:transparent',
      'border:0',
      'border-radius:6px',
      'box-shadow:none',
      'cursor:pointer',
      'opacity:0.6',
    ].join(';');
    button.addEventListener('mouseenter', () => {
      button.style.opacity = '1';
    });
    button.addEventListener('mouseleave', () => {
      button.style.opacity = '0.6';
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      panel.hidden = true;
    });
    if (getComputedStyle(panel).position === 'static') {
      panel.style.position = 'relative';
    }
    // 给 × 让出位置，免得压住第一个开关
    panel.style.paddingTop = '20px';
    panel.appendChild(button);
    panelCloseTarget = panel;
    api.log('info', '已给页面内偏好面板注入关闭按钮');
  }
  // 桌宠根节点是后挂到 body 的，出现后再注入。
  // 注意：这里**不能**同步调用 ensureHud() —— HUD_ID 用 const 声明在本文件更靠后的位置，
  // 提前调用会踩暂时性死区（TDZ）抛错，把后面整段脚本都带停。
  // 观察器回调是异步的，那时声明已经执行过，调用是安全的。
  ensurePanelClose();
  new MutationObserver(() => {
    ensurePanelClose();
    ensureHud();
  }).observe(document.body, { childList: true, subtree: true });

  // 点面板外面关闭：上游给 rootNode 挂了 stopPropagation，
  // 所以"能冒泡到 document 的点击"天然就是"点在桌宠之外"。
  document.addEventListener('click', () => {
    const panel = document.querySelector('[data-dsh-whale-prefs]');
    if (panel && !panel.hidden) {
      panel.hidden = true;
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    const panel = document.querySelector('[data-dsh-whale-prefs]');
    if (panel && !panel.hidden) {
      panel.hidden = true;
    }
  });

  // ---------- 头顶浮层：天气 / 余额 / 养成入口 ----------
  // 上游那块位置原本是三个开关（看板娘/台词气泡/粒子效果）——它们已经进了设置窗口，
  // 于是壳层把这块位置改造成"状态 + 入口"。显示改由**悬浮**控制（移开或点她本体收起），
  // 不需要再像原来那样先点右上角的设置图标（齿轮开合逻辑已移除）。
  const HUD_ID = 'dsh-whale-shell-hud';
  let hudTimer = null;

  function hudReadWeather() {
    const state = window.__dshWhaleMoeWeather || {};
    const core = window.DshWhaleMoeCore;
    const city = String(state.city || '').trim();
    if (!city) {
      return { main: '未设置城市', sub: '点这里去设置', tone: 'muted' };
    }
    const current = state.current;
    if (!current) {
      return { main: city, sub: state.status === 'error' ? '获取失败' : '获取中…', tone: 'muted' };
    }
    const text = core && core.weatherText ? core.weatherText(current.code) : { emoji: '🌡️', label: '' };
    return { main: `${text.emoji} ${city} ${Math.round(current.temp)}°`, sub: text.label, tone: 'ok' };
  }

  /** HH:MM（本地）——浮层里标注"数据是什么时候的"。 */
  function clockOf(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function hudReadBalance() {
    let enabled = false;
    try {
      enabled = localStorage.getItem('whale-moe:balance') === '1';
    } catch (error) {
      enabled = false;
    }
    if (!enabled) {
      return { main: '未启用余额', sub: '点这里去设置', tone: 'muted' };
    }
    const state = window.__dshWhaleMoeBalance;
    const hb = (window.__dshWhaleHeartbeat && window.__dshWhaleHeartbeat.balance) || null;
    const core = window.DshWhaleMoeCore;
    const amount = state && state.ok ? Number(state.amount) : NaN;
    /*
     * 渲染层不留白：读不到时金额位给固定占位符「—」，副行说清是"没读到"还是"读到 0"。
     * 否则金额位空白，人根本分不出「余额真的是 0」和「接口超时了」。
     * 余额接口超时是常态（见 balance-proxy 的 upstream failed 日志），
     * 所以顺带把心跳层记的"最后一次成功时间"标出来。
     */
    if (!Number.isFinite(amount)) {
      const since = hb && hb.lastOkAt ? clockOf(hb.lastOkAt) : '';
      const sub = since ? `读不到余额 · 上次 ${since}` : '余额接口无响应';
      return { main: '💰 —', sub, tone: 'muted' };
    }
    // 金额要精确到分：上游的 formatBalance(…, false) 只给档位措辞（充裕/紧张…），
    // 所以把确切数字放到主行，档位词退到副行。
    const tier = core && core.formatBalance ? core.formatBalance(amount, state.currency, false) : state.tier;
    const since = hb && hb.lastOkAt ? clockOf(hb.lastOkAt) : '';
    const sub = [tier || '', since ? `更新 ${since}` : ''].filter(Boolean).join(' · ');
    return { main: `💰 ${state.currency || 'CNY'} ${amount.toFixed(2)}`, sub, tone: 'ok' };
  }

  /*
   * 峰谷时段 + 倒计时（搬自上游 dsh-whale-widget 的「峰谷模块」）。
   *
   * 规则（北京时间）：
   *   · 工作日 9:00–12:00、14:00–18:00 为高峰；其余（午休、夜间、周末全天）为空闲；
   *   · 法定节假日同样全天谷价 —— 但放假安排前端拿不到（上游由宿主下发），
   *     这里与上游的已知边界一致地**不处理**（那几天会按工作日算，偏保守）。
   * 倒计时指向「下一个时段切换点」（高峰→空闲 或 空闲→高峰），逐秒刷新。
   */
  function isPeakAt(sec) {
    const bj = new Date((sec + 8 * 3600) * 1000);
    const dow = bj.getUTCDay();
    if (dow === 0 || dow === 6) {
      return false;
    }
    const hour = bj.getUTCHours();
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  }

  function hudReadPeak() {
    const sec = Math.floor(Date.now() / 1000);
    const peak = isPeakAt(sec);
    // 从今天起按天扫描，取第一个「状态与当前不同」的边界（与上游同款算法）
    const dayStart = Math.floor((sec + 8 * 3600) / 86400) * 86400;
    const edges = [0, 9 * 3600, 12 * 3600, 14 * 3600, 18 * 3600];
    let next = null;
    for (let d = 0; d <= 12 && next === null; d++) {
      const base = dayStart + d * 86400;
      for (let i = 0; i < edges.length; i++) {
        const ts = base + edges[i] - 8 * 3600;
        if (ts <= sec + 1) {
          continue;
        }
        if (isPeakAt(ts) !== peak) {
          next = ts;
          break;
        }
      }
    }
    if (next === null) {
      next = sec + 86400;
    }
    const remain = Math.max(0, next - sec);
    const p = (n) => String(n).padStart(2, '0');
    const cd = `${p(Math.floor(remain / 3600))}:${p(Math.floor((remain % 3600) / 60))}:${p(remain % 60)}`;
    return {
      main: peak ? '🔥 梁文峰' : '💧 梁文谷',
      sub: `距${peak ? '空闲' : '高峰'} ${cd}`,
      tone: 'ok',
    };
  }

  // 天气预取。
  // 上游只在**空闲聊天**里才 weatherEnsure()（间隔数分钟且要求她正闲着），
  // 于是「设置里填了城市 → 浮层一直显示获取中」可能要等很久。
  // 这里由壳层主动拉一次同样的 Open-Meteo 接口，并把结果写回
  // `window.__dshWhaleMoeWeather` —— 它就是上游闭包里的 weatherState（同一引用），
  // 所以她的天气特效、天气台词、浮层显示会一起用上这份数据。
  // vendor 不改；上游自己到点照常刷新，两边不冲突。
  const WEATHER_FRESH_MS = 2 * 3600 * 1000;
  let weatherPending = false;

  function weatherStored(key) {
    try {
      return (localStorage.getItem('whale-moe:' + key) || '').trim();
    } catch (error) {
      return '';
    }
  }

  async function ensureWeatherFresh(force) {
    const state = window.__dshWhaleMoeWeather;
    const city = weatherStored('weatherCity');
    if (!state || !city || weatherPending) {
      return;
    }
    const fresh = state.current && Date.now() - (state.fetchedAt || 0) < WEATHER_FRESH_MS;
    if (!force && fresh) {
      return;
    }
    weatherPending = true;
    try {
      const key = weatherStored('weatherKey');
      const keyParam = key ? `&apikey=${encodeURIComponent(key)}` : '';
      const geo = await (await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json${keyParam}`
      )).json();
      const hit = geo && Array.isArray(geo.results) ? geo.results[0] : null;
      if (!hit) {
        throw new Error('城市未找到');
      }
      const wx = await (await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
          `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&timezone=auto${keyParam}`
      )).json();
      if (!wx || !wx.current) {
        throw new Error('无天气数据');
      }
      state.current = {
        temp: Number(wx.current.temperature_2m),
        code: String(wx.current.weather_code),
        wind: Number(wx.current.wind_speed_10m || 0),
        humidity: Number(wx.current.relative_humidity_2m || 0),
      };
      state.fetchedAt = Date.now();
      state.status = 'ok';
      state.city = city;
      state.key = key;
      try {
        localStorage.setItem('whale-moe:weatherLat', String(hit.latitude));
        localStorage.setItem('whale-moe:weatherLon', String(hit.longitude));
      } catch (error) {
        /* 缓存坐标失败无所谓 */
      }
      api.log('info', `天气已预取：${city} ${Math.round(state.current.temp)}°`);
    } catch (error) {
      state.status = 'error';
      api.log('error', 'weather prefetch failed: ' + error.message);
    } finally {
      weatherPending = false;
      refreshHud();
    }
  }

  function hudRow(key, loader, onClick) {
    const row = document.createElement('div');
    row.className = 'hud-row';
    row.setAttribute('data-hud-row', key);
    const main = document.createElement('span');
    main.className = 'k';
    const sub = document.createElement('span');
    sub.className = 'v';
    row.append(main, sub);
    if (typeof onClick === 'function') {
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
      });
    } else {
      // 纯展示行（峰谷倒计时没有可配置项）：不挂点击，也不摆出可点的姿态
      row.setAttribute('data-static', 'true');
    }
    row.__update = () => {
      const info = loader();
      main.textContent = info.main;
      sub.textContent = info.sub || '';
      row.setAttribute('data-tone', info.tone || 'muted');
    };
    return row;
  }

  function ensureHud() {
    const existing = document.getElementById(HUD_ID);
    if (existing && existing.isConnected) {
      return existing;
    }
    const rootNode = document.querySelector('[data-dsh-whale-root]');
    if (!rootNode) {
      return null;
    }
    const hud = document.createElement('div');
    hud.id = HUD_ID;
    hud.hidden = true;

    const toSettings = () => {
      if (typeof api.openSettings === 'function') {
        api.openSettings();
      }
    };
    const toGrowth = (tab) => {
      if (typeof api.openGrowth === 'function') {
        api.openGrowth(tab);
      }
    };

    /*
     * 点选项就收起浮层。
     *
     * 原来这里只 stopPropagation（防止点浮层时被"点外面收起"的 document 监听收掉），
     * 结果点完选项浮层还杵在头顶 —— 而这两个入口都会打开别的窗口/冒出台词，
     * 浮层留着既挡视线又显得没反应。所以：**先收起，再执行动作**（动作抛异常也已收起）。
     * 行（天气/余额）同理 —— 它们也是"点一下去别处"的入口。
     */
    const closeAnd = (fn) => () => {
      setHudVisible(false);
      fn();
    };

    const weatherRow = hudRow('weather', hudReadWeather, closeAnd(toSettings));
    const balanceRow = hudRow('balance', hudReadBalance, closeAnd(toSettings));
    const peakRow = hudRow('peak', hudReadPeak);

    /*
     * 入口按钮：两个并排、等宽（.hud-actions 里 flex:1），
     * 所以文案长短不同也不会一宽一窄。顺序：日常养成在左、余额查询在右。
     */
    const actions = document.createElement('div');
    actions.className = 'hud-actions';

    function hudAction(key, label, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hud-action';
      button.setAttribute('data-hud-action', key);
      button.textContent = label;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        setHudVisible(false);
        onClick(button);
      });
      actions.append(button);
      return button;
    }

    hudAction('growth', '日常养成', () => toGrowth('quests'));
    hudAction('balance-query', '余额查询', (button) => {
      queryBalance(button);
    });

    hud.append(weatherRow, balanceRow, peakRow, actions);
    hud.__refresh = () => {
      weatherRow.__update();
      balanceRow.__update();
      peakRow.__update();
    };
    rootNode.append(hud);
    hud.__refresh();
    api.log('info', '头顶浮层已就绪（天气 / 余额 / 峰谷 / 日常养成 / 余额查询）');
    return hud;
  }

  // ---------- 余额查询：把余额、档位、今日消耗念成一句话 ----------
  /**
   * 播报格式（用户定的）：
   *   当前余额为 CNY 41.11，状态为充裕，今日共计消耗 35.2 万 tokens，消费 0.53 元
   *
   * 数据来源分两半：
   *   · 余额与档位 —— 页面里的 window.__dshWhaleMoeBalance（上游自己按 60 秒刷新），
   *     档位文案沿用上游的 formatBalance（已见底/告急/偏紧/正常/充裕/很充裕）；
   *   · 今日消耗 —— 主进程的账本（读会话文件的 usage 按 turn 记账），
   *     数字在主进程格式化好再送过来，避免两处各写一套万/亿/小数规则。
   */
  /**
   * 播报类台词打完字后停留多久（毫秒）。
   *
   * 上游是"开口时"就设 4.5 秒到期，而台词逐字打（标点 260ms、每 5 字 130ms、其余 64ms），
   * 余额那句子四十多字光打字就 4 秒多 —— 打完基本就到点了，等于看不清。
   * 主进程注入的说话钩子改成**打完字再计时**（见 src/server.js 的 MASCOT_PATCH），
   * 这里给的就是打完之后的停留时间。
   *
   * 声明放在使用点之前：本文件已经因为"const 声明晚于同步调用"踩过一次 TDZ
   * （见上面 ensureHud 的注释），不再赌调用时序。
   */
  const SAY_HOLD_MS = 5000;

  let balanceQueryPending = false;

  async function queryBalance(button) {
    if (balanceQueryPending) {
      return;
    }
    const enabled = (() => {
      try {
        return localStorage.getItem('whale-moe:balance') === '1';
      } catch (error) {
        return false;
      }
    })();
    const state = window.__dshWhaleMoeBalance;
    const amount = state ? Number(state.amount) : NaN;
    if (typeof api.say !== 'function') {
      api.log('error', '余额查询：预加载通道不可用');
      return;
    }

    let line;
    if (!enabled) {
      line = '余额查询还没启用呢，去设置里打开「显示余额」吧';
    } else if (!state || state.ok !== true || !Number.isFinite(amount)) {
      // 顺带报"最后一次成功时间"，和浮层的占位符口径一致：读不到 ≠ 余额是 0
      const hb = (window.__dshWhaleHeartbeat && window.__dshWhaleHeartbeat.balance) || null;
      const since = hb && hb.lastOkAt ? clockOf(hb.lastOkAt) : '';
      line = since
        ? `余额接口没有响应，鲸鲸查不到余额…上次成功是 ${since}。先看看设置里的余额接口吧`
        : '余额接口没有响应，鲸鲸查不到余额…先看看设置里的余额接口吧';
    } else {
      const core = window.DshWhaleMoeCore;
      const tier = core && core.formatBalance ? core.formatBalance(amount, state.currency, false) : state.tier;
      const today = typeof api.getTodayUsage === 'function' ? await api.getTodayUsage() : null;
      // 主进程按 mode 给数据：ledger=DSH 实时账本；diff=余额差额估算的降级
      let spent;
      if (!today) {
        spent = '今日消耗还没统计出来';
      } else if (today.mode === 'diff') {
        spent = `今日消费按余额差额估算约 ${today.costText} 元（未接 DSH 实时账本，仅供参考）`;
      } else if (today.mode === 'none') {
        spent = '今日消耗暂时还估算不出来';
      } else {
        spent = `今日共计消耗 ${today.tokensText} tokens，消费 ${today.costText} 元`;
      }
      line = `当前余额为 ${state.currency} ${amount.toFixed(2)}，状态为${tier || '未知'}，${spent}`;
    }

    // 查询期间按钮短暂禁用：播报是异步的（要等主进程回今日账本），连点会插队
    balanceQueryPending = true;
    if (button) {
      button.disabled = true;
    }
    try {
      await api.say(line, SAY_HOLD_MS);
      refreshHud();
    } catch (error) {
      api.log('error', '余额查询失败：' + error.message);
    } finally {
      balanceQueryPending = false;
      if (button) {
        button.disabled = false;
      }
    }
  }

  // ---------- 台词气泡：点一下提前收 ----------
  /**
   * 立刻收起台词气泡（提前看完的出路）。
   *
   * 动画与上游自己到点收起时完全一致：先淡出 200ms 再 hidden。
   * 上游到点收起要求"打字结束且没有排队的下一句"，这里只是把它提前。
   */
  function hideBubbleNow() {
    const bubble = document.querySelector('[data-dsh-whale-bubble]');
    if (!bubble || bubble.hidden || bubble.classList.contains('dsh-whale-out')) {
      return false;
    }
    bubble.classList.add('dsh-whale-out');
    window.setTimeout(() => {
      bubble.hidden = true;
      bubble.classList.remove('dsh-whale-out');
    }, 200);
    return true;
  }

  /*
   * 点一下就收。监听在 document 上：
   * 上游给桌宠根节点挂了 `click` → stopPropagation（见 vendor 第 417 行），
   * 所以能冒泡到 document 的点击**一定落在她以外**；点她身上另有互动台词会把气泡换掉。
   */
  document.addEventListener('click', () => {
    hideBubbleNow();
  });

  function refreshHud() {
    const hud = document.getElementById(HUD_ID);
    if (hud && hud.__refresh) {
      hud.__refresh();
    }
    // 顺带保证天气是新的（新鲜时零开销，直接返回）
    ensureWeatherFresh(false);
  }

  // 心跳层（src/pet/heartbeat.js）刷新完余额后要立刻让浮层重画。
  // 两个 IIFE 不互相 require，用 window 上挂一个入口即可。
  window.__dshWhaleRefreshHud = refreshHud;

  function setHudVisible(visible) {
    const hud = ensureHud();
    if (!hud) {
      return false;
    }
    hud.hidden = !visible;
    if (visible) {
      refreshHud();
      if (!hudTimer) {
        // 天气/余额是异步来的，浮层开着时定期刷一下；
        // 周期取 1 秒 —— 峰谷倒计时要逐秒走（与上游倒计时的 1000ms 一致）。
        hudTimer = window.setInterval(refreshHud, 1000);
      }
    } else if (hudTimer) {
      window.clearInterval(hudTimer);
      hudTimer = null;
    }
    return true;
  }

  // ---------- 悬浮直接显示 / 移开收起 ----------
  // 判定复用点击穿透的 hit（elementFromPoint 命中"她∪浮层"都算压到桌宠，
  // 因为浮层本身是 pointer-events:auto），所以鼠标从她身上挪到浮层上不会闪断，
  // 浮层上的按钮、行也照常可点（离开"她∪浮层"整体区域才会收起）。
  let hudHideTimer = null; // 离开区域后的防抖（避免透明窗口边缘抖动导致闪烁）
  let hoverSuppressed = false; // 点过她触发互动后，抑制"继续悬浮就弹回"
  let lastHoverHit = false;

  function hideHudSoon() {
    if (hudHideTimer) {
      return;
    }
    hudHideTimer = window.setTimeout(() => {
      hudHideTimer = null;
      setHudVisible(false);
    }, 250);
  }

  function syncHudWithHover(hit) {
    // 从"不在她身上"变成"在她身上"：允许显示（顺带解除上次点击的抑制）
    if (hit && !lastHoverHit) {
      hoverSuppressed = false;
    }
    lastHoverHit = hit;
    if (!hit) {
      // 离开"她∪浮层"区域 → 防抖收起；一旦离开，点击抑制也随之解除，
      // 下次再悬浮回来就能正常显示
      hoverSuppressed = false;
      hideHudSoon();
      return;
    }
    if (hudHideTimer) {
      window.clearTimeout(hudHideTimer);
      hudHideTimer = null;
    }
    if (hoverSuppressed) {
      return; // 刚点过她（触发了互动事件），鼠标不动就保持收起
    }
    setHudVisible(true);
  }

  // 点她本体（触发互动事件）→ 立即收起浮层，并抑制"悬浮立即弹回"。
  // 浮层内部（行/按钮）的点击放行给它们自己的处理（各有收起/跳转逻辑），
  // 但同样设抑制——否则点了「余额查询」之类跳转后，浮层会被轮询立刻重新顶出来。
  // 用捕获阶段：上游给 rootNode 挂了 stopPropagation，只有捕获阶段能提前看到
  // "点在她身上"这件事。点在浮层内用 DOM 包含关系放行。
  document.addEventListener(
    'click',
    (event) => {
      const hud = document.getElementById(HUD_ID);
      const target = event.target;
      if (target && typeof target.closest === 'function' && hud && hud.contains(target)) {
        // 触发浮层内的行/按钮 → 立即把浮层收起来，别挡着头顶冒出的气泡；
        // 同样设抑制，免得点完鼠标还停在原处，80ms 轮询把浮层又顶回来
        hoverSuppressed = true;
        if (!hud.hidden) {
          setHudVisible(false);
        }
        return;
      }
      hoverSuppressed = true;
      if (hud && !hud.hidden) {
        setHudVisible(false);
      }
    },
    true
  );

  // 点桌宠之外收起浮层（能冒泡到 document 的点击 = 点在桌宠之外）
  document.addEventListener('click', () => {
    const hud = document.getElementById(HUD_ID);
    if (hud && !hud.hidden) {
      setHudVisible(false);
    }
  });

  // 声明都已执行，这里可以安全地先建一次（桌宠根节点通常已经在了）
  ensureHud();
  // 启动时若已配了城市，先把天气拉一次，免得第一次打开浮层还要等
  window.setTimeout(() => ensureWeatherFresh(false), 1200);

  // ---------- 独立设置窗口改了偏好后，让上游重新读一遍 ----------
  // 两个窗口同源，所以走 storage 事件就够了，不需要额外 IPC。
  window.addEventListener('storage', (event) => {
    const key = event.key || '';
    if (!key.startsWith('whale-moe:')) {
      return;
    }
    // 城市/Key 变了就立刻重拉天气，别等她下次闲聊
    if (key === 'whale-moe:weatherCity' || key === 'whale-moe:weatherKey') {
      ensureWeatherFresh(true);
    }
    window.dispatchEvent(
      new CustomEvent('whale-moe-prefs-change', {
        detail: { key: key.slice('whale-moe:'.length), value: event.newValue },
      })
    );
  });

  // ---------- DSH 工作状态 → 上游信号合成 ----------
  // 上游判断"在忙"靠的是页面里存在这些 DOM 信号（只看存在性，不读业务文本）：
  //   thinking → [data-status="pending"]
  //   tool     → [data-running]   （detectToolPose 还会读它的 textContent 选具体姿势）
  //   success  → [data-state="success"]
  //   error    → [data-status="error"]
  //
  // 桌面版不在 DSH 页面里，拿不到这些节点，于是由壳层按主进程读到的 DSH 状态
  // **合成**它们 —— 上游一个字都不用改，状态机/立绘/状态签全部照原样复用。
  //
  // 合成节点必须满足上游 isVisible()：盒子 >1px、与视口相交、opacity 不能正好是 "0"。
  // 另外上游对 error 节点有"基线"机制：首次 reconcile 时已存在的错误节点会被当作
  // 历史记录忽略 —— 所以 error 节点必须**按需新建**、闪完即删，不能开机就摆着。
  const SIGNAL_HOST_ID = 'dsh-whale-shell-signals';

  /** DSH 工具名 → 上游关键词（顺序敏感：上游按 deploy/test/debug/search/write/bash/review/plan 依次匹配）。 */
  const TOOL_HINTS = Object.freeze({
    pwsh: 'bash shell 命令',
    bash: 'bash shell 命令',
    terminal: 'bash shell 命令',
    read: 'search grep 读取',
    glob: 'search glob 查找',
    grep: 'search grep 查找',
    write: 'write edit 写入',
    edit: 'write edit 修改文件',
    str_replace: 'write edit 修改文件',
    web_search: 'search 搜索',
    web_fetch: 'search 搜索',
    todo_write: 'plan todo 计划',
    create_goal: 'plan todo 计划',
    update_goal: 'plan todo 计划',
    subagent: 'plan 计划',
    workflow: 'plan 计划',
    present: 'write 写入',
    job_output: 'bash shell 命令',
  });

  const SIGNAL_ATTRS = Object.freeze({
    thinking: { 'data-status': 'pending' },
    tool: { 'data-running': '' },
    success: { 'data-state': 'success' },
    error: { 'data-status': 'error' },
  });
  const signalNodes = new Map();

  function ensureSignalHost() {
    let host = document.getElementById(SIGNAL_HOST_ID);
    if (host && host.isConnected) {
      return host;
    }
    host = document.createElement('div');
    host.id = SIGNAL_HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    // 透明、不可点、2x2 且贴在视口内 —— 只为满足上游 isVisible() 的存在性判定
    host.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;overflow:visible';
    document.body.appendChild(host);
    return host;
  }

  function setSignal(name, on, text) {
    const existing = signalNodes.get(name);
    if (!on) {
      if (existing) {
        existing.remove();
        signalNodes.delete(name);
      }
      return;
    }
    let node = existing;
    if (!node || !node.isConnected) {
      node = document.createElement('i');
      for (const [key, value] of Object.entries(SIGNAL_ATTRS[name])) {
        node.setAttribute(key, value);
      }
      node.style.cssText = 'display:block;width:2px;height:2px;opacity:0.01';
      ensureSignalHost().appendChild(node);
      signalNodes.set(name, node);
    }
    const next = typeof text === 'string' && text.length ? text : 'tool 工作中';
    if (node.textContent !== next) {
      node.textContent = next;
    }
  }

  function applyDshState(payload) {
    const state = payload && typeof payload.state === 'string' ? payload.state : 'idle';
    const tool = payload ? payload.tool : null;
    setSignal('thinking', state === 'thinking');
    setSignal('tool', state === 'tool', tool ? (TOOL_HINTS[tool] || String(tool)) : null);
    setSignal('success', state === 'success');
    setSignal('error', state === 'failure');
  }

  if (typeof api.onDshState === 'function') {
    api.onDshState((payload) => {
      try {
        applyDshState(payload);
      } catch (error) {
        api.log('error', 'applyDshState failed: ' + error.message);
      }
    });
  }

  // ---------- DSH 每轮战果 → 上游养成层 ----------
  /*
   * 「看到的消息条数 / 代码块数」这两项，上游靠**扫页面 DOM** 计数
   * （`[data-slot="conversation.chat.node"]` 与 `pre`·终端节点）。
   * 桌面版不在 DSH 页面里，那两路信号恒为 0 —— 每日任务「看 5 条会话消息」、
   * 成就「会话百条 / 消息五百条 / 代码初体验 / 代码狂人」于是永远不动
   * （实测踩到：DSH 跑一上午，抽到那条任务一直停在 0/5）。
   * 主进程读会话文件时本来就在数，每轮结束推一次；这里转手交给上游自己的
   * 记账函数（server.js 注入的钩子），养成规则一个字都没重写。
   */
  const dshProgressTotals = { messages: 0, codeBlocks: 0 };
  if (typeof api.onDshProgress === 'function') {
    api.onDshProgress((payload) => {
      if (!payload) return;
      const messages = Number(payload.messages) || 0;
      const codeBlocks = Number(payload.codeBlocks) || 0;
      try {
        if (messages > 0 && typeof window.__dshWhaleMoeCountMessages === 'function') {
          window.__dshWhaleMoeCountMessages(messages);
          dshProgressTotals.messages += messages;
        }
        if (codeBlocks > 0 && typeof window.__dshWhaleMoeCountCode === 'function') {
          window.__dshWhaleMoeCountCode(codeBlocks);
          dshProgressTotals.codeBlocks += codeBlocks;
        }
      } catch (error) {
        api.log('error', 'dsh progress → quests failed: ' + error.message);
      }
    });
  }

  // ---------- 上报桌宠矩形（供自检端点/自动化测试用）----------
  function reportRect() {
    const frame = document.querySelector('[data-dsh-whale-frame]');
    if (!frame) {
      return;
    }
    const r = frame.getBoundingClientRect();
    api.reportPetRect({
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      dpr: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      interactive,
      lastMouse,
      // 浮层内容也上报：主进程读不到渲染进程的 localStorage，
      // 把结果带出来才能在外部（/__shell/state）断言"天气/余额真的显示出来了"
      hud: {
        weather: hudReadWeather(),
        balance: hudReadBalance(),
        peak: hudReadPeak(),
      },
      /*
       * 说话钩子是否就位（server.js 注入的那一行）。上报它的理由和 hud 一样：
       * "花费播报"是主进程→页面的单向调用，页面没反应时无法从外部区分
       * "钩子没注入"和"话说出来了但看不见"，把可用性带出来就能一眼分辨。
       */
      sayHook: typeof window.__dshWhaleMoeSay === 'function',
      // 心跳层的两个补丁钩子 + 快照：和 sayHook 同理，把"钩子到底注入没有"
      // 和"这一分钟心跳干了什么"带出来，外部断言就不用猜。
      signinHook: typeof window.__dshWhaleMoeSigninToday === 'function',
      balanceSyncHook: typeof window.__dshWhaleMoeSyncBalance === 'function',
      heartbeat: window.__dshWhaleHeartbeat || null,
      /*
       * 闲时动作层（anims.js）的快照：把"DSH 干活时 lastTouch 有没有被刷新"带出来。
       *
       * 为什么要暴露它：入睡规则（30 分钟无互动）整条跑在渲染进程里，"她到底算不算睡了"
       * 只有这个内部量能回答 —— 否则只能靠肉眼看立绘，而"静止的工作姿势"和"睡觉"
       * 在小尺寸下几乎分不出来（这一条正是踩过的坑）。
       *   sleepInMs —— 距入睡还剩多少毫秒（负数=已过入睡点）
       */
      anim: window.__dshWhaleAnimDebug
        ? {
            lastTouch: window.__dshWhaleAnimDebug.lastTouch,
            sleepInMs: Math.round(window.__dshWhaleAnimDebug.sleepIn),
            active: window.__dshWhaleAnimDebug.active,
            busy: window.__dshWhaleAnimDebug.isBusy(),
            dshWorking: window.__dshWhaleAnimDebug.dshWorking,
          }
        : null,
      /*
       * 「DSH 每轮战果 → 养成层」这条链的可用性与累计量：
       * 钩子注入没有（上游锚点变了）、以及到底喂进去多少，外部一眼可辨 ——
       * 否则只能靠肉眼看任务栏，而任务栏要凑够 5 条才动，很难判断是"没喂"还是"还没到"。
       */
      questFeed: {
        countMessagesHook: typeof window.__dshWhaleMoeCountMessages === 'function',
        countCodeHook: typeof window.__dshWhaleMoeCountCode === 'function',
        fedMessages: dshProgressTotals.messages,
        fedCodeBlocks: dshProgressTotals.codeBlocks,
      },
    });
  }

  setInterval(reportRect, 2000);
  window.addEventListener('load', () => window.setTimeout(reportRect, 300));
})();
