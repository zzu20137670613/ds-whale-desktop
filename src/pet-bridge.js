/**
 * 桌宠桥接服务 —— 给外部游戏（the-11th-forest 隐藏关）控制桌宠的本地接口。
 *
 * 为什么需要它：游戏跑在浏览器/沙箱里，杀不了也起不了本地进程；桌宠是独立的
 * Electron exe。两边唯一的公共面就是「本机回环 HTTP」。
 *
 * ── 安全边界（先说清楚，免得以后有人把它当密钥）────────────────────────
 * · 端口固定 38930，只绑 127.0.0.1，外网碰不到。
 * · `app=ds-pet-bridge` 是**公开的协商常量**，不是密钥 —— 它只防别的程序/网页
 *   误触发，不防攻击。故意不做随机 token：桌宠和游戏是两个独立分发的 exe，
 *   随机 token 在开源分发场景下永远配不上，会让同好装完不能联动。
 * · 这个接口只能做两件事：隐藏桌宠、显示桌宠。不能执行命令、读文件、调系统能力。
 *   最坏情况是某个网页手贱调了一下，她藏起来 10 分钟后自己回来，或托盘一键恢复。
 * · 另加一层 Origin 过滤：只接受空 / null(file://) / localhost / 127.0.0.1。
 *   本机程序本来就没有 Origin，放行 —— 反正它们本来就能做更多事。
 */

const http = require('node:http');

/** 固定端口。游戏侧写死同一个值，双方零配置。 */
const BRIDGE_PORT = 38930;
/** 协商常量：防误触，不是密钥。 */
const BRIDGE_APP = 'ds-pet-bridge';
/** 协议版本：以后接口不兼容升级时递增，游戏侧对不上就当没装桌宠。 */
const BRIDGE_PROTOCOL = 1;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

/**
 * 只接受本机来源。浏览器请求一定带 Origin；file:// 页面在 Chromium 里是 "null"。
 */
function originAllowed(origin) {
  if (!origin || origin === 'null') return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * 起桥接服务。
 *
 * @param {object} options
 * @param {string} options.version        桌宠版本号（给游戏侧做兼容提示）
 * @param {() => string} [options.onPing] 返回当前状态：'awake' | 'suspended'
 * @param {(reason: string) => boolean} [options.onSuspend]
 * @param {(reason: string) => boolean} [options.onResume]
 * @param {(...args: any[]) => void} [options.log]
 * @returns {Promise<{ok: boolean, port: number, protocol: number, error?: string, close?: () => Promise<void>}>}
 */
function startPetBridge({ version, onPing, onSuspend, onResume, log = () => {} }) {
  const send = (res, code, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(code, {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    if (!originAllowed(req.headers.origin)) {
      send(res, 403, { ok: false, error: 'origin not allowed' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
    } catch {
      send(res, 400, { ok: false, error: 'bad url' });
      return;
    }

    // 协商常量对不上就 400，不解释细节 —— 免得被当成探测入口
    if (url.searchParams.get('app') !== BRIDGE_APP) {
      send(res, 400, { ok: false, error: 'unknown app' });
      return;
    }

    const state = () => (onPing ? onPing() : 'unknown');
    const base = () => ({
      ok: true,
      app: BRIDGE_APP,
      protocol: BRIDGE_PROTOCOL,
      version,
      state: state(),
    });

    switch (url.pathname) {
      case '/__pet/ping':
        send(res, 200, base());
        return;

      case '/__pet/suspend': {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'POST only' });
          return;
        }
        const done = onSuspend ? onSuspend('game') !== false : false;
        send(res, 200, { ...base(), ok: done });
        return;
      }

      case '/__pet/resume': {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'POST only' });
          return;
        }
        const done = onResume ? onResume('game') !== false : false;
        send(res, 200, { ...base(), ok: done });
        return;
      }

      default:
        send(res, 404, { ok: false, error: 'not found' });
    }
  });

  return new Promise((resolve) => {
    // 端口被别的软件占了：只记日志，不弹窗、不影响桌宠本体。
    // 游戏侧连不上会静默降级（「当没装桌宠」）。
    server.once('error', (error) => {
      log('[bridge] listen failed', BRIDGE_PORT, error.code || error.message);
      resolve({ ok: false, port: BRIDGE_PORT, protocol: BRIDGE_PROTOCOL, error: error.code || error.message });
    });
    server.listen(BRIDGE_PORT, '127.0.0.1', () => {
      log('[bridge] listening http://127.0.0.1:' + BRIDGE_PORT + ' (protocol ' + BRIDGE_PROTOCOL + ')');
      resolve({
        ok: true,
        port: BRIDGE_PORT,
        protocol: BRIDGE_PROTOCOL,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startPetBridge, BRIDGE_PORT, BRIDGE_PROTOCOL, BRIDGE_APP };
