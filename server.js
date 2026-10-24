/* ============================================================
   微光护老 · 家人端同步服务

   作用：让老人端的设备把状态推上来，家人的手机再取走；
         同时提供语音、地图代理和 Agent 远程规划接口。
   首次运行先执行 npm.cmd install，安装 WebSocket 依赖。

   启动：
       node server.js
   本机老人端直接打开打印出的地址；家人手机打开 family.html 并输入六位配对码。

   老人状态、留言、告警和 Agent 轨迹持久化到数据目录；
   语音和大模型只在相关功能使用时调用外部服务。
   ============================================================ */

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var WebSocket = require('ws');
var AgentCore = require('./agent-core.js');

var PORT = process.env.PORT || 8080;
var ROOT = __dirname;
var PREFERRED_DATA_DIR = path.join(os.homedir(), 'Documents', 'Codex', '.weiguang-data');
var DATA_DIR = process.env.WEIGUANG_DATA_DIR || PREFERRED_DATA_DIR;
var HIGH_ESCALATE_MS = Number(process.env.WEIGUANG_HIGH_ESCALATE_MS) || 3 * 60 * 1000;
var NORMAL_ESCALATE_MS = Number(process.env.WEIGUANG_NORMAL_ESCALATE_MS) || 10 * 60 * 1000;
var RETENTION_DAYS = Math.max(1, Number(process.env.WEIGUANG_RETENTION_DAYS) || 180);
var ALERT_WEBHOOK = String(process.env.WEIGUANG_ALERT_WEBHOOK || '').trim();
var ESCALATION_WEBHOOK = String(process.env.WEIGUANG_ESCALATION_WEBHOOK || '').trim();
var VERBOSE_LOGS = process.env.WEIGUANG_VERBOSE_LOGS === '1';
var AUTH_MODE = String(process.env.WEIGUANG_AUTH_MODE || 'open').toLowerCase();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  if (!process.env.WEIGUANG_DATA_DIR) DATA_DIR = ROOT;
}

/* 密钥只从项目目录之外读取，优先级：
   1. WEIGUANG_CONFIG 环境变量
   2. Documents/Codex/.weiguang-secrets/voice-config.json（本机私密目录）
   3. ~/.weiguang/voice-config.json
   4. 项目内 voice-config.json（仅兼容旧版本，正式打包时应删除）
*/
function resolveAppConfigPath() {
  var candidates = [];
  if (process.env.WEIGUANG_CONFIG) candidates.push(process.env.WEIGUANG_CONFIG);
  candidates.push(path.join(os.homedir(), 'Documents', 'Codex', '.weiguang-secrets', 'voice-config.json'));
  candidates.push(path.join(os.homedir(), '.weiguang', 'voice-config.json'));
  candidates.push(path.join(__dirname, 'voice-config.json'));
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) return path.resolve(candidates[i]);
    } catch (e) {}
  }
  return '';
}

var APP_CONFIG_FILE = resolveAppConfigPath();
var APP_CONFIG = null;
if (APP_CONFIG_FILE) {
  try {
    APP_CONFIG = JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf8'));
    console.log('  配置：已从项目外私有位置加载');
  } catch (e) {
    console.log('  提示：私有配置文件格式不正确，语音、大模型和地图暂不可用。');
  }
}

/* ============================================================
   家庭配对与访问控制

   · 服务器首次启动生成长期随机令牌和六位配对码
   · 本机页面自动获得会话 Cookie
   · 家人手机通过配对码换取 HttpOnly 会话 Cookie
   · 所有老人状态、告警和 Agent 接口均要求有效令牌
   ============================================================ */
var AUTH_FILE = path.join(DATA_DIR, 'auth.json');
var authState = null;
try {
  if (fs.existsSync(AUTH_FILE)) authState = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
} catch (e) { authState = null; }

function newPairCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

if (!authState || !authState.token || !authState.pairCode) {
  authState = {
    token: crypto.randomBytes(32).toString('hex'),
    pairCode: newPairCode(),
    createdAt: Date.now()
  };
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify(authState, null, 1)); } catch (e) {}
}

function parseCookies(req) {
  var out = {};
  String(req.headers.cookie || '').split(';').forEach(function (part) {
    var i = part.indexOf('=');
    if (i < 0) return;
    var value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch (e) {
      value = '';
    }
    out[part.slice(0, i).trim()] = value;
  });
  return out;
}

function isLoopbackRequest(req) {
  var ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function safeTokenEqual(value) {
  var a = Buffer.from(String(value || ''));
  var b = Buffer.from(String(authState.token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hasAuth(req) {
  /* 公网演示默认保持当前免配对模式；设置为 paired 后启用家庭令牌校验。 */
  if (AUTH_MODE === 'open') return true;
  var cookies = parseCookies(req);
  var header = req.headers['x-weiguang-token'];
  return safeTokenEqual(cookies.wg_auth || header);
}

function setAuthCookie(req, res) {
  var secure = req.socket && req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    'wg_auth=' + encodeURIComponent(authState.token) +
    '; Path=/; HttpOnly; SameSite=Lax' + secure);
}

var pairFailures = {};
function pairBlocked(req) {
  var ip = String((req.socket && req.socket.remoteAddress) || 'unknown');
  var item = pairFailures[ip];
  return !!(item && item.blockedUntil && item.blockedUntil > Date.now());
}

function recordPairFailure(req) {
  var ip = String((req.socket && req.socket.remoteAddress) || 'unknown');
  var now = Date.now();
  var item = pairFailures[ip] || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - item.firstAt > 10 * 60 * 1000) {
    item = { count: 0, firstAt: now, blockedUntil: 0 };
  }
  item.count++;
  if (item.count >= 8) item.blockedUntil = now + 5 * 60 * 1000;
  pairFailures[ip] = item;
}

/* ============================================================
   语音服务（科大讯飞开放平台）
   密钥只从项目外私有配置读取，不在前端和静态目录暴露。
   接口：在线语音听写（流式版 IAT）+ 在线语音合成（流式版 TTS）
   ============================================================ */
var voiceConfig = null;
try {
  voiceConfig = APP_CONFIG;
  if (voiceConfig.provider === 'xfyun' && voiceConfig.xfyun &&
      (voiceConfig.xfyun.appId === '在这里填你的APPID' ||
       voiceConfig.xfyun.apiKey === '在这里填你的APIKey' ||
       voiceConfig.xfyun.apiSecret === '在这里填你的APISecret')) {
    console.log('  提示：私有配置里的讯飞密钥不完整，语音识别和播报暂不可用。');
    voiceConfig = null;
  }
} catch (e) {
  voiceConfig = null;
}

/* 讯飞 WebSocket 鉴权：HMAC-SHA256 签名，拼到 URL 参数里 */
function xfyunAuth(host, apiPath, apiKey, apiSecret) {
  var date = new Date().toUTCString();
  var signatureOrigin = 'host: ' + host + '\ndate: ' + date + '\nGET ' + apiPath + ' HTTP/1.1';
  var signature = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
  var authOrigin = 'api_key="' + apiKey + '", algorithm="hmac-sha256", headers="host date request-line", signature="' + signature + '"';
  var authorization = Buffer.from(authOrigin).toString('base64');
  return 'wss://' + host + apiPath +
    '?authorization=' + encodeURIComponent(authorization) +
    '&date=' + encodeURIComponent(date) +
    '&host=' + host;
}

/* 语音听写：前端传 PCM（16kHz, 16bit, mono），返回识别文字
   accent 可选：mandarin / cantonese / henanese / sichuanese / hubeinese 等 */
function xfyunIat(pcmBuffer, accent) {
  return new Promise(function (resolve, reject) {
    var cfg = voiceConfig.xfyun;
    var url = xfyunAuth('iat-api.xfyun.cn', '/v2/iat', cfg.apiKey, cfg.apiSecret);
    var ws = new WebSocket(url);
    var resultText = '';
    var settled = false;

    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      reject(new Error('识别超时（30秒）'));
    }, 30000);

    ws.on('open', function () {
      var frameSize = 1280;  // 16kHz 16bit mono = 40ms / 帧
      var offset = 0;
      var total = pcmBuffer.length;

      function sendFrame() {
        var isFirst = offset === 0;
        var isLast = offset + frameSize >= total;
        var chunk = pcmBuffer.slice(offset, Math.min(offset + frameSize, total));
        offset += frameSize;

        var frame;
        if (isFirst) {
          frame = {
            common: { app_id: cfg.appId },
            business: {
              language: 'zh_cn',
              domain: 'iat',
              accent: accent || 'mandarin',
              vad_eos: 10000
            },
            data: {
              status: isLast ? 2 : 0,
              format: 'audio/L16;rate=16000',
              audio: chunk.toString('base64'),
              encoding: 'raw'
            }
          };
        } else {
          frame = {
            data: {
              status: isLast ? 2 : 1,
              format: 'audio/L16;rate=16000',
              audio: chunk.toString('base64'),
              encoding: 'raw'
            }
          };
        }
        ws.send(JSON.stringify(frame));

        if (!isLast) {
          setTimeout(sendFrame, 40);  // 讯飞要求每帧间隔约 40ms
        }
      }
      sendFrame();
    });

    ws.on('message', function (data) {
      try {
        var obj = JSON.parse(data.toString());
        if (obj.code !== 0) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          reject(new Error((obj.message || '识别失败') + '（code=' + obj.code + '）'));
          return;
        }
        if (obj.data && obj.data.result && obj.data.result.ws) {
          var segText = '';
          obj.data.result.ws.forEach(function (item) {
            if (item.cw) {
              item.cw.forEach(function (w) {
                if (w.w) segText += w.w;
              });
            }
          });
          resultText += segText;
        }
        if (obj.data && obj.data.status === 2) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          var t = resultText.trim();
          if (t) resolve(t);
          else reject(new Error('识别结果为空'));
        }
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });

    ws.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('WebSocket连接错误：' + (err.message || err)));
    });

    ws.on('close', function () {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (resultText.trim()) resolve(resultText.trim());
      else reject(new Error('连接已关闭，未收到识别结果'));
    });
  });
}

