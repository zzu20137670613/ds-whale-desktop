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

  /** 闲时动画时长：无互动多久后停播去睡觉（30 分钟） */
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

  let video = null; // <video> 覆盖层
  let timer = null; // 定时切下一段
  let afkTimer = null; // 后台 AFK 计时
  let lastTouch = Date.now(); // 上次互动
  let active = false;
  let visibility = false;

  function pickAction() {
    return ACTION_POOL[Math.floor(Math.random() * ACTION_POOL.length)];
  }

  function isVisible() {
    const fr = doc.querySelector('[data-dsh-whale-frame]');
    if (!fr) return false;
    const r = fr.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(fr).visibility !== 'hidden';
  }

  /** 桌宠当前是否在忙（上游 BUSY_STATES：thinking/tool/success/failure/curious…） */
  function isBusy() {
    const chip = doc.querySelector('[data-dsh-whale-chip]');
    if (chip) return true;
    const rootNode = doc.querySelector('[data-dsh-whale-root]');
    if (rootNode && rootNode.getAttribute('data-dsh-whale-busy') === 'true') return true;
    return false;
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
    // 每段播完不精确对齐；用固定间隔轮换，保证"一直在动"
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
  }

  function showLayer() {
    if (!video) return;
    video.classList.add('is-on');
    video.style.opacity = '1';
  }

  function hideLayer() {
    if (!video) return;
    video.classList.remove('is-on');
    video.style.opacity = '0';
  }

  /** 互动：重置 AFK 计时 + 回到活泼状态 */
  function touch() {
    lastTouch = Date.now();
    scheduleAfk();
    if (visibility && !isBusy()) {
      if (!active) {
        active = true;
        showLayer();
      }
      playNext();
    }
  }

  /** 后台 AFK 计时：到点停止随机动画（露出睡眠姿势） */
  function scheduleAfk() {
    if (afkTimer) root.clearTimeout(afkTimer);
    afkTimer = root.setTimeout(() => {
      active = false;
      pauseLayer();
      hideLayer();
      afkTimer = null;
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
    // 可见性轮询：窗口显示才播放
    setInterval(() => {
      const vis = isVisible();
      if (vis !== visibility) {
        visibility = vis;
        if (vis && active) { showLayer(); playNext(); }
        else if (!vis) pauseLayer();
      }
    }, 1500);

    // 互动监听（强互动 = 重置 30 分钟计时 + 唤醒活泼）
    const STRONG_EVENTS = ['pointerdown', 'touchstart', 'contextmenu', 'keydown'];
    STRONG_EVENTS.forEach((ev) => doc.addEventListener(ev, () => touch(), { capture: true, passive: true }));

    // 弱信号：鼠标在桌宠附近移动 = 人还在电脑前。不重置入睡计时（否则永不清醒），
    // 只在"已经睡着时"不做任何事——视觉上仍盖着视频；到点该睡还是睡。
    doc.addEventListener('pointermove', () => markPresence(), { capture: true, passive: true });

    // 上游说话 = 强互动
    doc.addEventListener('whale-moe-speak', () => touch(), true);

    // 工作态出现 → 立刻停（busy 轮询）
    setInterval(() => {
      if (!active) return;
      if (isBusy()) {
        pauseLayer();
        hideLayer();
        active = false;
      } else if (!afkTimer) {
        active = true;
        showLayer();
        playNext();
      }
    }, 2000);

    visibility = isVisible();
    active = true;
    showLayer();
    scheduleAfk();
    playNext();
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
    时节: ['被落叶淹没', '中秋赏月吃月饼', '堆雪人', '放烟花', '吃粽子', '吃年糕', '吃青团', '吃腊八粥', '吃重阳糕', '收红包', '写福字', '穿针乞巧', '舞狮头', '讨糖南瓜灯', '插茱萸赏菊', '放河灯', '萌化小幽灵', '装点圣诞树', '放孔明灯', '吃汤圆', '吃饺子'],
  };

  function playMenuAction(name) {
    active = true;
    showLayer();
    touch();
    if (!video) return;
    const url = ANIM_BASE + encodeURIComponent(name) + '.webm';
    video.dataset.current = name;
    video.src = url;
    video.load();
    video.play().catch(() => {});
  }

  /** 在菜单里插入「动作」按钮；点开后把菜单内容换成分类树（面包屑可返回） */
  function injectActionMenu(menu) {
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