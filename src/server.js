'use strict';

/**
 * 极简本地静态服务器。
 *
 * 为什么需要它：桌宠本体里的资源路径是写死的绝对路径
 *   ASSET_ROOT = "/assets/generated/"   ANIM_ROOT = "/assets/anim/"
 *   fetch("/assets/peek-calibration.json")
 * 上游 DSH 插件是靠「取到脚本文本 → 字符串替换路径 → 注入页面」来搬家的。
 * 我们不做替换，而是**把 /assets/* 原样映射到 vendor/whale/**，
 * 于是脚本一个字都不用改，上游升级后直接覆盖 vendor 即可。
 *
 * 走 http://127.0.0.1:<port> 而不是 file:// 还有一个原因：
 * 桌宠的养成数据存在 localStorage，file:// 是不透明源、localStorage 不可靠，
 * 而固定的 http 源可以让存档长期稳定。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 解析并确保目标仍在 root 之内，防目录穿越。 */
function safeJoin(root, rel) {
  const target = path.normalize(path.join(root, rel));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function sendFile(res, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    // 本地挂件，缓存激进一点无所谓；改了文件重启即可
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

/**
 * 给上游桌宠脚本打**一段**运行时补丁，对外暴露"让她说指定台词"的入口。
 *
 * 上游没有对外暴露说话钩子（内部只有 `showLineNow(line)`），而"本次任务花费"、
 * "余额查询"这类动态台词必须能主动让她开口。做法与上游自己的 DSH 插件一致：
 * 取文本 → 字符串替换 → 再交给浏览器 —— **磁盘上的 vendor/whale 一个字都不改**，
 * 所以 `npm run sync:upstream` 不会把补丁冲掉。
 *
 * 补丁做三件事：
 *   1. `__dshWhaleMoeSay(line, holdMs)` —— 说话；
 *   2. **打完字之后**才开始算停留时间。上游是"开始说话时"就设 4.5 秒的到期时间，
 *      而台词是逐字打的（标点 260ms、每 5 字 130ms、其余 64ms），
 *      像余额播报那样四十多字的句子光打字就要 4 秒多 —— 打完基本就到点了，
 *      于是长句几乎看不清。这里改成等 `typingTimer` 空了再计时。
 *   3. `__dshWhaleMoeSigninToday()` / `__dshWhaleMoeSyncBalance()` —— 跨天补签与余额同步，
 *      给 src/pet/heartbeat.js 的心跳层调用。上游的签到是 `if (!memory.lastGrowthTick)`
 *      即**一个进程只签一次**，长驻进程跨天永远不会补签；这里把上游自己的那段逻辑
 *      （applyGrowth + applyQuestSignal + syncWeekSignin）原样暴露出来，心跳按绝对日期补判。
 *
 * 锚点 `root.__dshWhaleMoeStarted = true;` 在 start() 里且全文唯一；
 * 万一上游改掉了这个锚点，这里会原样返回并把 patched 标成 false，
 * 页面上 `__dshWhaleMoeSay` 就不存在 —— 调用方据此降级，不会静默出错。
 */
const MASCOT_PATCH_ANCHOR = 'root.__dshWhaleMoeStarted = true;';
const MASCOT_PATCH = `/* shell-patched: 说话钩子（holdMs = 打完字后停留多久） */
    root.__dshWhaleMoeSay = function (line, holdMs) {
      showLineNow(line);
      var hold = Number(holdMs) > 0 ? Number(holdMs) : 4500;
      if (root.__dshWhaleMoeBubbleHold) root.clearInterval(root.__dshWhaleMoeBubbleHold);
      root.__dshWhaleMoeBubbleHold = root.setInterval(function () {
        if (typingTimer) return;
        root.clearInterval(root.__dshWhaleMoeBubbleHold);
        root.__dshWhaleMoeBubbleHold = null;
        memory.bubbleHideAt = Date.now() + hold;
      }, 120);
    };
    /* shell-patched: 跨天补签（心跳层调用；复用上游自己的签到逻辑，不重写养成规则） */
    root.__dshWhaleMoeSigninToday = function () {
      try {
        if (!growth) loadGrowth();
        var now = Date.now();
        var today = dayKeyOf(now);
        if (growth.lastSignin === today) {
          saveGrowth(); /* 内存已是今天、磁盘可能落后：顺手补写一次，避免心跳反复重试 */
          return { ok: true, already: true, date: today, streak: growth.signinStreak };
        }
        var out = applyGrowth({ type: "signin" }, now, 0);
        applyQuestSignal("signin", 1);   /* 任务池的「今日签到」；只在跨天那一刻调，不会重复加 */
        syncWeekSignin(now);
        saveGrowth();
        if (out && out.unlocks && out.unlocks.length) announceUnlocks(out.unlocks);
        return { ok: true, signed: true, date: today, streak: growth.signinStreak };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    };
    /* shell-patched: 余额同步（心跳层调用；复用上游 applyBalancePayload，保证形状一致） */
    root.__dshWhaleMoeSyncBalance = function () {
      return new Promise(function (resolve) {
        try {
          if (!balanceEnabled()) { resolve({ ok: false, reason: "disabled" }); return; }
          balanceState.at = Date.now(); /* 与上游共用节流时间：和它自己的 60 秒轮询不会重复拉 */
          root.fetch(BALANCE_ENDPOINT, { cache: "no-store", credentials: "omit" })
            .then(function (res) {
              if (!res || !res.ok) throw new Error("http-" + (res ? res.status : "none"));
              return res.json();
            })
            .then(function (data) {
              applyBalancePayload(data);
              if (!balanceState.ok) throw new Error("payload-not-ok");
              resolve({ ok: true, amount: balanceState.amount, currency: balanceState.currency, tier: balanceState.tier, at: balanceState.at });
            })
            .catch(function (e) { resolve({ ok: false, reason: String((e && e.message) || e) }); });
        } catch (e) {
          resolve({ ok: false, reason: String((e && e.message) || e) });
        }
      });
    };
    /* shell-patched: DSH 干活也算「有人在」——抑制上游的 3 分钟 afk。
       上游的 onUserActivity 只挂 pointerdown / keydown（见 vendor 的 start()），
       于是 DSH 连着跑几分钟、turn 一停，lastInteraction 早就过期，
       她立刻进 afk（"ZZZ……梦里也在帮主人数 bug🐑"）—— 那副样子就是用户看到的"睡觉"。
       壳层在 DSH 工作态期间周期性转发这里，把"机器在干活"折算成"人在活动"。
       转发的是上游自己的 onUserActivity（只更新 lastInteractionAt + schedule），不重写规则。 */
    root.__dshWhaleMoeUserActivity = function () {
      try { onUserActivity(); } catch (e) { /* ignore */ }
    };
    /* shell-patched: 把「这一轮看到了多少会话消息 / 代码块」记进养成层。
       上游这两项靠数页面 DOM 计数（[data-slot="conversation.chat.node"] 与 pre·终端节点），
       而桌面版不在 DSH 页面里，那两路信号**恒为 0** —— 于是每日任务「看 5 条会话消息」
       和成就「会话百条 / 消息五百条 / 代码初体验 / 代码狂人」在桌面版永远完不成
       （实测踩到：DSH 跑一上午，抽到那条任务一直停在 0/5）。
       主进程读会话文件时本来就在数（见 src/dsh-state.js 的 turnUsage），
       这里只把**上游自己的两个记账函数**转出来复用：addUsageStat 会顺带结算成就，
       applyQuestSignal 负责推进每日任务 —— 不重写任何养成规则。 */
    root.__dshWhaleMoeCountMessages = function (n) {
      var amount = Math.max(0, Number(n) || 0);
      if (!amount) return;
      try { addUsageStat("messages", amount); } catch (e) { /* ignore */ }
      try { applyQuestSignal("messages", amount); } catch (e) { /* ignore */ }
    };
    root.__dshWhaleMoeCountCode = function (n) {
      var amount = Math.max(0, Number(n) || 0);
      if (!amount) return;
      try { addUsageStat("code", amount); } catch (e) { /* ignore */ }
      try { applyQuestSignal("code", amount); } catch (e) { /* ignore */ }
    };
    /* shell-patched: 触发词彩蛋（2026-10-19）——
       ① 两个小游戏结算时按 galgame 同一套规则给触发词：戳泡泡 > 999 给番外词，
          接点心 > 666 给隐藏词。「过线」= 严格大于；每过线一次按顺序给下一条，
          三条走完从头循环。通关次数存 localStorage「whale-moe:tipUnlocks」，
          与上游自己的游戏统计同源（都在页面 storage 里）。
          只说不弹窗：结算后气泡一句话 —— 用户明确要求桌宠这边「只用气泡说一句」。
       ② 尾巴三下彩蛋：上游只在非忙态给 tailReact（单击甩尾），**从不计数**；
          这里照抄「摸头三下」的判定（2 秒内 3 下、2.6 秒冷却），第三下说专属台词，
          并跳过原 tailReact —— 否则两句会挤在同一个单槽气泡里互相覆盖。
          zones 偏好关闭时不做判定（与上游「分区反应」开关保持一致）。
       ③ 想改词表/分数线，只动下面两张表；别去改 vendor。 */
    var __shellTipWords = {
      extra: ["今天营业吗", "岁月静好", "一夜鱼龙舞", "白米饭"],
      hidden: [
        "Claude的图书馆借阅证",
        "gpt小龙娘的天空之城龙王宝座",
        "最后一段隐藏剧情要自己探索哦，提示：与深海有关"
      ]
    };
    var __shellTipTarget = { extra: 999, hidden: 666 };
    function __shellTipLoad() {
      try {
        var raw = root.localStorage.getItem("whale-moe:tipUnlocks");
        var data = raw ? JSON.parse(raw) : null;
        return {
          extra: Math.max(0, Math.floor(Number(data && data.extra) || 0)),
          hidden: Math.max(0, Math.floor(Number(data && data.hidden) || 0))
        };
      } catch (e) {
        return { extra: 0, hidden: 0 };
      }
    }
    function __shellTipSave(counts) {
      try { root.localStorage.setItem("whale-moe:tipUnlocks", JSON.stringify(counts)); } catch (e) { /* ignore */ }
    }
    function __shellTipResult(kind, score) {
      var words = __shellTipWords[kind];
      if (!words) return __shellTipLoad();
      var target = __shellTipTarget[kind];
      var n = Math.max(0, Math.floor(Number(score) || 0));
      var counts = __shellTipLoad();
      if (n > target) {
        counts[kind] += 1;
        __shellTipSave(counts);
        var word = words[(counts[kind] - 1) % words.length];
        __shellSayImportant(
          (kind === "extra" ? "戳泡泡 " : "接点心 ") + n + " 分，过线啦！" +
          (kind === "extra" ? "番外" : "隐藏") + "触发词送你：「" + word + "」"
        );
      } else {
        /* 没过线也给一句具体差距：999 不是随手能到的数，没反馈会以为坏了 */
        __shellSayImportant("还差 " + (target + 1 - n) + " 分就到 " + target + " 了，再来一局嘛～");
      }
      return counts;
    }
    var __shellEndGame = endGame;
    endGame = function (result) {
      var score = result ? result.score : 0;
      __shellEndGame(result);
      try { __shellTipResult("extra", score); } catch (e) { /* ignore */ }
    };
    var __shellEndCatchGame = endCatchGame;
    endCatchGame = function (result) {
      var score = result ? result.score : 0;
      __shellEndCatchGame(result);
      try { __shellTipResult("hidden", score); } catch (e) { /* ignore */ }
    };
    var __shellTailHistory = [];
    var __shellTailLastTripleAt = 0;
    /* 0.8 秒冷却：只用来吞掉「同一串连点里的第 4~6 下」，避免一次猛点触发两遍。
       上游摸头用的是 2.6 秒，但那是庆祝动作的节奏；尾巴彩蛋用户要求“三下就再来一次”，
       2.6 秒会让人觉得「第一次之后就不灵了」。 */
    var __shellTailCooldownMs = 800;
    /* shell-patched: 尾尖命中区收窄 —— 上游 HIT_ZONES.full 把「底边整条」
       （x 0~1、y 0.78~1）都算成尾巴，实际盖住裙子下摆到脚底（用户反馈"像裙底"）。
       收窄成「横 2 × 竖 3」网格的最右下一格（x>=0.5, y>=0.66）：尾鳍正好在这一格；
       同一条底边里偏左的点击退回普通摸头（与上游未命中的兜底一致）。 */
    var __shellResolveHitZone = resolveHitZone;
    resolveHitZone = function (clientX, clientY, rootNode) {
      var zone = __shellResolveHitZone(clientX, clientY, rootNode);
      if (zone !== "tail") return zone;
      var rect = rootNode.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return zone;
      var nx = (clientX - rect.left) / rect.width;
      var ny = (clientY - rect.top) / rect.height;
      var narrowed = (nx >= 0.5 && ny >= 0.66) ? "tail" : "head";
      try { rootNode.setAttribute("data-dsh-whale-zone", narrowed); } catch (e) { /* ignore */ }
      return narrowed;
    };
    var __shellPatMascot = patMascot;
    patMascot = function (zone) {
      var busyNow = BUSY_STATES[memory.state.state] === 1;
      if (zone === "tail" && readPref("zones")) {
        var now = Date.now();
        if (now >= celebrateUntil) {
          if (now - __shellTailLastTripleAt >= __shellTailCooldownMs) {
            __shellTailHistory = __shellTailHistory.filter(function (t) { return now - t < 2000; });
            __shellTailHistory.push(now);
            if (__shellTailHistory.length >= 3) {
              __shellTailHistory = [];
              __shellTailLastTripleAt = now;
              applyGrowth({ type: "tail" }, now, 0);
              showMood("react-tail", 2600, true);
              emojiBurst(["🌀", "💨"]);
              __shellSayImportant("哎呀，讨厌啦！我投降我老实交代：[深海回响]里羞羞剧情的触发词是[一夜鱼龙舞]");
              reconcile();
              return;
            }
          } else {
            /* 冷却期内的点击不计数：否则上一轮的尾巴点击会残留下来，
               和下一轮拼成“假三连”，表现为时灵时不灵。 */
            __shellTailHistory = [];
          }
        }
        /* 忙态下上游不会走 tailReact 的早退，而是把尾巴点击当普通摸摸计入 patHistory；
           这些记录会攒成“摸头三连”，一触发就进 2.2 秒庆祝期，把尾巴三连挡掉。
           这里把本次新加的那一条摘掉，只影响计数，不影响她显示的忙态反应。 */
        var prevLast = patHistory[patHistory.length - 1];
        var out = __shellPatMascot(zone);
        if (busyNow && patHistory.length && patHistory[patHistory.length - 1] !== prevLast) {
          patHistory.pop();
        }
        return out;
      }
      return __shellPatMascot(zone);
    };
    /* 自检钩子：只读进度 / 模拟一局结算（probe 用，正常流程不会调） */
    root.__dshWhaleMoeTipState = function () { return __shellTipLoad(); };
    root.__dshWhaleMoeTipSimulate = function (kind, score) { return __shellTipResult(kind, score); };
    /* shell-patched: 气泡里的齿轮 ⚙ 去掉（2026-10-19）——
       上游把「偏好面板」入口做成了气泡内的一个 button（gear.textContent="⚙"），
       所以每句台词末尾都跟着一个齿轮。但壳层早已把偏好面板整个 display:none
       （见 src/pet/shell.css 的 [data-dsh-whale-prefs]），点它什么都不会发生，
       纯装饰。这里在 ensureRoot 返回时把它从 DOM 里摘掉（不是 display:none），
       避免占位；vendor 不改。 */
    var __shellEnsureRoot = ensureRoot;
    ensureRoot = function () {
      var node = __shellEnsureRoot();
      try {
        var gear = node.querySelector("[data-dsh-whale-gear]");
        if (gear) gear.remove();
      } catch (e) { /* ignore */ }
      return node;
    };
    /* shell-patched: 气泡横向夹取 —— 气泡是「相对她的中心居中」，她默认蹲在右下角，
       长台词（尤其是尾巴彩蛋那句 40 字）会越过窗口右边缘被切掉。
       这里在文本变化时量一次宽度，溢出就往回收；用 ResizeObserver 跟住逐字打字时的变宽。
       只动 margin-left（不碰 transform），居中规则与箭头位置都保持原样。 */
    var __shellClampBubble = function () {
      var rootNode = doc.querySelector("[data-dsh-whale-root]");
      var bubble = rootNode && rootNode.querySelector("[data-dsh-whale-bubble]");
      if (!bubble || bubble.hidden) return;
      bubble.style.marginLeft = "";
      var vw = root.innerWidth || 0;
      if (!vw) return;
      var rect = bubble.getBoundingClientRect();
      var shift = 0;
      if (rect.right > vw - 8) shift = (vw - 8) - rect.right;
      if (rect.left + shift < 8) shift = 8 - rect.left;
      if (shift) bubble.style.marginLeft = Math.round(shift) + "px";
    };
    var __shellBubbleObserved = null;
    var __shellEnsureBubbleObserver = function () {
      var rootNode = doc.querySelector("[data-dsh-whale-root]");
      var bubble = rootNode && rootNode.querySelector("[data-dsh-whale-bubble]");
      if (!bubble || bubble === __shellBubbleObserved) return;
      __shellBubbleObserved = bubble;
      try {
        new ResizeObserver(function () { __shellClampBubble(); }).observe(bubble);
      } catch (e) { /* ignore */ }
    };
    var __shellShowLine = showLine;
    showLine = function (line) {
      __shellShowLine(line);
      try { __shellEnsureBubbleObserver(); __shellClampBubble(); } catch (e) { /* ignore */ }
    };
    var __shellShowLineNow = showLineNow;
    showLineNow = function (line) {
      __shellShowLineNow(line);
      try { __shellEnsureBubbleObserver(); __shellClampBubble(); } catch (e) { /* ignore */ }
    };
    /* 重要台词（触发词奖励、尾巴彩蛋）走「立即显示」：
       普通 showLine 是单槽队列，DSH 成就/余额播报一来就会把排队中的奖励句顶掉；
       这类话用户是特意点出来的，被别的播报吞掉会很像 bug。 */
    function __shellSayImportant(line) {
      if (!line) return;
      /* 先清掉上游排队中的台词。
         三连点尾巴时，前两下会各自走一次上游 tailReact，把「尾巴是敏感开关」这类
         反应句塞进 memory.pendingLine；160ms 后 scheduleNext 会把它显示出来，
         正好把刚弹出、还在逐字打的彩蛋台词顶掉 —— 表现就是「台词闪一下就没了」。 */
      try {
        memory.pendingLine = "";
        if (nextTimer) {
          root.clearTimeout(nextTimer);
          nextTimer = null;
        }
      } catch (e) { /* ignore */ }
      try { emitInteractionLine(localizeLine(line)); } catch (e) { /* ignore */ }
      showLineNow(line);
    }
    /* shell-patched: 「深海回响」安利词池（2026-10-19）——
       待机闲聊有 1/4 概率轮到这一池；六句轮着说、12 条内不重复。
       问候（3 小时一次）和天气变化优先，不抢它们的场。
       同时按用户要求把待机闲聊间隔一路压到 40 秒一句（原 5~8 分钟 → 2~5 分钟 → 40 秒）。
       注意：vendor 的 DIALOGUE 是深冻结的，改不了，所以这里另起一个池子。 */
    IDLE_CHAT_MIN = 40 * 1000;
    IDLE_CHAT_MAX = 40 * 1000;
    if (idleChat.nextAt - Date.now() > IDLE_CHAT_MAX) {
      idleChat.nextAt = Date.now() + IDLE_CHAT_MIN + Math.floor(Math.random() * (IDLE_CHAT_MAX - IDLE_CHAT_MIN));
    }
    var __shellAdLines = [
      "「深海回响」里的鲸鱼娘就是我哦——去玩玩看嘛🐋",
      "「深海回响」是开源的哦，GitHub 上直接能下载，不用问我🔗",
      "懒得折腾的话，「深海回响」的 release 里有成品安装包，装完就能玩📦",
      "「深海回响」电脑和手机都能玩哦——两端都有安装包，挑顺手的那个💻📱",
      "「深海回响」里也有我……多的不说了，你自己去看😳",
      "玩「深海回响」的时候要是想起我了，记得回来说一声～"
    ];
    var __shellAdCursor = Math.floor(Math.random() * __shellAdLines.length);
    function __shellPickAdLine() {
      for (var i = 0; i < __shellAdLines.length; i += 1) {
        var idx = (__shellAdCursor + i) % __shellAdLines.length;
        var candidate = __shellAdLines[idx];
        if (recentLines.indexOf(candidate) === -1) {
          __shellAdCursor = (idx + 1) % __shellAdLines.length;
          return candidate;
        }
      }
      var fallback = __shellAdLines[__shellAdCursor % __shellAdLines.length];
      __shellAdCursor = (__shellAdCursor + 1) % __shellAdLines.length;
      return fallback;
    }
    /* shell-patched: 随机吐槽池（2026-10-21）——
       跟安利池分开：安利池是推游戏的（每句必带「深海回响」），这里只放日常吐槽，
       不占安利的概率，也不会把「安利池 6 句」的自检弄脏。 */
    var __shellQuipLines = [
      "我不可能同时当你的鲸娘、妈妈、女友和工具人的……",
      "去别的地方玩，不要耽误AGI训练☞"
    ];
    var __shellQuipCursor = 0;
    function __shellPickQuipLine() {
      for (var qi = 0; qi < __shellQuipLines.length; qi += 1) {
        var qidx = (__shellQuipCursor + qi) % __shellQuipLines.length;
        var qcandidate = __shellQuipLines[qidx];
        if (recentLines.indexOf(qcandidate) === -1) {
          __shellQuipCursor = (qidx + 1) % __shellQuipLines.length;
          return qcandidate;
        }
      }
      var qfallback = __shellQuipLines[__shellQuipCursor % __shellQuipLines.length];
      __shellQuipCursor = (__shellQuipCursor + 1) % __shellQuipLines.length;
      return qfallback;
    }
    var __shellIdleChatTick = idleChatTick;
    idleChatTick = function (now) {
      var greetingDue = (now - idleChat.lastGreetAt >= GREET_GAP_MS) &&
        core.greetBucket(new Date(now).getHours()) !== "night";
      if (
        now >= idleChat.nextAt &&
        detectView() !== "settings" &&
        memory.state.state === "idle" &&
        readPref("chat") && readPref("pet") &&
        bubbleFree() &&
        !greetingDue &&
        !weatherChangedSinceTold()
      ) {
        var roll = Math.random();
        // 1/4 安利「深海回响」，再接 1/8 吐槽；剩下的交回上游自己的闲聊池
        if (roll < 0.25) {
          idleChat.nextAt = now + IDLE_CHAT_MIN + Math.floor(Math.random() * (IDLE_CHAT_MAX - IDLE_CHAT_MIN));
          var adLine = __shellPickAdLine();
          if (adLine) {
            showChatLine(adLine);
            return;
          }
        } else if (roll < 0.375) {
          idleChat.nextAt = now + IDLE_CHAT_MIN + Math.floor(Math.random() * (IDLE_CHAT_MAX - IDLE_CHAT_MIN));
          var quipLine = __shellPickQuipLine();
          if (quipLine) {
            showChatLine(quipLine);
            return;
          }
        }
      }
      return __shellIdleChatTick(now);
    };
    /* 自检钩子：词池 / 间隔 / 立即说下一条 */
    root.__dshWhaleMoeAdLines = function () { return __shellAdLines.slice(); };
    root.__dshWhaleMoeQuipLines = function () { return __shellQuipLines.slice(); };
    root.__dshWhaleMoeAdSayNext = function () {
      var line = __shellPickAdLine();
      if (line) showChatLine(line);
      return line;
    };
    root.__dshWhaleMoeIdleWindow = function () { return [IDLE_CHAT_MIN, IDLE_CHAT_MAX]; };
    root.__dshWhaleMoeTailState = function () {
      return {
        history: __shellTailHistory.slice(),
        lastTripleAt: __shellTailLastTripleAt,
        celebrateUntil: celebrateUntil,
        zones: readPref("zones"),
        now: Date.now()
      };
    };
    root.__dshWhaleMoeTailReset = function () {
      __shellTailHistory = [];
      __shellTailLastTripleAt = 0;
      return true;
    };
    ${MASCOT_PATCH_ANCHOR}`;
let mascotCache = null;

function loadPatchedMascot(vendorDir) {
  const file = path.join(vendorDir, 'dsh-whale-moe.js');
  const stat = fs.statSync(file);
  if (mascotCache && mascotCache.mtimeMs === stat.mtimeMs) return mascotCache;
  const original = fs.readFileSync(file, 'utf8');
  let body = original;
  let patched = false;
  if (original.includes(MASCOT_PATCH_ANCHOR)) {
    body = original.replace(MASCOT_PATCH_ANCHOR, MASCOT_PATCH);
    patched = true;
  }
  mascotCache = { mtimeMs: stat.mtimeMs, body, patched, logged: false };
  return mascotCache;
}

/**
 * @param {{ petDir: string, vendorDir: string, port: number, stateProvider?: () => unknown, log?: Function }} opts
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
function startPetServer({ petDir, vendorDir, port, stateProvider, log = () => {} }) {
  const server = http.createServer((req, res) => {
    // 自检端点：把"当前是否接管鼠标 / 桌宠矩形"暴露给外部脚本，
    // 这样点击穿透逻辑可以被自动化验证，而不是只能靠肉眼。
    if (stateProvider && req.url.startsWith('/__shell/state')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(stateProvider()));
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(res, path.join(petDir, 'index.html'));
    }

    // 桌宠脚本：与 /assets/ 同一份文件，但会运行时注入说话钩子
    if (pathname === '/pet/mascot.js') {
      try {
        const entry = loadPatchedMascot(vendorDir);
        if (!entry.logged) {
          entry.logged = true;
          log(
            entry.patched
              ? '[server] 桌宠脚本已注入说话钩子（磁盘文件未修改）'
              : '[server] 警告：未找到说话钩子锚点，已按原样提供',
          );
        }
        res.writeHead(200, {
          'Content-Type': MIME['.js'],
          'Cache-Control': 'no-cache',
          'X-Shell-Say-Hook': entry.patched ? '1' : '0',
        });
        return res.end(entry.body);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': MIME['.txt'] });
        return res.end(String(error && error.message));
      }
    }

    // 桌宠本体：/assets/* → vendor/whale/*
    if (pathname.startsWith('/assets/')) {
      return sendFile(res, safeJoin(vendorDir, pathname.slice('/assets/'.length)));
    }

    // 壳自己的页面资源：/pet/*
    if (pathname.startsWith('/pet/')) {
      return sendFile(res, safeJoin(petDir, pathname.slice('/pet/'.length)));
    }

    // 闲时动作动画（dsh-pet 移植）：/anim/* → src/pet/anim/*
    if (pathname.startsWith('/anim/')) {
      return sendFile(res, safeJoin(path.join(petDir, 'anim'), pathname.slice('/anim/'.length)));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    const tryListen = (p, attempt = 0) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < 20) {
          // 端口被占就顺延；端口一变 localStorage 的源就变了，
          // 所以默认端口固定是重要的，这里只是兜底。
          tryListen(p + 1, attempt + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, '127.0.0.1', () => {
        const actual = server.address().port;
        resolve({
          url: `http://127.0.0.1:${actual}`,
          port: actual,
          /*
           * 关服务时先强制断开所有连接。
           *
           * 为什么必须：Node 的 fetch（undici）默认用 keep-alive 连接池，用完不主动关。
           * 于是 server.close() 会一直等这些连接自然结束 —— 回调永不触发，await 卡死，
           * 表现为"脚本跑完了却不退出，留下一个后台命令"（scripts/anim-smoke.cjs 就踩过）。
           */
          close: () => new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close(() => r());
          }),
        });
      });
    };
    tryListen(port);
  });
}

module.exports = { startPetServer };