/* 语音合成：文字转 MP3
   speed 范围 0~100，vcn 发音人默认 xiaoyan（小燕，女声） */
function xfyunTts(text, speed, vcn) {
  return new Promise(function (resolve, reject) {
    var cfg = voiceConfig.xfyun;
    var url = xfyunAuth('tts-api.xfyun.cn', '/v2/tts', cfg.apiKey, cfg.apiSecret);
    var ws = new WebSocket(url);
    var audioChunks = [];
    var settled = false;

    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      reject(new Error('合成超时（30秒）'));
    }, 30000);

    ws.on('open', function () {
      var spd = Math.round(speed || 50);
      spd = Math.max(0, Math.min(100, spd));
      var frame = {
        common: { app_id: cfg.appId },
        business: {
          aue: 'lame',
          sfl: 1,
          auf: 'audio/L16;rate=16000',
          vcn: vcn || 'nannan',
          speed: spd,
          volume: 60,
          pitch: 50,
          bgs: 0,
          tte: 'UTF8'
        },
        data: {
          status: 2,
          text: Buffer.from(text, 'utf8').toString('base64')
        }
      };
      ws.send(JSON.stringify(frame));
    });

    ws.on('message', function (data) {
      try {
        var obj = JSON.parse(data.toString());
        if (obj.code !== 0) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          reject(new Error((obj.message || '合成失败') + '（code=' + obj.code + '）'));
          return;
        }
        if (obj.data && obj.data.audio) {
          audioChunks.push(Buffer.from(obj.data.audio, 'base64'));
        }
        if (obj.data && obj.data.status === 2) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          var mp3 = Buffer.concat(audioChunks);
          if (mp3.length === 0) reject(new Error('合成结果为空'));
          else resolve(mp3);
        }
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });

    ws.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('WebSocket连接错误：' + (err.message || err)));
    });

    ws.on('close', function () {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (audioChunks.length) resolve(Buffer.concat(audioChunks));
      else reject(new Error('连接已关闭，未收到音频'));
    });
  });
}

function readJsonWithBackup(file, fallback) {
  var candidates = [file, file + '.bak'];
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) {
        var parsed = JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
        if (i > 0) {
          try { fs.copyFileSync(candidates[i], file); } catch (e) {}
          console.log('已从备份恢复数据文件：' + path.basename(file));
        }
        return parsed;
      }
    } catch (e) {}
  }
  return fallback;
}

/* 老人发给家人的协同事件：带确认、联系、处置和升级状态。 */
var NOTICE_FILE = path.join(DATA_DIR, 'notices.json');
var elderNotices = readJsonWithBackup(NOTICE_FILE, []);
if (!Array.isArray(elderNotices)) elderNotices = [];

elderNotices = elderNotices.slice(0, 100).map(function (n) {
  n.id = n.id || ('n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
  n.status = n.status || 'pending';
  n.at = Number(n.at) || Date.now();
  n.deadlineAt = Number(n.deadlineAt) || (n.at + 5 * 60 * 1000);
  return n;
});

function saveNotices() {
  return writeJsonAtomic(NOTICE_FILE, elderNotices.slice(0, 100));
}

/*
 * 可选的离线告警出口。部署者可以把 WEIGUANG_ALERT_WEBHOOK 指向企业微信
 * 机器人、自动化平台或自己的短信网关。未配置时事件仍保存在家庭端。
 */
function deliverAlertWebhook(notice, eventName, attempt, targetUrl) {
  var webhookUrl = String(targetUrl || ALERT_WEBHOOK || '').trim();
  if (!webhookUrl || !notice) return;
  if (notice.status === 'resolved') return;
  var retryAttempt = Number(attempt) || 0;
  var maxAttempts = 3;
  notice.delivery = retryAttempt ? 'retrying' : 'pending';
  notice.deliveryAt = Date.now();
  saveNotices();
  var target;
  try {
    target = new URL(webhookUrl);
  } catch (e) {
    return;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return;
  var payload = JSON.stringify({
    event: eventName || 'weiguang.care.alert',
    id: notice.id,
    level: notice.level,
    kind: notice.kind,
    text: notice.text,
    at: notice.at,
    status: notice.status,
    attempt: retryAttempt + 1
  });
  var settled = false;
  function retryOrFail() {
    if (settled) return false;
    settled = true;
    if (retryAttempt + 1 < maxAttempts) {
      notice.delivery = 'retrying';
      notice.deliveryAt = Date.now();
      saveNotices();
      var delay = retryAttempt === 0 ? 1000 : 5000;
      var retryTimer = setTimeout(function () {
        deliverAlertWebhook(notice, eventName, retryAttempt + 1, webhookUrl);
      }, delay);
      if (retryTimer && retryTimer.unref) retryTimer.unref();
      return true;
    }
    notice.delivery = 'failed';
    notice.deliveryAt = Date.now();
    saveNotices();
    return false;
  }
  var transport = target.protocol === 'http:' ? http : https;
  var request = transport.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + (target.search || ''),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 5000
  }, function (response) {
    response.resume();
    if (response.statusCode >= 200 && response.statusCode < 300) {
      settled = true;
      notice.delivery = 'sent';
      notice.deliveryAt = Date.now();
      notice.deliveryEvent = eventName || 'weiguang.care.alert';
      saveNotices();
    } else {
      retryOrFail();
    }
  });
  request.on('timeout', function () { request.destroy(new Error('webhook timeout')); });
  request.on('error', retryOrFail);
  request.end(payload);
}

