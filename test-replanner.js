/* 用本地 OpenAI 兼容 mock 验证动态重规划、工具契约和安全兜底。 */
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');

function freePort() {
  return new Promise(function (resolve) {
    var probe = net.createServer();
    probe.listen(0, '127.0.0.1', function () {
      var port = probe.address().port;
      probe.close(function () { resolve(port); });
    });
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

(async function () {
  var mockCount = 0;
  var mock = http.createServer(function (req, res) {
    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () {
      JSON.parse(body);
      mockCount++;
      var plan;
      if (mockCount === 1) {
        plan = {
          decision: 'continue',
          reason: '联系人工具失败，重新查找女儿',
          steps: [{ tool: 'find_contact', args: { name: '女儿' }, purpose: '查找女儿' }],
          spoken: ''
        };
      } else if (mockCount === 2) {
        plan = {
          decision: 'continue',
          reason: '非法页面参数应被过滤',
          steps: [
            { tool: 'open_page', args: { page: 'admin' }, purpose: '非法页面' },
            { tool: 'get_time', args: {}, purpose: '读取时间' }
          ]
        };
      } else {
        plan = {
          decision: 'ask-user',
          reason: '缺少联系人',
          steps: [],
          spoken: '请告诉我要联系哪位家人。'
        };
      }
      var payload = JSON.stringify({
        choices: [{ message: { content: JSON.stringify(plan) } }]
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      });
      res.end(payload);
    });
  });
  await new Promise(function (resolve) { mock.listen(0, '127.0.0.1', resolve); });
  var mockPort = mock.address().port;

  var dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiguang-replan-'));
  var configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    provider: 'test',
    llm: {
      baseUrl: 'http://127.0.0.1:' + mockPort + '/v1/chat/completions',
      apiKey: 'test-key',
      model: 'test-model'
    }
  }));
  var port = await freePort();
  var child = childProcess.spawn(process.execPath, ['server.js'], {
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

  try {
    for (var i = 0; i < 40; i++) {
      try {
        var ping = await fetch('http://127.0.0.1:' + port + '/api/ping');
        if (ping.ok) break;
      } catch (e) {}
      await sleep(100);
    }
    var token = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8')).token;
    async function replan() {
      var response = await fetch('http://127.0.0.1:' + port + '/api/agent/replan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-weiguang-token': token
        },
        body: JSON.stringify({
          goal: '联系女儿',
          rawText: '帮我联系女儿',
          risk: 'normal',
          completed: [{ tool: 'find_contact', ok: false, observation: '没有找到联系人' }],
          failedTool: 'find_contact',
          failure: '没有找到联系人'
        })
      });
      return response.json();
    }

    var first = await replan();
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.plan.decision, 'continue');
    assert.strictEqual(first.plan.source, 'llm-replan');
    assert.strictEqual(first.plan.steps[0].tool, 'find_contact');

    var second = await replan();
    assert.strictEqual(second.ok, true);
    assert.deepStrictEqual(second.plan.steps.map(function (step) { return step.tool; }), ['get_time'],
      '非法工具参数不能穿透动态重规划');

    var third = await replan();
    assert.strictEqual(third.ok, true);
    assert.strictEqual(third.plan.decision, 'ask-user');
    assert.strictEqual(third.plan.steps[0].tool, 'ask_user');
    assert(third.plan.steps[0].args.question.indexOf('哪位家人') >= 0);

    console.log('Dynamic replanner tests passed');
  } finally {
    try { child.kill(); } catch (e) {}
    try { mock.close(); } catch (e) {}
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
