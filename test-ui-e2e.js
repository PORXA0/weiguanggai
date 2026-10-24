/* Windows Edge 无头端到端冒烟测试：队列、紧急语境、歧义时间和停止任务。 */
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');
var WebSocket = require('ws');

function freePort() {
  return new Promise(function (resolve, reject) {
    var probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', function () {
      var port = probe.address().port;
      probe.close(function () { resolve(port); });
    });
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function findEdge() {
  var candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  return candidates.filter(function (file) { return fs.existsSync(file); })[0] || '';
}

async function waitFor(fn, timeout) {
  var deadline = Date.now() + (timeout || 8000);
  var lastError;
  while (Date.now() < deadline) {
    try {
      var value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await sleep(100);
  }
  throw lastError || new Error('等待页面状态超时');
}

(async function () {
  var edge = findEdge();
  if (!edge) {
    console.log('UI E2E skipped: Microsoft Edge not found');
    return;
  }

  var dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiguang-e2e-'));
  var profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiguang-edge-'));
  var configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ provider: 'disabled-for-e2e' }));
  var port = await freePort();
  var debugPort = await freePort();
  var server = childProcess.spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      HTTP_ONLY: '1',
      PORT: String(port),
      WEIGUANG_DATA_DIR: dataDir,
      WEIGUANG_CONFIG: configPath,
      WEIGUANG_AUTH_MODE: 'paired'
    }),
    stdio: 'ignore'
  });
  var browser;
  var socket;

  try {
    await waitFor(async function () {
      try {
        var response = await fetch('http://127.0.0.1:' + port + '/api/ping');
        return response.ok;
      } catch (e) {
        return false;
      }
    }, 8000);

    browser = childProcess.spawn(edge, [
      '--headless=old',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--user-data-dir=' + profileDir,
      '--remote-debugging-port=' + debugPort,
      'http://127.0.0.1:' + port + '/'
    ], { stdio: 'ignore' });

    var target = await waitFor(async function () {
      try {
        var list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
        return list.filter(function (item) {
          return item.type === 'page' && item.url.indexOf(String(port)) >= 0;
        })[0];
      } catch (e) {
        return null;
      }
    }, 10000);

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(function (resolve, reject) {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    var nextId = 0;
    var pending = {};
    socket.on('message', function (raw) {
      var message = JSON.parse(String(raw));
      if (message.id && pending[message.id]) {
        pending[message.id](message);
        delete pending[message.id];
      }
    });
    function cdp(method, params) {
      return new Promise(function (resolve, reject) {
        var id = ++nextId;
        pending[id] = function (message) {
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        };
        socket.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    }
    async function evaluate(expression) {
      var result = await cdp('Runtime.evaluate', {
        expression: expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本异常');
      return result.result.value;
    }

    await waitFor(function () {
      return evaluate("document.readyState === 'complete' && !!document.querySelector('#homeGoalInput')");
    });

    await evaluate("(()=>{const i=document.querySelector('#homeGoalInput');i.value='我孙子摔倒了';document.querySelector('#btnHomeGoalSend').click();return true})()");
    await waitFor(function () {
      return evaluate("document.querySelector('#talkAnswer').textContent.includes('有没有呼吸')");
    });
    var emergencyText = await evaluate("document.querySelector('#talkAnswer').textContent");
    var emergencyButton = await evaluate("[...document.querySelectorAll('#talkAnswer button')].map(b=>b.textContent).join('|')");
    assert(emergencyText.includes('有没有呼吸'), '第三人紧急情况应询问呼吸和意识');
    assert(emergencyButton.includes('急救中心'), '第三人紧急情况应提供 120 人工拨号按钮');

    await evaluate("(()=>{const i=document.querySelector('#homeGoalInput');i.value='明天8点提醒我吃药';document.querySelector('#btnHomeGoalSend').click();return true})()");
    await waitFor(function () {
      return evaluate("document.querySelector('#talkAnswer').textContent.includes('还是晚上')");
    });
    assert(await evaluate("(()=>{const d=JSON.parse(localStorage.getItem('weiguang.data.v1'));return d.agentMemory.pending&&d.agentMemory.pending.slot==='time'})()"),
      '歧义时间必须保存为待补充时间槽');

    await evaluate("(()=>{const i=document.querySelector('#homeGoalInput');i.value='上午8点';document.querySelector('#btnHomeGoalSend').click();return true})()");
    await waitFor(function () {
      return evaluate("JSON.parse(localStorage.getItem('weiguang.data.v1')).events.length > 0");
    });
    assert(await evaluate("(()=>{const d=JSON.parse(localStorage.getItem('weiguang.data.v1'));return d.agentMemory.pending===null})()"),
      '补充时间后必须清除待处理状态');

    var beforeTurns = await evaluate("JSON.parse(localStorage.getItem('weiguang.data.v1')).agentMemory.turns.length");
    await evaluate("(()=>{const i=document.querySelector('#homeGoalInput');i.value='现在几点了';document.querySelector('#btnHomeGoalSend').click();i.value='明天下午三点提醒我去公园';document.querySelector('#btnHomeGoalSend').click();return true})()");
    await waitFor(async function () {
      var count = await evaluate("JSON.parse(localStorage.getItem('weiguang.data.v1')).agentMemory.turns.length");
      return count >= beforeTurns + 2;
    }, 10000);

    await evaluate("(()=>{const i=document.querySelector('#homeGoalInput');i.value='看看天气';document.querySelector('#btnHomeGoalSend').click();document.querySelector('#btnCancelAgent').click();return true})()");
    await waitFor(function () {
      return evaluate("document.querySelector('#agentMonitorStatus').textContent.includes('已停止')");
    });

    console.log('UI E2E tests passed');
  } finally {
    try { if (socket) socket.close(); } catch (e) {}
    try { if (browser) browser.kill(); } catch (e) {}
    try { if (server) server.kill(); } catch (e) {}
    await sleep(250);
    [dataDir, profileDir].forEach(function (dir) {
      try {
        var resolved = path.resolve(dir);
        if (resolved.indexOf(path.resolve(os.tmpdir())) === 0) {
          fs.rmSync(resolved, { recursive: true, force: true });
        }
      } catch (e) {}
    });
  }
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