function isUnresolvedNotice(n) {
  return n && n.status !== 'resolved';
}

function resumePendingWebhookDeliveries() {
  if (!ALERT_WEBHOOK) return;
  elderNotices.forEach(function (notice) {
    if (notice.level === 'high' &&
        (notice.delivery === 'pending' || notice.delivery === 'retrying')) {
      deliverAlertWebhook(
        notice,
        notice.status === 'escalated' ? 'weiguang.care.escalated' : 'weiguang.care.alert'
      );
    }
  });
}

var webhookResumeTimer = setTimeout(resumePendingWebhookDeliveries, 2000);
if (webhookResumeTimer && webhookResumeTimer.unref) webhookResumeTimer.unref();

function updateNoticeEvents(ids, action) {
  var wanted = Array.isArray(ids) ? ids : [];
  var now = Date.now();
  var changed = 0;
  var snapshot = elderNotices.map(function (notice) { return Object.assign({}, notice); });
  elderNotices.forEach(function (n) {
    if (wanted.indexOf(n.id) < 0) return;
    if (action === 'ack' && (n.status === 'pending' || n.status === 'escalated')) {
      n.status = 'acknowledged';
      n.acknowledgedAt = now;
    } else if (action === 'contact') {
      n.status = 'contacted';
      n.contactedAt = now;
      n.acknowledgedAt = n.acknowledgedAt || now;
    } else if (action === 'resolve') {
      n.status = 'resolved';
      n.resolvedAt = now;
      n.acknowledgedAt = n.acknowledgedAt || now;
    } else {
      return;
    }
    n.updatedAt = now;
    changed++;
  });
  if (changed && !saveNotices()) {
    elderNotices = snapshot;
    return -1;
  }
  return changed;
}

function noticeMetrics() {
  var unresolved = elderNotices.filter(isUnresolvedNotice);
  var acked = elderNotices.filter(function (n) {
    return n.acknowledgedAt && n.at;
  });
  var avgAckMs = 0;
  if (acked.length) {
    avgAckMs = Math.round(acked.reduce(function (sum, n) {
      return sum + Math.max(0, n.acknowledgedAt - n.at);
    }, 0) / acked.length);
  }
  return {
    total: elderNotices.length,
    unresolved: unresolved.length,
    pending: unresolved.filter(function (n) { return n.status === 'pending'; }).length,
    escalated: unresolved.filter(function (n) { return n.status === 'escalated'; }).length,
    failedDeliveries: unresolved.filter(function (n) { return n.delivery === 'failed'; }).length,
    avgAckMs: avgAckMs
  };
}

/* 本地演示版没有外部短信通道，但会把超时事件标成“已升级”，
   家人端可以据此继续联系备用联系人。 */
function escalateOverdueNotices() {
  var now = Date.now();
  var changed = 0;
  var escalated = [];
  elderNotices.forEach(function (n) {
    if ((n.status === 'pending' || n.status === 'acknowledged') &&
        now > (n.deadlineAt || now) && n.status !== 'contacted') {
      n.status = 'escalated';
      n.escalatedAt = n.escalatedAt || now;
      escalated.push(n);
      changed++;
    }
  });
  if (changed) {
    if (!saveNotices()) return -1;
    escalated.forEach(function (notice) {
      deliverAlertWebhook(notice, 'weiguang.care.escalated');
      if (ESCALATION_WEBHOOK && ESCALATION_WEBHOOK !== ALERT_WEBHOOK) {
        deliverAlertWebhook(notice, 'weiguang.care.escalated', 0, ESCALATION_WEBHOOK);
      }
    });
  }
  return changed;
}

var noticeTimer = setInterval(escalateOverdueNotices, 30 * 1000);
if (noticeTimer && noticeTimer.unref) noticeTimer.unref();

function writeJsonAtomic(file, value) {
  var tmp = file + '.tmp';
  var backup = file + '.bak';
  var fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, backup); } catch (e) {}
    }
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, JSON.stringify(value, null, 1), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (ignore) {}
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (ignore) {}
    console.log('[' + new Date().toLocaleTimeString() + '] 数据保存失败：' + e.message);
    return false;
  }
}

/* 家人留言和老人最新状态持久化到数据目录，服务重启后继续可用。 */
var MESSAGE_FILE = path.join(DATA_DIR, 'family-messages.json');
var STATE_FILE = path.join(DATA_DIR, 'elder-state.json');
var familyMsgs = readJsonWithBackup(MESSAGE_FILE, []);
var state = readJsonWithBackup(STATE_FILE, null);
var stateAt = 0;

if (!Array.isArray(familyMsgs)) familyMsgs = [];
stateAt = Number(state && state.receivedAt) || 0;

function saveFamilyMessages() {
  return writeJsonAtomic(MESSAGE_FILE, familyMsgs.slice(0, 50));
}

function saveElderState() {
  return writeJsonAtomic(STATE_FILE, state);
}

/*
 * 服务端看护哨兵：不再只依赖老人端页面里的 setInterval。
 * 只要老人端曾经同步过，服务重启后也能根据最后一次活动时间补发告警。
 * 家人页面关闭时不会产生系统推送，但事件会留在服务端，供家人下次打开查看。
 */
function addWatchdogNotice(key, text, kind, level) {
  if (elderNotices.some(function (n) {
    return n.watchdogKey === key && isUnresolvedNotice(n);
  })) {
    return false;
  }
  var now = Date.now();
  var high = level === 'high';
  var id = 'watchdog-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  if (elderNotices.some(function (n) { return n.id === id; })) return false;
  var n = {
    id: id,
    watchdogKey: key,
    source: 'care-watchdog',
    text: String(text).slice(0, 500),
    kind: String(kind || '自动看护').slice(0, 12),
    level: high ? 'high' : 'normal',
    status: 'pending',
    at: now,
    createdAt: now,
    deadlineAt: now + (high ? HIGH_ESCALATE_MS : NORMAL_ESCALATE_MS)
  };
  elderNotices.unshift(n);
  if (elderNotices.length > 100) elderNotices.length = 100;
  if (!saveNotices()) {
    elderNotices = elderNotices.filter(function (notice) { return notice.id !== n.id; });
    return false;
  }
  if (high) deliverAlertWebhook(n);
  console.log('[' + new Date().toLocaleTimeString() + '] 服务端看护告警：' +
    n.kind + '（' + n.id + '）');
  return true;
}

