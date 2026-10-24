/* 家庭告警闭环集成测试：通知、查看、电话确认、处置关闭和幂等。 */
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var sleep = function (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
};

(async function () {
  var dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiguang-events-'));
  var port = 19121;
  var child = childProcess.spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      HTTP_ONLY: '1',
      PORT: String(port),
      WEIGUANG_DATA_DIR: dataDir,
      WEIGUANG_HIGH_ESCALATE_MS: '150',
      WEIGUANG_AUTH_MODE: 'paired'
    }),
    stdio: 'ignore'
  });
  var authToken = '';

  async function request(url, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {}, {
      'x-weiguang-token': authToken
    });
    var response = await fetch('http://127.0.0.1:' + port + url, options);
    return response.json();
  }

  try {
    var ready = false;
    for (var i = 0; i < 30; i++) {
      try {
        var ping = await request('/api/ping');
        if (ping && ping.ok) { ready = true; break; }
      } catch (e) {}
      await sleep(150);
    }
    assert(ready, '服务未能启动');

    var auth = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
    authToken = auth.token;
    var unauthorized = await fetch('http://127.0.0.1:' + port + '/api/state');
    assert.strictEqual(unauthorized.status, 401, '未配对请求必须拒绝');

    var badPair = await fetch('http://127.0.0.1:' + port + '/api/pair/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '999999' === auth.pairCode ? '000000' : '999999' })
    });
    assert.strictEqual(badPair.status, 403, '错误配对码必须拒绝');

    var paired = await fetch('http://127.0.0.1:' + port + '/api/pair/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: auth.pairCode })
    });
    assert.strictEqual(paired.status, 200, '正确配对码必须通过');
    assert(paired.headers.get('set-cookie').includes('wg_auth='), '配对后必须写入会话 Cookie');

    var eventId = 'test-event-1';
    var created = await request('/api/family/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: eventId,
        kind: '高风险',
        text: '老人摔倒了，需要家人确认'
      })
    });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.event.status, 'pending');
    assert.strictEqual(created.event.level, 'high');

    var duplicate = await request('/api/family/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: eventId, kind: '高风险', text: '重复通知' })
    });
    assert.strictEqual(duplicate.duplicate, true, '事件 ID 必须幂等');

    var pending = await request('/api/family/notify');
    assert.strictEqual(pending.notices.length, 1);
    assert.strictEqual(pending.notices[0].status, 'pending');

    await sleep(220);
    var escalated = await request('/api/family/events');
    assert.strictEqual(escalated.events[0].status, 'escalated', '超时事件必须升级');

    var acked = await request('/api/family/events/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [created.id], action: 'ack' })
    });
    assert.strictEqual(acked.changed, 1);

    var contacted = await request('/api/family/events/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [created.id], action: 'contact' })
    });
    assert.strictEqual(contacted.changed, 1);

    var resolved = await request('/api/family/events/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [created.id], action: 'resolve' })
    });
    assert.strictEqual(resolved.changed, 1);

    var events = await request('/api/family/events');
    assert.strictEqual(events.events.length, 1);
    assert.strictEqual(events.events[0].status, 'resolved');
    assert(events.events[0].acknowledgedAt > 0);
    assert(events.events[0].contactedAt > 0);
    assert(events.events[0].resolvedAt > 0);
    assert.strictEqual(events.metrics.unresolved, 0);

    var afterResolve = await request('/api/family/notify');
    assert.strictEqual(afterResolve.notices.length, 0, '已关闭事件不应继续弹出');

    var stateSaved = await request('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elderName: '测试老人', medDone: 1, medTotal: 2 })
    });
    assert.strictEqual(stateSaved.ok, true);
    await request('/api/family/msg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '记得喝水' })
    });
    var stateFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'elder-state.json'), 'utf8'));
    var messageFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'family-messages.json'), 'utf8'));
    assert.strictEqual(stateFile.elderName, '测试老人');
    assert.strictEqual(messageFile[0].text, '记得喝水');

    var persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'notices.json'), 'utf8'));
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].status, 'resolved');

    console.log('Family event lifecycle tests passed:', 17);
  } finally {
    try { child.kill(); } catch (e) {}
    await sleep(250);
    try {
      var resolvedDir = path.resolve(dataDir);
      if (resolvedDir.indexOf(path.resolve(os.tmpdir())) === 0) {
        fs.rmSync(resolvedDir, { recursive: true, force: true });
      }
    } catch (e) {}
  }
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
