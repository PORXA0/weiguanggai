/* ============================================================
   自动重启版服务

   作用：盯着 server.js，一旦文件被改动就自动重启服务。
   这样以后改完服务端代码，不用再手动关窗口重启。

   用法：node watch-server.js
   （或者直接双击 start-watch.bat）
   ============================================================ */

var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;

var SERVER = path.join(__dirname, 'server.js');
var child = null;
var restarting = false;
var timer = null;

function start() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env
  });
  child.on('exit', function (code) {
    child = null;
    if (!restarting && code !== 0) {
      console.log('');
      console.log('  服务退出了（代码 ' + code + '）。改完 server.js 会自动重启。');
      console.log('');
    }
  });
}

function restart() {
  if (restarting) return;
  restarting = true;
  console.log('');
  console.log('  检测到 server.js 有改动，正在自动重启…');
  console.log('');
  if (child) {
    try { child.kill(); } catch (e) {}
  }
  setTimeout(function () {
    restarting = false;
    start();
  }, 500);
}

start();

try {
  fs.watch(SERVER, function () {
    clearTimeout(timer);
    timer = setTimeout(restart, 600);
  });
} catch (e) {
  console.log('  提示：无法监听文件变化，服务照常运行，改动后需要手动重启。');
}

console.log('');
console.log('  已开启自动重启：改动 server.js 后，服务会自己重启。');
console.log('  要完全停止，按 Ctrl + C 两次，或者直接关掉这个窗口。');
console.log('');