function runCareWatchdog() {
  if (!state || !state.lastActiveAt) return 0;
  var now = Date.now();
  var last = Number(state.lastActiveAt) || 0;
  var limitHours = Math.max(0.25, Number(state.inactiveLimit) || 8);
  var created = 0;
  var name = state.elderName || '老人';
  // 老人端会先主动询问，服务端多等 5 分钟再兜底，避免双重告警。
  var inactiveThresholdMs = limitHours * 3600000 + 5 * 60 * 1000;
  if (last && now - last >= inactiveThresholdMs) {
    if (addWatchdogNotice(
      'inactive:' + last + ':' + limitHours,
      name + '已超过 ' + limitHours + ' 小时没有活动，请尽快电话确认。最后活动时间：' +
        new Date(last).toLocaleString('zh-CN'),
      '自动看护',
      'high'
    )) created++;
  }
  var fence = state.fence;
  if (fence && fence.away && state.location && state.location.at) {
    if (addWatchdogNotice(
      'fence:' + state.location.at + ':' + Math.round(Number(fence.distance) || 0),
      name + '已经离开活动范围约 ' + Math.round(Number(fence.distance) || 0) + ' 米，请确认位置。',
      '离开范围',
      'high'
    )) created++;
  }
  return created;
}

var watchdogInterval = Number(process.env.WEIGUANG_WATCHDOG_INTERVAL_MS) || 60 * 1000;
var careWatchdogTimer = setInterval(runCareWatchdog, Math.max(1000, watchdogInterval));
if (careWatchdogTimer && careWatchdogTimer.unref) careWatchdogTimer.unref();

/* Agent 运行轨迹：老人端每交互一次就送一条上来。
   落盘保存，服务重启也不丢，家人端和评委随时能查。 */
var TRACE_FILE = path.join(DATA_DIR, 'traces.json');
var traces = readJsonWithBackup(TRACE_FILE, []);
if (!Array.isArray(traces)) traces = [];

function saveTraces() {
  return writeJsonAtomic(TRACE_FILE, traces.slice(0, 200));
}

function pruneRetainedData() {
  var cutoff = Date.now() - RETENTION_DAYS * 86400000;
  var noticesBefore = elderNotices.length;
  var messagesBefore = familyMsgs.length;
  var tracesBefore = traces.length;
  elderNotices = elderNotices.filter(function (notice) {
    return isUnresolvedNotice(notice) || (Number(notice.at) || 0) >= cutoff;
  });
  familyMsgs = familyMsgs.filter(function (message) {
    return (Number(message.createdAt || message.at) || 0) >= cutoff;
  });
  traces = traces.filter(function (trace) {
    return (Number(trace.at) || 0) >= cutoff;
  });
  if (noticesBefore !== elderNotices.length) saveNotices();
  if (messagesBefore !== familyMsgs.length) saveFamilyMessages();
  if (tracesBefore !== traces.length) saveTraces();
}

var retentionTimer = setInterval(pruneRetainedData, 24 * 3600 * 1000);
if (retentionTimer && retentionTimer.unref) retentionTimer.unref();
setTimeout(pruneRetainedData, 1000).unref();

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8'
};

/* 大模型兜底：规则听不懂的老人话，交给大模型回答。
   任何 OpenAI 兼容接口都能用（DeepSeek / 讯飞星火 / 通义千问等）。 */
var llmConfig = null;
try {
  if (APP_CONFIG.llm && APP_CONFIG.llm.apiKey && String(APP_CONFIG.llm.apiKey).indexOf('在这里') < 0) {
    llmConfig = APP_CONFIG.llm;
  }
} catch (e) {}

var LLM_SYSTEM = [
  '你是"微光护老"，一台陪伴独居老人的语音助手。请严格遵守：',
  '1. 用口语化的普通话短句回答，总共不超过三句话，每句不超过二十个字。',
  '2. 不要用书面语和专业词，不要罗列条目，不要用任何符号格式。',
  '3. 语气温和、有耐心，像跟自家长辈说话。',
  '4. 如果对方说自己不舒服、摔倒、头晕等，先安抚，再建议联系家人或去医院。',
  '5. 不确定的事情就老实说不清楚，让对方问家里人，绝对不要编造。',
  '6. 不做医疗诊断，不给用药建议，可以把话题引向家人或医生。',
  '7. 回答里不要出现日期格式、编号和英文单词。'
].join('\n');

var AGENT_PLANNER_SYSTEM = [
  '你是“微光护老”的任务规划器。你不直接回答老人，而是把请求拆成可执行步骤。',
  '只输出一个 JSON 对象，不要输出 Markdown、代码块或解释。',
  'JSON 格式必须是：{"goal":"目标","risk":"normal|caution|urgent","steps":[{"tool":"工具名","args":{},"purpose":"步骤目的"}],"safetyNotes":["安全说明"],"spoken":"不超过三句的温和口语回答"}。',
  '只能使用给定工具，最多 6 步。不要编造现实中不存在的工具或结果。',
  '高风险的“摔倒、起不来、呼吸困难、胸口疼”等必须先检查平安状态并通知家人。',
  '不做医学诊断，不提供用药剂量建议。拨号只能 prepare_call，禁止声称已经拨出。',
  '如果只需要普通聊天，使用 converse，并且 spoken 要简短、温和、老实。',
  '可用工具：' + JSON.stringify(AgentCore.toolCatalog())
].join('\n');

function llmComplete(messages, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    if (!llmConfig) { reject(new Error('未配置大模型')); return; }
    var settled = false;
    function ok(value) { if (!settled) { settled = true; resolve(value); } }
    function fail(error) { if (!settled) { settled = true; reject(error); } }
    var body = JSON.stringify({
      model: llmConfig.model || 'deepseek-chat',
      messages: messages,
      temperature: options.temperature == null ? 0.7 : options.temperature,
      max_tokens: options.maxTokens || 300
    });
    var u;
    try { u = new URL(llmConfig.baseUrl); } catch (e) { reject(new Error('接口地址不对')); return; }
    var rq = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + llmConfig.apiKey,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 25000
    }, function (r) {
      var chunks = [];
      var size = 0;
      r.on('data', function (c) {
        size += c.length;
        if (size > 1024 * 1024) {
          rq.destroy(new Error('大模型响应过大'));
          return;
        }
        chunks.push(c);
      });
      r.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        try {
          var j = JSON.parse(raw);
          if (j.error) { fail(new Error(j.error.message || '大模型返回错误')); return; }
          var t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!t) { fail(new Error('大模型返回为空')); return; }
          ok(String(t).trim());
        } catch (e) { fail(new Error('大模型返回格式不对')); }
      });
    });
    rq.on('error', fail);
    rq.on('timeout', function () { rq.destroy(); fail(new Error('大模型超时')); });
    rq.write(body); rq.end();
  });
}

function llmChat(text) {
  return llmComplete([
    { role: 'system', content: LLM_SYSTEM },
    { role: 'user', content: text }
  ], { temperature: 0.7, maxTokens: 300 });
}

function parsePlanJson(raw) {
  var text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var start = text.indexOf('{');
  var end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

function sanitizeAgentContext(input) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  var medication = input.medication && typeof input.medication === 'object' ? input.medication : {};
  var care = input.care && typeof input.care === 'object' ? input.care : {};
  var contacts = Array.isArray(input.contacts) ? input.contacts : [];
  var facts = Array.isArray(input.memoryFacts) ? input.memoryFacts : [];
  var turns = Array.isArray(input.recentTurns) ? input.recentTurns : [];
  return {
    privacyMinimized: true,
    elderName: String(input.elderName || '老人').slice(0, 30),
    city: String(input.city || '').slice(0, 30),
    medication: {
      total: Math.max(0, Math.min(100, Number(medication.total) || 0)),
      done: Math.max(0, Math.min(100, Number(medication.done) || 0)),
      names: (Array.isArray(medication.names) ? medication.names : []).slice(0, 4)
        .map(function (name) { return String(name || '').slice(0, 40); })
        .filter(Boolean)
    },
    care: {
      inactiveHours: Math.max(0, Number(care.inactiveHours) || 0),
      inactiveLimit: Math.max(0, Number(care.inactiveLimit) || 0),
      inactiveAlert: !!care.inactiveAlert
    },
    contacts: contacts.slice(0, 4).map(function (contact) {
      return { name: String((contact && contact.name) || '').slice(0, 30) };
    }).filter(function (contact) { return !!contact.name; }),
    memoryFacts: facts.slice(0, 3).map(function (fact) {
      return String(fact || '').slice(0, 120);
    }).filter(Boolean),
    recentTurns: turns.slice(0, 2).map(function (turn) {
      return {
        user: String((turn && turn.user) || '').slice(0, 120),
        assistant: String((turn && turn.assistant) || '').slice(0, 120)
      };
    })
  };
}

