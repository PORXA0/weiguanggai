/* 验证主 JSON 损坏时可以从上一份 .bak 自动恢复。 */
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function freePort() {
  return new Promise(function (resolve) {
    var probe = net.createServer();
    probe.listen(0, '127.0.0.1', function () {
      var port = probe.address().port;
      probe.close(function () { resolve(port); });
    });
  });
}

(async function () {
  var dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiguang-backup-'));
  var configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ provider: 'disabled-for-tests' }));
  var port = await freePort();
  var env = Object.assign({}, process.env, {
    HTTP_ONLY: '1',
    PORT: String(port),
    WEIGUANG_DATA_DIR: dataDir,
    WEIGUANG_CONFIG: configPath,
    WEIGUANG_AUTH_MODE: 'paired'
  });
  var child = null;
  var token = '';

  async function startServer() {
    child = childProcess.spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: env,
      stdio: 'ignore'
    });
    for (var i = 0; i < 40; i++) {
      try {
        var response = await fetch('http://127.0.0.1:' + port + '/api/ping');
        if (response.ok) return;
      } catch (e) {}
      await sleep(100);
    }
    throw new Error('测试服务未能启动');
  }

  async function saveState(name) {
    var response = await fetch('http://127.0.0.1:' + port + '/api/state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-weiguang-token': token
      },
      body: JSON.stringify({ elderName: name, updatedAt: Date.now() })
    });
    assert.strictEqual(response.status, 200);
  }

  try {
    await startServer();
    token = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8')).token;
    await saveState('备份中的状态');
    await saveState('损坏前的状态');
    assert(fs.existsSync(path.join(dataDir, 'elder-state.json.bak')));

    child.kill();
    await sleep(300);
    fs.writeFileSync(path.join(dataDir, 'elder-state.json'), '{broken');

    await startServer();
    var recovered = await fetch('http://127.0.0.1:' + port + '/api/state', {
      headers: { 'x-weiguang-token': token }
    }).then(function (response) { return response.json(); });
    assert.strictEqual(recovered.elderName, '备份中的状态');
    assert(!fs.readFileSync(path.join(dataDir, 'elder-state.json'), 'utf8').includes('{broken'));

    console.log('Backup recovery test passed');
  } finally {
    try { if (child) child.kill(); } catch (e) {}
    await sleep(250);
    try {
      var resolved = path.resolve(dataDir);
      if (resolved.indexOf(path.resolve(os.tmpdir())) === 0) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    } catch (e) {}
  }
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
