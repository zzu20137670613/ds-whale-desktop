const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { startPetServer } = require(path.join(root, 'src', 'server'));

(async () => {
  const srv = await startPetServer({
    petDir: path.join(root, 'src', 'pet'),
    vendorDir: path.join(root, 'vendor', 'whale'),
    port: 0,
  });
  const base = srv.url;
  const test = [
    ['/pet/anim/anims.js', '动画脚本'],
    ['/anim/webm/撸猫.webm', 'webm'],
    ['/anim/webm/待机呼吸休闲.webm', 'webm-2'],
    ['/assets/dsh-whale-moe.css', '上游css'],
    ['/pet/shell.css', '壳css'],
    ['/pet/anim/webm/荡秋千.webm', '路径修正'],
  ];
  let fail = 0;
  for (const [p, label] of test) {
    const r = await fetch(base + p);
    const ct = r.headers.get('content-type') || '';
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${label.padEnd(6)} ${p}  (${r.status}, ${ct})`);
    if (!r.ok) fail++;
  }
  await srv.close();
  console.log(fail === 0 ? 'ALL PASS' : `FAILED=${fail}`);
  /*
   * 用 exitCode 而不是 process.exit()：Windows 上进程退出时若还有未收尾的异步 I/O，
   * process.exit() 会和它竞态，触发 libuv 断言（async.c line 76）而异常"崩溃退出"。
   * 服务已 close，事件循环自然会排空 —— 设好退出码让它自己干净地结束即可。
   */
  process.exitCode = fail === 0 ? 0 : 1;
})();