function llmPlan(text, context) {
  var contextText = JSON.stringify(sanitizeAgentContext(context), null, 0).slice(0, 5000);
  return llmComplete([
    { role: 'system', content: AGENT_PLANNER_SYSTEM },
    {
      role: 'user',
      content: '老人请求：' + text + '\n可用上下文（只用于规划）：' + contextText
    }
  ], { temperature: 0.1, maxTokens: 900 }).then(function (raw) {
    var parsed;
    try { parsed = parsePlanJson(raw); }
    catch (e) { throw new Error('Agent 计划不是合法 JSON'); }
    var plan = AgentCore.normalizePlan(parsed, text);
    if (!plan) throw new Error('Agent 计划为空');
    return plan;
  });
}

/* 地图导航：高德 Web 服务 API（服务端代理，密钥不下发前端）
   密钥来源：1) 项目外私有配置 map.key；2) 部署平台环境变量 AMAP_KEY（公开仓库推荐用这个） */
var mapConfig = null;
try {
  if (APP_CONFIG && APP_CONFIG.map && APP_CONFIG.map.key && String(APP_CONFIG.map.key).indexOf('在这里') < 0) {
    mapConfig = APP_CONFIG.map;
  } else if (process.env.AMAP_KEY) {
    mapConfig = { provider: 'amap', key: String(process.env.AMAP_KEY) };
  }
} catch (e) {}

function httpsGetJson(url) {
  return new Promise(function (resolve, reject) {
    var request = https.get(url, function (r) {
      var c = [];
      var size = 0;
      r.on('data', function (x) {
        size += x.length;
        if (size > 2 * 1024 * 1024) {
          request.destroy(new Error('地图接口响应过大'));
          return;
        }
        c.push(x);
      });
      r.on('end', function () {
        var raw = Buffer.concat(c).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('地图接口返回格式不对')); }
      });
    });
    request.setTimeout(15000, function () {
      request.destroy(new Error('地图接口超时'));
    });
    request.on('error', reject);
  });
}

function amapBase(pathname) {
  return 'https://restapi.amap.com' + pathname + '?key=' + encodeURIComponent(mapConfig.key);
}

function amapSearch(keywords, city) {
  var u = amapBase('/v3/place/text') +
    '&keywords=' + encodeURIComponent(keywords) +
    '&city=' + encodeURIComponent(city || '') +
    '&citylimit=' + (city ? 'true' : 'false') + '&offset=5&page=1&extensions=base';
  return httpsGetJson(u);
}

function amapRoute(mode, from, to) {
  var path = (mode === 'walking') ? '/v3/direction/walking' : '/v3/direction/driving';
  var u = amapBase(path) + '&origin=' + from + '&destination=' + to + '&extensions=all';
  if (mode !== 'walking') u += '&strategy=0';
  return httpsGetJson(u);
}

function buildNavRoutes(rs) {
  var out = [];
  var defs = [['步行', rs[0], 1], ['驾车', rs[1], 2]];
  defs.forEach(function (d) {
    var data = d[1];
    if (!data || data.status !== '1' || !data.route || !data.route.paths) return;
    data.route.paths.slice(0, d[2]).forEach(function (p) {
      out.push({
        mode: d[0],
        distance: Number(p.distance) || 0,
        duration: Number(p.duration) || 0,
        tolls: Number(p.tolls) || 0,
        steps: (p.steps || []).slice(0, 8).map(function (st) { return st.instruction || ""; }).filter(Boolean),
        polyline: (function () {
          var pts = [];
          (p.steps || []).forEach(function (st) {
            if (!st.polyline) return;
            st.polyline.split(';').forEach(function (xy) {
              var a = xy.split(',');
              if (a.length === 2 && isFinite(Number(a[0])) && isFinite(Number(a[1]))) {
                pts.push({ lon: Number(a[0]), lat: Number(a[1]) });
              }
            });
          });
          return pts;
        })()
      });
    });
  });
  return out;
}

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(self)');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https: wss: http:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  if (req.socket && req.socket.encrypted) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

var RATE_LIMITS = Object.create(null);
function allowRequest(req, bucket, max, windowMs) {
  var ip = String((req.socket && req.socket.remoteAddress) || 'unknown');
  var key = bucket + ':' + ip;
  var now = Date.now();
  var item = RATE_LIMITS[key];
  if (!item || now - item.startedAt >= windowMs) {
    RATE_LIMITS[key] = { startedAt: now, count: 1 };
    return true;
  }
  item.count++;
  return item.count <= max;
}

var rateLimitCleanupTimer = setInterval(function () {
  var cutoff = Date.now() - 10 * 60 * 1000;
  Object.keys(RATE_LIMITS).forEach(function (key) {
    if (RATE_LIMITS[key].startedAt < cutoff) delete RATE_LIMITS[key];
  });
}, 5 * 60 * 1000);
if (rateLimitCleanupTimer && rateLimitCleanupTimer.unref) rateLimitCleanupTimer.unref();

/*
 * 读取有上限的请求体。超限后继续丢弃数据但不再累积到内存，
 * 并且只返回一次 413，避免慢速大请求拖垮同步服务。
 */
function readLimitedBody(req, res, limit, onDone) {
  var chunks = [];
  var size = 0;
  var tooLarge = false;
  var finished = false;
  req.on('data', function (chunk) {
    if (tooLarge || finished) return;
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      chunks = [];
      res.setHeader('Connection', 'close');
      sendJson(res, 413, { ok: false, error: '请求内容过大' });
      res.on('finish', function () {
        if (!req.destroyed) req.destroy();
      });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function () {
    if (tooLarge || finished) return;
    finished = true;
    onDone(null, Buffer.concat(chunks));
  });
  req.on('error', function (err) {
    if (tooLarge || finished) return;
    finished = true;
    sendJson(res, 400, { ok: false, error: err.message || '读取请求失败' });
  });
}

function readJsonBody(req, res, limit, onDone) {
  readLimitedBody(req, res, limit, function (err, buffer) {
    if (err) return;
    var obj;
    try {
      obj = JSON.parse(buffer.toString('utf8'));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'JSON格式错误' });
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      sendJson(res, 400, { ok: false, error: 'JSON内容必须是对象' });
      return;
    }
    onDone(obj);
  });
}

function normalizeIds(value, max) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max || 30).map(function (id) {
    return String(id || '').slice(0, 80);
  }).filter(Boolean);
}

/* 本机在局域网里的 IPv4 地址 */
function lanAddresses() {
  var out = [];
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (i) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    });
  });
  return out;
}

