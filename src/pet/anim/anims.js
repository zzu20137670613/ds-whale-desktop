'use strict';

/**
 * 闲时动作动画层（dsh-pet 移植）。
 *
 * 职责：让鲸鲸在【闲时】（无 DSH 任务、且距离上次互动 < 30 分钟）自动随机表演
 * dsh-pet 那套 webm 动作（原地小动作/玩耍/吃什么/时节/文字…），否则乖乖趴着睡觉。
 *
 * 设计要点：
 *  - 不碰 vendor（上游 dsh-whale-moe.js / whale-moe-core.js 只读）。
 *  - 在桌宠根节点上加一个绝对定位的 <video> 覆盖层，叠在 img 姿势层之上，
 *    GIF/视频式动画由 video 播放，上游照常驱动 webp 姿势（工作态/情绪依然存在底下）。
 *  - 随机链：定时随机抽下一段 webm 播放（等概率池），播完无缝接下一段——
 *    相当于 dsh-pet 的 rollKind(只保留 categories 小动作部分) + pickNext。
 *  - 互动判定：页面内的 pointerdown / contextmenu / keydown / 说话 → 重置后台计时。
 *    30 分钟（IDLE_ANIM_MS）无互动 → 停止随机动画，露出上游 afk/sleep 姿势。
 *  - 工作态（thinking/tool/success/failure 等）→ 立即停下，不跟工作抢画面。
 *
 * 挂在 <script src="/pet/anims.js"> ，页面加载后自行初始化。
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (!root.document) return;
  const doc = root.document;

  /** 3 分钟过渡期：刚唤醒/启动的头 3 分钟显示我们自己的 webp 姿势（不播 webm） */
  const OUR_FIRST_MS = 3 * 60 * 1000;
  const IDLE_ANIM_MS = 30 * 60 * 1000;

  /** 动画 URL 前缀（server.js 已把 /anim/* 映射到 src/pet/anim/） */
  const ANIM_BASE = '/anim/webm/';

  /** 随机动作分类与权重（对齐 dsh-pet assets/config.jsonc 的 categories，闲时全量） */
  const ACTION_POOL = [
    // 小动作
    '悠闲哼歌', '超大伸懒腰', '原地敲击桌面互动', '原地重力下蹲压缩', '哈欠连天',
    '原地小憩沉眠', '女仆屈膝礼仪', '被吓一跳', '小幅度原地360度旋转展示',
    '偷吃零食被抓住', '用鲸鱼尾巴拍打地面', '打瞌睡被惊醒', '照镜子', '整体换装试色',
    '轻快记录', '写代码', '摇扇纳凉', '晨间刷牙',
    // 玩耍
    '原地专心玩魔方', '原地蹲下玩玩具汽车', '鲸鱼吐泡泡特效', '原地跳跃抓碎头顶物品',
    '玩游戏气急败坏', '玩水枪', '小提琴演奏', '蓝鲸现世', '优雅女仆舞', '轻快摇摆舞',
    '可爱宅舞', '吹气球', '动物环绕', '放风筝', '拆礼物', '变鸽子', '扑克魔术',
    '抽陀螺', '吹笛子', '蝴蝶蜜蜂环绕头顶开花', '撸猫', '凭空生花', '骑木马',
    '三球抛接', '踢毽子', '下五子棋', '荡秋千',
    // 吃什么
    '吃白饭', '大口吃零食', '吃Token', '吃早餐', '吃午餐', '吃晚餐', '吃冰淇淋融化',
    '吃大闸蟹', '吃糖葫芦', '吃长寿面', '吃西瓜', '涮火锅',
    // 时节
    '被落叶淹没', '中秋赏月吃月饼', '堆雪人', '放烟花', '吃粽子', '吃年糕', '吃青团',
    '吃腊八粥', '吃重阳糕', '收红包', '写福字', '穿针乞巧', '舞狮头', '讨糖南瓜灯',
    '插茱萸赏菊', '放河灯', '萌化小幽灵', '装点圣诞树', '放孔明灯', '吃汤圆', '吃饺子',
  ];

  /**
   * 单个动作的额外权重（没写 = 1）。
   * 2026-10-17 用户要求：自动播放时「舞狮头」的出现频率高一些。
   * 这里给 5 倍 —— 全池 76 项、总权重 80，舞狮头占 6.25%，约每 16 段轮到一次
   * （13~25 秒一段 ≈ 5 分钟一次）。想更频繁直接调大这个数，不用动池子。
   */
  const ACTION_WEIGHT = { '舞狮头': 5 };

  let video = null; // <video> 覆盖层
  let timer = null; // 定时切下一段
  let afkTimer = null; // 后台 AFK 计时
  let lastTouch = Date.now(); // 上次互动
  let active = false;
  let visibility = false;
  let manualAt = 0; // 右键点播动作的时间戳：点播盖过「过渡期露立绘」，不被 idle 心跳打断
  const MANUAL_HOLD_MS = 60 * 1000; // 点播后 1 分钟内视为"手动播放中"
  const manualActive = () => Date.now() - manualAt < MANUAL_HOLD_MS;

  /*
   * 自检快照（与上游 __dshWhaleMoeDebug、心跳 __dshWhaleHeartbeat 同一约定）。
   * 入睡计时是"距上次互动的绝对时间差"，外部脚本没法真等 30 分钟来验证，
   * 只能把内部量读出来断言（比如"DSH 干活时 lastTouch 有没有被刷新"）。
   */
  window.__dshWhaleAnimDebug = {
    get lastTouch() { return lastTouch; },
    get sleepIn() { return IDLE_ANIM_MS - (Date.now() - lastTouch); },
    get active() { return active; },
    get manualActive() { return manualActive(); },
    /* IPC 直报的工作态（见 isBusy）。与 DOM 那份可能不同 —— 不同就说明 DOM 那路断了。 */
    get dshWorking() { return dshWorking; },
    /* 向上游转发"有人在活动"的累计次数：DSH 忙时它必须持续增长，
       否则说明上游的 afk 钳制没生效（人一旦闲置 3 分钟就会被放倒睡）。 */
    get activityFeeds() { return activityFeeds; },
    overSleep,
    isBusy,
    idleMs: IDLE_ANIM_MS,
    ourFirstMs: OUR_FIRST_MS,
  };

  /** 加权抽取：默认每条 1 份，ACTION_WEIGHT 里写了的按倍数算（舞狮头 5 倍） */
  function pickAction() {
    let total = 0;
    for (const name of ACTION_POOL) total += ACTION_WEIGHT[name] || 1;
    let roll = Math.random() * total;
    for (const name of ACTION_POOL) {
      roll -= ACTION_WEIGHT[name] || 1;
      if (roll < 0) return name;
    }
    return ACTION_POOL[ACTION_POOL.length - 1]; // 浮点误差兜底
  }

  function isVisible() {
    const fr = doc.querySelector('[data-dsh-whale-frame]');
    if (!fr) return false;
    const r = fr.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(fr).visibility !== 'hidden';
  }

  /**
   * DSH 是否正在干活。**直接从主进程的 IPC 拿**（whaleShell.onDshState），
   * 而不是只靠上游渲染出来的 `data-dsh-whale-busy` / 状态签。
   *
   * 为什么要多这一路：上游那份标记是它 `reconcile()` 的产物，而我们够不着它的渲染时机——
   * 它节流、或者 render 抛错后（`safeReconcile` 会 disconnect observer 并移除根节点）
   * 就再也不会更新，`data-dsh-whale-busy` 会永远停在错的值上，**而且不报错**。
   * 那时"DSH 在干活"这件事在页面里就凭空消失了，桌宠只会一路睡过去。
   * 直接订阅 IPC 就没有这个中间环节：状态一到就复位入睡计时。
   */
  let dshWorking = false;
  /** 已向上游转发的「有人在活动」次数（钳制 afk 用）。只用于自检断言。 */
  let activityFeeds = 0;

  /** 桌宠当前是否在忙（上游 BUSY_STATES：thinking/tool/success/failure/curious…） */
  function isBusy() {
    if (dshWorking) return true;
    const chip = doc.querySelector('[data-dsh-whale-chip]');
    if (chip) return true;
    const rootNode = doc.querySelector('[data-dsh-whale-root]');
    if (rootNode && rootNode.getAttribute('data-dsh-whale-busy') === 'true') return true;
    return false;
  }

  /*
   * 干活即互动：DSH 一进入工作态就**立刻**复位入睡计时，
   * 不等 1.5s 心跳、也不等上游把它渲染成 DOM 标记。
   * 空闲（idle/hidden）才放行，让 30 分钟静默计时正常往下走。
   */
  const shellApi = root.whaleShell;
  if (shellApi && typeof shellApi.onDshState === 'function') {
    shellApi.onDshState((payload) => {
      const st = payload && payload.state;
      dshWorking = Boolean(st) && st !== 'idle' && st !== 'hidden';
      if (dshWorking) {
        lastTouch = Date.now();
        if (!afkTimer) scheduleAfk();
      }
    });
  }

  function playNext() {
    if (!active || !visibility) return;
    if (isBusy()) {
      pauseLayer();
      scheduleAfk();
      return;
    }
    if (!video) return;
    const name = pickAction();
    const url = ANIM_BASE + encodeURIComponent(name) + '.webm';
    if (video.dataset.current !== name) {
      video.dataset.current = name;
      video.src = url;
      video.load();
    }
    video.play().catch(() => {});
    if (timer) root.clearTimeout(timer);
    // 每段 13~25 秒随机轮换，保证"一直在动"又不急促
    timer = root.setTimeout(playNext, 13000 + Math.random() * 12000);
  }

  function pauseLayer() {
    if (timer) { root.clearTimeout(timer); timer = null; }
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.dataset.current = '';
      video.classList.remove('is-on');
    }
    showFrame();
  }

  function showLayer() {
    if (!video) return;
    video.classList.add('is-on');
    video.style.opacity = '1';
    // 互斥显示：webm 播放时隐藏上游 img 姿势层，避免两张叠着
    hideFrame();
  }

  function hideLayer() {
    if (!video) return;
    video.classList.remove('is-on');
    video.style.opacity = '0';
    showFrame();
  }

  /** 隐藏上游 img 姿势层（webm 盖住时它必须消失——互斥） */
  function hideFrame() {
    const frame = doc.querySelector('[data-dsh-whale-frame]');
    if (frame) frame.style.opacity = '0';
  }

  /** 恢复上游 img 姿势层显示（webm 退出/入睡时露出我们自己的 webp） */
  function showFrame() {
    const frame = doc.querySelector('[data-dsh-whale-frame]');
    if (frame) frame.style.opacity = '';
  }

  /** 互动：重置 AFK 计时 + 回到活泼状态（过渡期内仍显示我们的姿势） */
  function touch() {
    lastTouch = Date.now();
    scheduleAfk();
    // 唤醒：隐藏 webm、露出我们的姿势（若刚才在播则停掉）
    if (active) {
      active = false;
      pauseLayer();
      hideLayer();
    }
    // 3 分钟后由心跳自动接过开播（这里不主动 playNext）
  }

  /** 是否已过入睡点（超过 30 分钟无互动） */
  function overSleep() {
    return Date.now() - lastTouch >= IDLE_ANIM_MS;
  }

  /** 后台 AFK 计时：到点停止随机动画（露出睡眠姿势） */
  function scheduleAfk() {
    if (afkTimer) root.clearTimeout(afkTimer);
    afkTimer = root.setTimeout(() => {
      afkTimer = null;
      // 到点再确认一次"真的静默够久"：期间若被人互动、或 DSH 一直在干活
      // （见心跳里的 busy 分支会刷新 lastTouch），这里就不该睡。
      if (!overSleep()) return;
      active = false;
      pauseLayer();
      hideLayer();
    }, IDLE_ANIM_MS);
  }

  function ensureVideo() {
    if (video && video.isConnected) return;
    const rootNode = doc.querySelector('[data-dsh-whale-root]');
    const frame = doc.querySelector('[data-dsh-whale-frame]');
    if (!rootNode || !frame) return;
    video = doc.createElement('video');
    video.className = 'shell-anim-video';
    video.setAttribute('data-shell-anim', 'true');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    rootNode.appendChild(video);
  }

  /** 观察桌宠根节点出现（上游异步挂载） */
  function start() {
    ensureVideo();
    if (!video) {
      const mo = new MutationObserver(() => {
        ensureVideo();
        if (video) { mo.disconnect(); boot(); }
      });
      mo.observe(doc.body, { childList: true, subtree: true });
      return;
    }
    boot();
  }

  function boot() {
    // 统一心跳（1.5s）：维护 可见性 / 忙闲 / 过渡期 / 入睡点 → 决定 播/停/睡
    setInterval(() => {
      const vis = isVisible();
      const busy = isBusy();
      /*
       * DSH 干活也算「互动」：上游 thinking / tool / success / failure 都是她在被调用，
       * 不是"没人理她"。若不刷新入睡计时，一个长任务跑满 30 分钟她就会睡着。
       *
       * 用 busy 而不是"只听花费播报"：她播报本次花费恰好发生在任务收尾（success 态），
       * 所以这一条已覆盖那个触发点，并且额外覆盖了花费低于播报阈值（不播报）的小任务。
       *
       * afkTimer 已在到点时把自己清空（null），这里补挂一次，保持"静默计时"常驻。
       */
      if (busy) {
        lastTouch = Date.now();
        if (!afkTimer) scheduleAfk();
        /*
         * 把「机器在干活」折算成「人在活动」，喂给上游。
         *
         * 上游自己还有一条**独立的** afk 判定（AFK_MS = 3 分钟），
         * 它只认真实指针/键盘（见 vendor start() 里挂的 onUserActivity），
         * DSH 干活不算 —— 于是她连着跑几分钟、turn 一停，立刻被放倒睡
         * （"ZZZ……梦里也在帮主人数 bug🐑"）。**那才是"干活时她还在睡"的真身**，
         * 和我们这条 30 分钟入睡计时是两套机制，必须都管住。
         * 1.5 秒喂一次，远密于 3 分钟的阈值，中间任何 turn 间隙都盖得住。
         */
        if (typeof root.__dshWhaleMoeUserActivity === 'function') {
          root.__dshWhaleMoeUserActivity();
          activityFeeds += 1;
        }
      }
      const sleep = overSleep();
      const inOurPhase = Date.now() - lastTouch < OUR_FIRST_MS; // 唤醒/启动后头 3 分钟
      if (vis !== visibility) {
        visibility = vis;
        if (!vis) { pauseLayer(); return; }
      }
      if (!visibility) return;
      if (busy || sleep) {
        // 忙 / 已过入睡点：露出上游姿势（我们自己的 webp / afk / sleep）——工作与睡觉永远优先
        if (active) { active = false; pauseLayer(); hideLayer(); }
        return;
      }
      // 过渡期（唤醒/启动后头 3 分钟）露立绘；但【右键点播】盖过它——
      // 用户明确要看某段动作时，1 分钟内不让心跳把它打断
      if (inOurPhase && !manualActive()) {
        if (active) { active = false; pauseLayer(); hideLayer(); }
        return;
      }
      // 闲且活跃：确保播放
      if (!active) { active = true; showLayer(); }
      if (!timer) playNext();
    }, 1500);

    // 互动监听（强互动 = 重置 30 分钟计时 + 唤醒活泼）
    const STRONG_EVENTS = ['pointerdown', 'touchstart', 'contextmenu', 'keydown'];
    STRONG_EVENTS.forEach((ev) => doc.addEventListener(ev, () => touch(), { capture: true, passive: true }));

    // 弱信号：鼠标在桌宠附近移动 = 人还在电脑前。不重置入睡计时（否则永不清醒），
    // 只在"已经睡着时"不做任何事——视觉上仍盖着视频；到点该睡还是睡。
    doc.addEventListener('pointermove', () => markPresence(), { capture: true, passive: true });

    // 上游说话 = 强互动
    doc.addEventListener('whale-moe-speak', () => touch(), true);

    visibility = isVisible();
    scheduleAfk();
    // 初始若闲且活跃则立即开播（busy 由心跳接管暂停）
    if (visibility && !isBusy() && !overSleep()) {
      active = true;
      showLayer();
      playNext();
    }
  }

  // 弱信号占位：鼠标移动只证明"人在"，但不动入睡计时（保留，防止未来扩展时误用）
  let lastPresence = 0;
  function markPresence() {
    const now = Date.now();
    if (now - lastPresence < 10000) return;
    lastPresence = now;
  }

  // DOM ready 后启动
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  /* ================= 右键菜单「动作」注入 =================
     上游菜单是 button 列表（纯平铺）。我们往列表里插入一个「动作」按钮，
     点开后展开 dsh-pet 的分类树（动作 → 分类 → 具体动作）。点具体动作
     立刻播放该段 webm（与随机链同一播放层，点播优先级更高）。
     不碰 vendor：全部在壳层把菜单 DOM 改出来。 */
  const MENU_SELECTOR = '[data-dsh-whale-context]';
  const ACTION_MENU = {
    待机: ['待机呼吸休闲'],
    转向: ['东张西望'],
    拖拽: ['被鼠标拖拽悬空反馈'],
    点击回应: ['点击回应-开心跃动', '点击回应-害羞惊讶', '点击回应-傲娇生气', '点击回应-挠痒咯咯笑', '点击回应-元气挥手'],
    移动: ['螃蟹走路', '原地漂浮踏步', '原地左转奔跑'],
    小动作: ['悠闲哼歌', '超大伸懒腰', '原地敲击桌面互动', '原地重力下蹲压缩', '哈欠连天', '原地小憩沉眠', '女仆屈膝礼仪', '被吓一跳', '小幅度原地360度旋转展示', '偷吃零食被抓住', '用鲸鱼尾巴拍打地面', '打瞌睡被惊醒', '照镜子', '整体换装试色', '轻快记录', '写代码', '摇扇纳凉', '晨间刷牙'],
    玩耍: ['原地专心玩魔方', '原地蹲下玩玩具汽车', '鲸鱼吐泡泡特效', '原地跳跃抓碎头顶物品', '玩游戏气急败坏', '玩水枪', '小提琴演奏', '蓝鲸现世', '优雅女仆舞', '轻快摇摆舞', '可爱宅舞', '吹气球', '动物环绕', '放风筝', '拆礼物', '变鸽子', '扑克魔术', '抽陀螺', '吹笛子', '蝴蝶蜜蜂环绕头顶开花', '撸猫', '凭空生花', '骑木马', '三球抛接', '踢毽子', '下五子棋', '荡秋千'],
    吃什么: ['吃白饭', '大口吃零食', '吃Token', '吃早餐', '吃午餐', '吃晚餐', '吃冰淇淋融化', '吃大闸蟹', '吃糖葫芦', '吃长寿面', '吃西瓜', '涮火锅'],
    时节: ['被落叶淹没', '中秋赏月吃月饼', '堆雪人', '放烟花', '吃粽子', '吃年糕', '吃青团', '吃腊八粥', '吃重阳糕', '收红包', '写福字', '穿针乞巧', '讨糖南瓜灯', '插茱萸赏菊', '放河灯', '萌化小幽灵', '装点圣诞树', '放孔明灯', '吃汤圆', '吃饺子'],
  };

  function playMenuAction(name) {
    // 右键点播 = 用户明确要看这个动作：重置入睡计时（点播也是互动），
    // 标记"手动播放中"盖过过渡期，然后立刻把这段 webm 显示出来。
    // 注意：这里**不能**走 touch()——touch() 是"互动即停动画、露出立绘"的
    // 反向逻辑，它会把 active 置 false 并把刚 Show 出来的图层又 hide 掉
    // （这正是"点播了动作却只看到立绘"的根因）。
    lastTouch = Date.now();
    scheduleAfk();
    manualAt = Date.now();
    active = true;
    showLayer();
    if (!video) return;
    const url = ANIM_BASE + encodeURIComponent(name) + '.webm';
    video.dataset.current = name;
    video.src = url;
    video.load();
    video.play().catch(() => {});
    if (timer) root.clearTimeout(timer);
    // 点播也走随机链节奏：13~25 秒后由下一段随机动作接班
    timer = root.setTimeout(playNext, 13000 + Math.random() * 12000);
  }

  /** 顶层快捷项：「舞狮头」已从「时节」分类抽出，单独放在菜单最上面 */
  const LION_DANCE = '舞狮头';

  /**
   * 往上游菜单插一条「舞狮头」，位置固定在**第一项**（即上游「投喂小点心」之上）。
   * 幂等：同一次菜单只插一次；分类树里不插（树里是动作列表，不该混进顶层项），
   * 点「◀ 返回」重建菜单时会重新补上。
   */
  function injectLionDanceItem(menu) {
    if (menu.querySelector('[data-shell-lion-dance]')) return;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = `🦁 ${LION_DANCE}`;
    btn.setAttribute('data-shell-lion-dance', 'true');
    btn.addEventListener('click', (event) => {
      // 与「动作」菜单里点动作同一条路：停掉菜单的事件冒泡，关菜单，直接播这段 webm
      event.stopPropagation();
      menu.remove();
      playMenuAction(LION_DANCE);
    });
    const first = menu.querySelector('button');
    if (first) menu.insertBefore(btn, first);
    else menu.appendChild(btn);
  }

  /** 在菜单里插入「动作」按钮；点开后把菜单内容换成分类树（面包屑可返回） */
  function injectActionMenu(menu) {
    injectLionDanceItem(menu);
    if (menu.querySelector('[data-shell-action-menu]')) return;
    const actionBtn = doc.createElement('button');
    actionBtn.type = 'button';
    actionBtn.textContent = '动作 ▸';
    actionBtn.setAttribute('data-shell-action-menu', 'true');
    // 兜底：确保上游菜单不再自己弹新菜单（上游点任意 button 即关闭；这里 stopPropagation 保留我们的树）
    actionBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      buildActionTree(menu);
    });
    // 插到「回到原位」之前（紧跟互动项后面）
    const homeBtn = Array.from(menu.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '回到原位');
    if (homeBtn) menu.insertBefore(actionBtn, homeBtn);
    else menu.appendChild(actionBtn);
  }

  function buildActionTree(menu) {
    // 旧内容清掉（保留「关闭菜单」）
    const closeBtn = Array.from(menu.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '关闭菜单');
    Array.from(menu.querySelectorAll('button')).forEach((b) => b.remove());
    const cats = Object.keys(ACTION_MENU);
    // 面包屑「返回」
    const back = doc.createElement('button');
    back.type = 'button';
    back.textContent = '◀ 返回';
    back.addEventListener('click', (event) => { event.stopPropagation(); closeBtn && closeBtn.remove(); buildActionMenu(menu); });
    menu.appendChild(back);
    cats.forEach((cat) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = `${cat} ▸`;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        showCategory(menu, cat);
      });
      menu.appendChild(btn);
    });
    if (closeBtn) menu.appendChild(closeBtn);
    // 菜单可能被越界修正观察器重新夹取，这里交给现有的 watchMenu 逻辑
  }

  function showCategory(menu, cat) {
    const actions = ACTION_MENU[cat] || [];
    const closeBtn = Array.from(menu.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '关闭菜单');
    Array.from(menu.querySelectorAll('button')).forEach((b) => b.remove());
    const back = doc.createElement('button');
    back.type = 'button';
    back.textContent = '◀ 返回';
    back.addEventListener('click', (event) => { event.stopPropagation(); closeBtn && closeBtn.remove(); buildActionMenu(menu); });
    menu.appendChild(back);
    actions.forEach((name) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = name;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        menu.remove();
        playMenuAction(name);
      });
      menu.appendChild(btn);
    });
    if (closeBtn) menu.appendChild(closeBtn);
  }

  function buildActionMenu(menu) {
    injectActionMenu(menu);
  }

  // 监听上游菜单出现（与 shell.js 的 watchMenu 同机制，互不冲突）
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches(MENU_SELECTOR)) injectActionMenu(node);
        else if (node.querySelectorAll) node.querySelectorAll(MENU_SELECTOR).forEach(injectActionMenu);
      }
    }
  }).observe(doc.body, { childList: true, subtree: true });
})();