function serveStatic(req, res, urlPath) {
  var rel = urlPath === '/' ? '/index.html' : urlPath;
  // 只公开页面资源。密钥、证书、轨迹和日志不能被静态下载。
  if (!/\.(?:html|css|js|svg|png|ico|md)$/i.test(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  // 防止跳出目录
  var file = path.normalize(path.join(ROOT, rel));
  var relative = path.relative(ROOT, file);
  if (relative.indexOf('..') === 0 || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到这个文件');
      return;
    }
    var ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

function handle(req, res) {
  setSecurityHeaders(req, res);
  var url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    sendJson(res, 400, { ok: false, error: '请求地址格式不正确' });
    return;
  }
  var p = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* ---------- 配对与会话 ---------- */
  if (p === '/api/pair/claim') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持POST' }); return; }
    if (pairBlocked(req)) {
      sendJson(res, 429, { ok: false, error: '配对失败次数过多，请稍后再试' });
      return;
    }
    readJsonBody(req, res, 4 * 1024, function (obj) {
      var code = String(obj.code || '').trim();
      var a = Buffer.from(code);
      var b = Buffer.from(String(authState.pairCode));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        recordPairFailure(req);
        sendJson(res, 403, { ok: false, error: '配对码不正确' });
        return;
      }
      delete pairFailures[String((req.socket && req.socket.remoteAddress) || 'unknown')];
      setAuthCookie(req, res);
      sendJson(res, 200, { ok: true, paired: true });
    });
    return;
  }

  if (p === '/api/auth/session') {
    if (!hasAuth(req)) { sendJson(res, 401, { ok: false, error: '需要配对' }); return; }
    sendJson(res, 200, { ok: true, paired: true });
    return;
  }

  if (p === '/api/pair/info') {
    if (!hasAuth(req)) { sendJson(res, 401, { ok: false, error: '需要配对' }); return; }
    sendJson(res, 200, { ok: true, pairCode: authState.pairCode });
    return;
  }

  if (p === '/api/pair/rotate') {
    if (!hasAuth(req)) { sendJson(res, 401, { ok: false, error: '需要配对' }); return; }
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持POST' }); return; }
    authState.pairCode = newPairCode();
    authState.rotatedAt = Date.now();
    writeJsonAtomic(AUTH_FILE, authState);
    sendJson(res, 200, { ok: true, pairCode: authState.pairCode });
    return;
  }

  /* 查询健康状态和工具清单不包含老人数据，其余 API 必须配对。 */
  if (p.indexOf('/api/') === 0 &&
      p !== '/api/ping' &&
      p !== '/api/agent/tools' &&
      !hasAuth(req)) {
    sendJson(res, 401, { ok: false, error: '需要先完成家庭配对' });
    return;
  }

  /* ---------- 状态接口 ---------- */
  if (p === '/api/state') {
    if (req.method === 'POST') {
      readJsonBody(req, res, 512 * 1024, function (obj) {
        var previousState = state;
        var previousStateAt = stateAt;
        obj.receivedAt = Date.now();
        state = obj;
        stateAt = Date.now();
        if (!saveElderState()) {
          state = previousState;
          stateAt = previousStateAt;
          sendJson(res, 503, { ok: false, error: '家庭服务暂时无法保存老人状态' });
          return;
        }
        var watchdogCreated = runCareWatchdog();
        sendJson(res, 200, { ok: true, receivedAt: stateAt, watchdogCreated: watchdogCreated });
        console.log('[' + new Date().toLocaleTimeString() + '] 收到老人端同步：用药 ' +
          (obj.medDone || 0) + '/' + (obj.medTotal || 0) +
          '，预警 ' + ((obj.alerts || []).length) + ' 条');
      });
      return;
    }
    if (!state) { sendJson(res, 200, { empty: true }); return; }
    sendJson(res, 200, state);
    return;
  }

  /* ---------- 健康检查 ---------- */
  if (p === '/api/ping') {
    sendJson(res, 200, {
      ok: true,
      service: 'weiguang-sync',
      hasState: !!state,
      stateAt: stateAt,
      configReady: !!APP_CONFIG,
      configExternal: !!APP_CONFIG_FILE && path.dirname(APP_CONFIG_FILE) !== __dirname,
      authMode: AUTH_MODE,
      voiceReady: !!voiceConfig,
      llmReady: !!llmConfig,
      agentReady: !!llmConfig,
      mapReady: !!mapConfig,
      careWatchdogReady: true,
      alertWebhookReady: !!ALERT_WEBHOOK,
      escalationWebhookReady: !!ESCALATION_WEBHOOK,
      retentionDays: RETENTION_DAYS,
      port: server.address() ? server.address().port : PORT,
      addresses: lanAddresses()
    });
    return;
  }

  /* ---------- Agent 工具清单：展示能力边界，也供前端校验 ---------- */
  if (p === '/api/agent/tools') {
    sendJson(res, 200, {
      ok: true,
      architecture: 'planner + tools + memory + safety gate + trace',
      tools: AgentCore.toolCatalog()
    });
    return;
  }

  /* ---------- Agent 远程规划：模型只产出计划，本地负责执行和安全门 ---------- */
  if (p === '/api/agent/plan') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持POST' }); return; }
    if (!allowRequest(req, 'agent-plan', 20, 60 * 1000)) {
      sendJson(res, 429, { ok: false, error: '规划请求过于频繁，请稍后再试' });
      return;
    }
    if (!llmConfig) {
      sendJson(res, 503, { ok: false, error: '未配置大模型，已自动使用本地 Agent 规划' });
      return;
    }
    readJsonBody(req, res, 64 * 1024, function (obj) {
      var text = String(obj.text || '').trim().slice(0, 500);
      if (!text) { sendJson(res, 400, { ok: false, error: 'text不能为空' }); return; }
      var t0 = Date.now();
      llmPlan(text, obj.context || {}).then(function (plan) {
        plan.elapsedMs = Date.now() - t0;
        sendJson(res, 200, { ok: true, plan: plan });
        console.log('[' + new Date().toLocaleTimeString() + '] Agent 规划完成：' +
          plan.steps.length + ' 步，' + plan.risk);
      }).catch(function (e) {
        sendJson(res, 200, { ok: false, error: e.message });
        console.log('[' + new Date().toLocaleTimeString() + '] Agent 规划失败：' + e.message);
      });
    });
    return;
  }

  /* ---------- Agent 运行轨迹：老人端送上来，家人端/评委读走 ---------- */
  if (p === '/api/trace') {
    if (req.method === 'POST') {
      readJsonBody(req, res, 256 * 1024, function (o) {
        if (!o.id) { sendJson(res, 400, { ok: false, error: '缺少轨迹内容' }); return; }
        var previousTraces = traces.slice();
        traces.unshift(o);
        if (traces.length > 200) traces.length = 200;
        if (!saveTraces()) {
          traces = previousTraces;
          sendJson(res, 503, { ok: false, error: '家庭服务暂时无法保存 Agent 轨迹' });
          return;
        }
        var intent = '';
        (o.steps || []).forEach(function (s) { if (s.name === '理解' && !intent) intent = s.note; });
        console.log('[' + new Date().toLocaleTimeString() + '] Agent 轨迹：' +
          (VERBOSE_LOGS && o.heard ? '「' + o.heard + '」→ ' : '') + (intent || '-') +
          '（' + (o.ms || 0) + 'ms）');
        sendJson(res, 200, { ok: true, count: traces.length });
      });
      return;
    }
    sendJson(res, 200, { ok: true, traces: traces.slice(0, 100) });
    return;
  }

  /* ---------- 语音识别（前端传 PCM 二进制，可选 ?accent=方言） ---------- */
  if (p === '/api/asr') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持POST' }); return; }
    if (!allowRequest(req, 'asr', 30, 60 * 1000)) {
      sendJson(res, 429, { ok: false, error: '语音识别请求过于频繁，请稍后再试' });
      return;
    }
    if (!voiceConfig) { sendJson(res, 503, { ok: false, error: '语音服务未配置密钥' }); return; }
    var accent = url.searchParams.get('accent') || 'mandarin';
    readLimitedBody(req, res, 10 * 1024 * 1024, function (err, pcm) {
      if (err) return;
      if (pcm.length < 6400) { sendJson(res, 400, { ok: false, error: '音频太短' }); return; }
      xfyunIat(pcm, accent).then(function (text) {
        sendJson(res, 200, { ok: true, text: text });
        console.log('[' + new Date().toLocaleTimeString() + '] 语音识别完成（' + accent +
          '，' + text.length + ' 字）');
      }).catch(function (e) {
        sendJson(res, 500, { ok: false, error: e.message });
        console.log('[' + new Date().toLocaleTimeString() + '] 语音识别失败：' + e.message);
      });
    });
    return;
  }

  /* ---------- 语音合成（返回 MP3） ---------- */
  if (p === '/api/tts') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持POST' }); return; }
    if (!allowRequest(req, 'tts', 40, 60 * 1000)) {
      sendJson(res, 429, { ok: false, error: '语音播报请求过于频繁，请稍后再试' });
      return;
    }
    if (!voiceConfig) { sendJson(res, 503, { ok: false, error: '语音服务未配置密钥' }); return; }
    readJsonBody(req, res, 32 * 1024, function (obj) {
      var text = String(obj.text || '').trim();
      var rate = Number(obj.rate) || 0.85;
      // 前端 rate 0.6~1.3 映射到讯飞 speed 0~100
      var xfSpeed = Math.round(((rate - 0.6) / 0.7) * 100);
      xfSpeed = Math.max(0, Math.min(100, xfSpeed));
      if (!text) { sendJson(res, 400, { error: 'text不能为空' }); return; }
      if (text.length > 2000) { sendJson(res, 400, { error: '文字太长（上限2000字）' }); return; }
      xfyunTts(text, xfSpeed, String(obj.vcn || '').slice(0, 40)).then(function (audioBuf) {
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audioBuf.length,
          'Cache-Control': 'no-store'
        });
        res.end(audioBuf);
      }).catch(function (e) {
        sendJson(res, 500, { ok: false, error: e.message });
        console.log('[' + new Date().toLocaleTimeString() + '] 语音合成失败：' + e.message);
      });
    });
    return;
  }

  /* ---------- 大模型兜底 ---------- */
  if (p === '/api/chat') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持POST' }); return; }
    if (!allowRequest(req, 'chat', 30, 60 * 1000)) {
      sendJson(res, 429, { ok: false, error: '对话请求过于频繁，请稍后再试' });
      return;
    }
    readJsonBody(req, res, 16 * 1024, function (obj) {
      var txt = String(obj.text || '').trim();
      if (!txt) { sendJson(res, 400, { ok: false, error: 'text不能为空' }); return; }
      txt = txt.slice(0, 500);
      llmChat(txt).then(function (answer) {
        sendJson(res, 200, { ok: true, text: answer });
        console.log('[' + new Date().toLocaleTimeString() + '] 大模型完成（输入 ' +
          txt.length + ' 字，输出 ' + answer.length + ' 字）');
      }).catch(function (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      });
    });
    return;
  }

  /* ---------- 导航：搜地点 + 规划路线 ---------- */
  if (p === '/api/nav') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持POST' }); return; }
    if (!allowRequest(req, 'nav', 30, 60 * 1000)) {
      sendJson(res, 429, { ok: false, error: '导航请求过于频繁，请稍后再试' });
      return;
    }
    if (!mapConfig) { sendJson(res, 200, { ok: false, error: '还没有配置地图密钥' }); return; }
    readJsonBody(req, res, 16 * 1024, function (o) {
      var kw = String(o.text || '').trim();
      var city = String(o.city || '').trim();
      var from = o.from;
      if (!kw) { sendJson(res, 200, { ok: false, error: '没有听清要去哪' }); return; }
      amapSearch(kw, city).then(function (r1) {
        if (r1.status !== '1' || !r1.pois || !r1.pois.length) {
          sendJson(res, 200, { ok: false, error: '没找到这个地方：' + kw });
          return null;
        }
        var poi = r1.pois[0];
        var dest = { name: poi.name, address: poi.address || '', location: poi.location };
        var fromStr = from ? (from.lon + ',' + from.lat) : '';
        if (!fromStr) { sendJson(res, 200, { ok: true, dest: dest, routes: [] }); return null; }
        return Promise.all([
          amapRoute('walking', fromStr, poi.location).catch(function () { return null; }),
          amapRoute('driving', fromStr, poi.location).catch(function () { return null; })
        ]).then(function (rs) {
          var routes = buildNavRoutes(rs);
          sendJson(res, 200, { ok: true, dest: dest, routes: routes });
          console.log('[' + new Date().toLocaleTimeString() + '] 导航：' + kw + ' → ' + dest.name + '，' + routes.length + ' 条路线');
        });
      }).catch(function (e) {
        sendJson(res, 200, { ok: false, error: '地图服务连不上：' + e.message });
      });
    });
    return;
  }

  /* ---------- 家人留言：家人写，老人端取 ---------- */
  if (p === '/api/family/msg') {
    if (req.method === 'POST') {
      readJsonBody(req, res, 16 * 1024, function (o) {
        var txt = String(o.text || '').trim();
        if (!txt) { sendJson(res, 400, { ok: false, error: '内容不能为空' }); return; }
        var m = {
          id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          text: txt.slice(0, 200),
          at: o.at ? Number(o.at) : 0,
          createdAt: Date.now()
        };
        var previousMessages = familyMsgs.slice();
        familyMsgs.push(m);
        if (familyMsgs.length > 50) familyMsgs.shift();
        if (!saveFamilyMessages()) {
          familyMsgs = previousMessages;
          sendJson(res, 503, { ok: false, error: '家庭服务暂时无法保存留言' });
          return;
        }
        console.log('[' + new Date().toLocaleTimeString() + '] 家人留言已保存（' + m.id + '）');
        sendJson(res, 200, { ok: true, id: m.id });
      });
      return;
    }
    sendJson(res, 200, { ok: true, msgs: familyMsgs });
    return;
  }

  if (p === '/api/family/msg/ack') {
    readJsonBody(req, res, 16 * 1024, function (o) {
      var ids = normalizeIds(o.ids, 50);
      var previous = familyMsgs.slice();
      familyMsgs = familyMsgs.filter(function (m) { return ids.indexOf(m.id) < 0; });
      if (!saveFamilyMessages()) {
        familyMsgs = previous;
        sendJson(res, 503, { ok: false, error: '家庭服务暂时无法保存确认状态' });
        return;
      }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  /* ---------- 老人 → 家人：协同事件通道 ---------- */
  if (p === '/api/family/events' && req.method === 'GET') {
    runCareWatchdog();
    escalateOverdueNotices();
    var eventList = elderNotices.slice().sort(function (a, b) {
      return (b.at || 0) - (a.at || 0);
    }).slice(0, 50);
    sendJson(res, 200, { ok: true, events: eventList, metrics: noticeMetrics() });
    return;
  }

  if (p === '/api/family/events/update') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持POST' }); return; }
    readJsonBody(req, res, 16 * 1024, function (o) {
      var action = String(o.action || '');
      if (['ack', 'contact', 'resolve'].indexOf(action) < 0) {
        sendJson(res, 400, { ok: false, error: 'action只能是ack、contact或resolve' });
        return;
      }
      var changed = updateNoticeEvents(normalizeIds(o.ids, 50), action);
      if (changed < 0) {
        sendJson(res, 503, { ok: false, error: '家庭服务暂时无法保存事件状态' });
        return;
      }
      sendJson(res, 200, { ok: true, changed: changed, metrics: noticeMetrics() });
    });
    return;
  }

  if (p === '/api/family/notify') {
    if (req.method === 'POST') {
      readJsonBody(req, res, 64 * 1024, function (o) {
        var txt = String(o.text || '').trim();
        if (!txt) { sendJson(res, 400, { ok: false, error: '内容不能为空' }); return; }
        if (o.eventId) {
          var existing = elderNotices.filter(function (n) { return n.id === String(o.eventId); })[0];
          if (existing) { sendJson(res, 200, { ok: true, id: existing.id, duplicate: true }); return; }
        }
        var now = Date.now();
        var kind = String(o.kind || '平安').slice(0, 12);
        var high = /高风险|紧急|求助|摔倒|不舒服|走失|喘不上气|胸口疼/.test(kind + txt);
        var n = {
          id: o.eventId
            ? String(o.eventId).slice(0, 80)
            : ('n' + now.toString(36) + Math.random().toString(36).slice(2, 5)),
          text: txt.slice(0, 2000),
          kind: kind,
          level: high ? 'high' : 'normal',
          status: 'pending',
          at: o.at ? Number(o.at) : now,
          createdAt: now,
          deadlineAt: now + (high ? HIGH_ESCALATE_MS : NORMAL_ESCALATE_MS)
        };
        var previousNotices = elderNotices.slice();
        elderNotices.push(n);
        elderNotices.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
        if (elderNotices.length > 100) elderNotices.length = 100;
        if (!saveNotices()) {
          elderNotices = previousNotices;
          sendJson(res, 503, { ok: false, error: '家庭服务暂时无法保存告警' });
          return;
        }
        if (high) deliverAlertWebhook(n);
        console.log('[' + new Date().toLocaleTimeString() + '] 家人协同事件：' +
          kind + '（' + (high ? '高优先级' : '普通') + '）');
        sendJson(res, 200, { ok: true, id: n.id, event: n });
      });
      return;
    }
    runCareWatchdog();
    escalateOverdueNotices();
    sendJson(res, 200, {
      ok: true,
      notices: elderNotices.filter(isUnresolvedNotice),
      metrics: noticeMetrics()
    });
    return;
  }

  if (p === '/api/family/notify/ack') {
    readJsonBody(req, res, 16 * 1024, function (o) {
      var ids = normalizeIds(o.ids, 50);
      var changed = updateNoticeEvents(ids, 'ack');
      if (changed < 0) {
        sendJson(res, 503, { ok: false, error: '家庭服务暂时无法保存确认状态' });
        return;
      }
      sendJson(res, 200, { ok: true, changed: changed, metrics: noticeMetrics() });
    });
    return;
  }

  /* ---------- 静态文件 ---------- */
  if (req.method === 'GET' && (p === '/' || /\.html$/i.test(p))) {
    setAuthCookie(req, res);
  }
  serveStatic(req, res, p);
}

/* 有证书就走 HTTPS：麦克风、定位、NFC 都要求安全环境。
   没有证书就退回 HTTP（这些能力会被浏览器禁用）。 */
var certPath = path.join(__dirname, 'cert.pem');
var keyPath = path.join(__dirname, 'key.pem');
// 想强制用 HTTP（比如临时测试），可以设 HTTP_ONLY=1
var forceHttp = process.env.HTTP_ONLY === '1';
var useHttps = !forceHttp && fs.existsSync(certPath) && fs.existsSync(keyPath);

var server;
if (useHttps) {
  server = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  }, handle);
} else {
  server = http.createServer(handle);
}
server.requestTimeout = 60 * 1000;
server.headersTimeout = 15 * 1000;
server.keepAliveTimeout = 5 * 1000;

var triedPorts = [];

function onListening(port) {
  var ips = [];
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (i) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    });
  });
  var scheme = useHttps ? 'https' : 'http';

  console.log('');
  console.log('  微光护老 · 同步服务已启动（' + (useHttps ? 'HTTPS' : 'HTTP') + '）');
  console.log('  ------------------------------------------');
  console.log('  家人配对码：   ' + authState.pairCode);
  console.log('  本机页面会自动配对；家人手机首次打开需输入配对码。');
  console.log('  ------------------------------------------');
  console.log('  本机打开：   ' + scheme + '://localhost:' + port + '/');
  console.log('  家人端：     ' + scheme + '://localhost:' + port + '/family.html');
  ips.forEach(function (ip) {
    console.log('  局域网（老人端和家人手机填这个）：');
    console.log('               ' + scheme + '://' + ip + ':' + port);
    console.log('               ' + scheme + '://' + ip + ':' + port + '/family.html');
  });
  console.log('  ------------------------------------------');
  if (useHttps) {
    console.log('  提示：这是自签证书。手机首次打开会有安全提示，');
    console.log('  需要在浏览器里点「高级 → 继续前往」，并安装证书');
    console.log('  （详见 README 里的「开启 HTTPS」一节）。');
    console.log('  如果换了网络、IP 地址变了，重新执行 node make-cert.js。');
    console.log('  ------------------------------------------');
  } else {
    console.log('  提示：当前是 HTTP。本机 localhost 通常可直接使用麦克风；');
    console.log('        手机通过局域网 HTTP 访问时，定位和 NFC 会被浏览器禁用，');
    console.log('        语音可使用页面内的“录一段话”降级通道。');
    console.log('        需要完整能力时请配置 HTTPS（见 README）。');
    console.log('  ------------------------------------------');
  }
  console.log('  按 Ctrl + C 停止');
  console.log('');
}

/* 端口被占用时自动往后找一个能用的，而不是直接抛异常。
   注意：监听回调只能注册一次，否则每次重试都会再触发一遍。 */
var currentPort = Number(PORT) || 8080;
var attemptsLeft = 10;
var firstPort = currentPort;

server.on('listening', function () {
  var port = server.address().port;
  if (triedPorts.length) {
    console.log('');
    console.log('  提示：' + triedPorts.join('、') + ' 已被占用，已自动改用 ' + port + ' 端口。');
    console.log('  （老人端和家人端请用 ' + port + ' 这个端口）');
  }
  onListening(port);
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
    triedPorts.push(currentPort);
    currentPort += 1;
    attemptsLeft -= 1;
    try { server.close(); } catch (e) { /* 未在监听时关闭会报错，忽略 */ }
    server.listen(currentPort, '0.0.0.0');
    return;
  }

  console.log('');
  if (err.code === 'EADDRINUSE') {
    console.log('  启动失败：端口 ' + firstPort + ' 到 ' + currentPort + ' 都被占用了。');
  } else {
    console.log('  启动失败：' + (err.message || err.code));
  }
  console.log('');
  console.log('  两个办法：');
  console.log('   1. 指定另一个端口再启动，例如：');
  console.log('        $env:PORT=9000; node server.js         （PowerShell）');
  console.log('        set PORT=9000 && node server.js        （命令提示符）');
  console.log('   2. 看看是谁占着端口：');
  console.log('        netstat -ano | findstr :' + firstPort);
  console.log('');
  process.exit(1);
});

server.listen(currentPort, '0.0.0.0');
