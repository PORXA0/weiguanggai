/* ============================================================
   微光护老 · 家人端

   数据来源有两种：
     1. 同一台设备打开时，直接读本机保存的数据（演示用）
     2. 填了同步地址时，从家里那台电脑的同步服务读取（真远程）
   ============================================================ */

(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var KEY_SERVER = 'weiguang.family.server';
  var KEY_DATA = 'weiguang.data.v1';

  var server = '';
  var timer = null;
  var lastState = null;
  var pairConfirmed = true;  /* 公网演示版：跳过配对，默认已确认 */

  function getParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtTime(ts) {
    var d = new Date(ts);
    return pad2(d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日 ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function ago(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  /* ==========================================================
     取数据
     ========================================================== */

  function readLocal() {
    try {
      var raw = localStorage.getItem(KEY_DATA);
      if (!raw) return null;
      var d = JSON.parse(raw);
      // 把本机数据结构整理成和服务器一致的样子
      var today = (function () {
        var x = new Date();
        return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
      })();

      function taken(medId, time) {
        return (d.medLogs || []).some(function (l) {
          return l.date === today && l.medId === medId && l.time === time && l.status === 'taken';
        });
      }

      var medTotal = 0, medDone = 0;
      var meds = (d.meds || []).map(function (m) {
        var items = (m.times || []).map(function (t) {
          medTotal++;
          var ok = taken(m.id, t);
          if (ok) medDone++;
          return { time: t, taken: ok };
        });
        return { name: m.name, dose: m.dose || '', items: items };
      });

      var st = d.settings || {};
      var lastAct = d.lastActiveAt || Date.now();
      var limit = Number(st.inactiveHours) || 8;
      var hours = (Date.now() - lastAct) / 3600000;

      return {
        local: true,
        updatedAt: Date.now(),
        elderName: st.elderName || '家里的老人',
        medTotal: medTotal,
        medDone: medDone,
        meds: meds,
        alerts: (d.fraudLogs || []).slice(0, 20).map(function (l) {
          return { at: l.at, text: l.text, level: l.level, levelText: l.levelText, score: l.score };
        }),
        lastActiveAt: lastAct,
        inactiveHours: Math.round(hours * 100) / 100,
        inactiveLimit: limit,
        inactiveAlert: hours >= limit,
        location: d.location || null,
        fence: null,
        weather: null
      };
    } catch (e) {
      return null;
    }
  }

  function fetchRemote() {
    if (!server) return Promise.resolve(null);
    return fetch(server + '/api/state')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.updatedAt) return null;
        j.local = false;
        return j;
      })
      .catch(function () { return null; });
  }

  function load() {
    var p = getParam('server');
    if (p) { server = p.replace(/\/+$/, ''); try { localStorage.setItem(KEY_SERVER, server); } catch (e) {} }
    else {
      try { server = localStorage.getItem(KEY_SERVER) || ''; } catch (e) { server = ''; }
      // 如果这个页面本身就是从同步服务打开的，就直接用它的地址，不用再手填
      if (!server && /^https?:$/.test(location.protocol)) server = location.origin;
    }

    if (!server) {
      var local = readLocal();
      if (local) { render(local); return; }
      showSetup();
      return;
    }

    fetchRemote().then(function (s) {
      if (s) render(s);
      else {
        var local = readLocal();
        if (local) render(local);
        else showSetup();
        setLink(false);
        if (lastState) $('#headSub').textContent = '连不上老人端（' + ago(lastState.updatedAt) + '更新）';
      }
    });
  }

  function showSetup() {
    $('#setupCard').hidden = false;
    $('#todayCard').hidden = true;
    $('#medCard').hidden = true;
    $('#alertCard').hidden = true;
    $('#weatherCard').hidden = true;
    $('#actions').hidden = true;
    $('#headSub').textContent = pairConfirmed
      ? '已配对，等待老人端同步数据'
      : '还没有和老人端连线';
    setLink(false);
    $('#serverInput').value = server;
    $('#pairCodeInput').value = '';
    $('#pairState').textContent = pairConfirmed ? '配对成功，等待老人端同步数据' : '';
  }

  function setLink(on) {
    var d = $('#linkDot');
    d.className = 'fh-dot ' + (on ? 'on' : 'off');
  }

  /* ==========================================================
     渲染
     ========================================================== */

  function hoursText(h) {
    if (h < 1) return Math.round(h * 60) + ' 分钟';
    if (h < 24) return (Math.round(h * 10) / 10) + ' 小时';
    return (Math.round(h / 24 * 10) / 10) + ' 天';
  }

  /* 活动与位置：这是家人最需要一眼看到的东西 */
  function renderCare(s) {
    var card = $('#careCard');
    var line = $('#careLine');
    var note = $('#careNote');

    if (!s.lastActiveAt) { card.hidden = true; return; }
    card.hidden = false;

    var hours = s.inactiveHours != null
      ? s.inactiveHours
      : (Date.now() - s.lastActiveAt) / 3600000;
    var limit = s.inactiveLimit || 8;
    var alert = s.inactiveAlert != null ? s.inactiveAlert : (hours >= limit);
    var warn = !alert && hours >= limit / 2;

    card.className = 'card care' + (alert ? ' is-alert' : (warn ? ' is-warn' : ''));

    if (alert) {
      line.className = 'care-line alert';
      line.textContent = '已有 ' + hoursText(hours) + ' 没有动静';
      note.textContent = '超过了设定的 ' + limit + ' 小时。建议打个电话确认一下。' +
        '最后活动时间：' + fmtTime(s.lastActiveAt);
    } else if (warn) {
      line.className = 'care-line warn';
      line.textContent = '最近 ' + hoursText(hours) + ' 没有操作';
      note.textContent = '还没到报警时间（' + limit + ' 小时），可以先留意一下。' +
        '最后活动时间：' + fmtTime(s.lastActiveAt);
    } else {
      line.className = 'care-line ok';
      line.textContent = '一切正常';
      note.textContent = '最近一次操作：' + ago(s.lastActiveAt) +
        '（' + fmtTime(s.lastActiveAt) + '）';
    }

    // 活动范围
    if (s.fence && s.fence.away) {
      card.className = 'card care is-alert';
      note.textContent += ' 已经离开活动范围约 ' + s.fence.distance +
        ' 米（范围 ' + s.fence.radius + ' 米）。';
    }

    // 位置
    var box = $('#locBox');
    if (s.location && s.location.lat != null) {
      box.hidden = false;
      $('#locCoord').textContent =
        '位置更新于 ' + ago(s.location.at) + ' · 精度约 ' + (s.location.acc || '—') + ' 米' +
        '\n（' + s.location.lat.toFixed(5) + ', ' + s.location.lon.toFixed(5) + '）';
      $('#btnMap').href = 'https://uri.amap.com/marker?position=' +
        s.location.lon + ',' + s.location.lat +
        '&name=' + encodeURIComponent(s.elderName || '老人位置') + '&src=weiguang';
    } else {
      box.hidden = true;
    }
  }
  function fmtPlanTime(ts) {
    var d = new Date(ts), now = new Date();
    var d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var d1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.round((d1 - d0) / 86400000);
    var day = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天'
            : (d.getMonth() + 1) + '月' + d.getDate() + '日';
    var h = d.getHours();
    var period = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return day + period + h12 + '点' + (d.getMinutes() ? pad2(d.getMinutes()) + '分' : '');
  }

  function renderPlans(s) {
    var card = document.querySelector('#planCard');
    var box = document.querySelector('#planListFamily');
    if (!card || !box) return;
    var evs = (s.events || []).filter(function (e) { return e.at >= Date.now() - 3600000; });
    if (!evs.length) { card.hidden = true; return; }
    card.hidden = false;
    box.innerHTML = evs.slice(0, 6).map(function (e) {
      return '<li><span class="pl-when">' + esc(fmtPlanTime(e.at)) + '</span>' +
             '<span class="pl-text">' + esc(e.text) + '</span></li>';
    }).join('');
  }
  /* 老人在去哪 */




  /* 老人发来的消息（报平安），到了就直接弹出来 */
  var noticeCur = null;
  var NOTICE_STATUS_TEXT = {
    pending: '待确认',
    acknowledged: '已查看，等待联系',
    contacted: '已电话确认',
    escalated: '超时未确认，已升级',
    resolved: '已处置并关闭'
  };

  function renderNoticeStatus(n) {
    var status = document.querySelector('#noticeStatus');
    if (!status) return;
    status.textContent = '处置状态：' + (NOTICE_STATUS_TEXT[n.status] || '待确认');
  }

  function pollNotice() {
    if (!server) return;
    fetch(server + '/api/family/notify').then(function (r) { return r.json(); }).then(function (j) {
      var card = document.querySelector('#noticeCard');
      if (!j || !j.ok || !j.notices || !j.notices.length) {
        noticeCur = null;
        if (card) card.hidden = true;
        return;
      }
      var n = j.notices[0];
      if (noticeCur && noticeCur.id === n.id && !card.hidden) {
        noticeCur = n;
        renderNoticeStatus(n);
        return;
      }
      noticeCur = n;
      document.querySelector('#noticeText').textContent = n.text;
      document.querySelector('#noticeTime').textContent = fmtTime(n.at);
      document.querySelector('#noticeTitle').textContent =
        (n.level === 'high' || n.status === 'escalated') ? '高风险事件需要处置' :
        (n.kind === '平安') ? '老人报平安了' :
        (n.kind === '吃药') ? '老人吃药打卡' : '老人发来消息';
      renderNoticeStatus(n);
      card.hidden = false;
      if (n.status === 'pending' && navigator.vibrate) {
        try { navigator.vibrate([120, 60, 120]); } catch (e) {}
      }
    }).catch(function () {});
  }

  function updateNotice(action) {
    if (!noticeCur) return;
    fetch(server + '/api/family/events/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [noticeCur.id], action: action })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) return;
      noticeCur.status = action === 'ack' ? 'acknowledged' :
        (action === 'contact' ? 'contacted' : 'resolved');
      if (action === 'resolve') {
        noticeCur = null;
        document.querySelector('#noticeCard').hidden = true;
      } else {
        renderNoticeStatus(noticeCur);
      }
      pollEvents();
    }).catch(function () {});
  }

  function renderEvents(j) {
    var card = document.querySelector('#eventCard');
    var list = document.querySelector('#eventList');
    var metrics = document.querySelector('#eventMetrics');
    if (!card || !list || !j || !j.ok) return;
    var events = j.events || [];
    card.hidden = !events.length;
    if (!events.length) return;
    var m = j.metrics || {};
    metrics.textContent = '未关闭 ' + (m.unresolved || 0) + ' 条；已升级 ' +
      (m.escalated || 0) + ' 条；平均确认用时 ' +
      (m.avgAckMs ? Math.max(1, Math.round(m.avgAckMs / 60000)) + ' 分钟' : '暂无');
    list.innerHTML = events.slice(0, 8).map(function (n) {
      return '<li><b>' + esc(n.text) + '</b>' +
        '<span>' + fmtTime(n.at) + ' · ' + esc(n.kind || '协同') + '</span>' +
        '<em class="ev-status ' + esc(n.status || 'pending') + '">' +
          esc(NOTICE_STATUS_TEXT[n.status] || '待确认') + '</em></li>';
    }).join('');
  }

  function pollEvents() {
    if (!server) return;
    fetch(server + '/api/family/events').then(function (r) { return r.json(); })
      .then(renderEvents).catch(function () {});
  }

  /* 给老人发提醒 */
  function readSent() { try { return JSON.parse(localStorage.getItem('weiguang.family.sent') || '[]'); } catch (e) { return []; } }
  function writeSent(list) { try { localStorage.setItem('weiguang.family.sent', JSON.stringify(list.slice(0, 30))); } catch (e) {} }
  function renderSent() {
    var ul = document.querySelector('#sentList');
    if (!ul) return;
    var list = readSent();
    ul.innerHTML = list.map(function (m) { return '<li>' + esc(m.text) + ' <span>' + (m.at ? '定时 ' + fmtTime(m.at) : '已发出') + '</span></li>'; }).join('');
  }

  /* 健康评估 */
  function renderHealth(s) {
    var card = document.querySelector('#healthCard');
    if (!card) return;
    var h = s.health;
    if (!h) { card.hidden = true; return; }
    card.hidden = false;
    document.querySelector('#healthLine').textContent = h.statusText || '已评估';
    var note = document.querySelector('#healthNote');
    note.textContent = (h.source ? h.source + ' · ' : '') + fmtTime(h.at);
    var ul = document.querySelector('#healthItems');
    ul.innerHTML = (h.items || []).map(function (it) {
      return '<li><span>' + esc(it.label) + '</span><b class="' + (it.level || '') + '">' + esc(it.val) + '</b></li>';
    }).join('');
  }

  var famMap = null;
  function updateFamMap(s) {
    var el = document.querySelector('#famMap');
    if (!el || !window.WGMap) return;
    var n = s.nav;
    if (!n || !n.dest) { el.hidden = true; return; }
    el.hidden = false;
    if (!famMap) famMap = window.WGMap.create(el, { zoom: 15 });
    var marks = [], pts = [];
    var dl = String(n.location || '').split(',');
    if (dl.length === 2 && isFinite(Number(dl[0]))) { marks.push({ lat: Number(dl[1]), lon: Number(dl[0]), type: 'dest', label: n.dest }); pts.push({ lat: Number(dl[1]), lon: Number(dl[0]) }); }
    var me = n.here || s.location;
    if (me && me.lat != null) {
      var g = window.WGMap.wgs2gcj(me.lat, me.lon);
      marks.push({ lat: g.lat, lon: g.lon, type: 'me', label: '老人' });
      pts.push(g);
    }
    famMap.setLine(n.polyline || []);
    famMap.setMarks(marks);
    if (n.polyline && n.polyline.length) pts = pts.concat(n.polyline);
    if (pts.length) famMap.fit(pts, 60);
    famMap.render();
  }

  function renderNav(s) {
    var card = document.querySelector('#navCard');
    if (!card) return;
    var n = s.nav;
    if (!n || !n.dest) { card.hidden = true; return; }
    card.hidden = false;
    document.querySelector('#navLine').textContent = '正在去：' + n.dest;
    var r = (n.routes && n.routes[0]) || null;
    var bits = [];
    if (r) bits.push(r.mode + ' 约 ' + (r.distance >= 1000 ? (r.distance / 1000).toFixed(1) + ' 公里' : r.distance + ' 米') + '，' + Math.max(1, Math.round(r.duration / 60)) + ' 分钟');
    if (n.at) bits.push('出发于 ' + ago(n.at));
    document.querySelector('#navNoteFamily').textContent = bits.join(' · ');
    var a = document.querySelector('#btnDestMap');
    if (n.location) {
      var p = String(n.location).split(',');
      a.href = 'https://uri.amap.com/marker?position=' + p[0] + ',' + p[1] + '&name=' + encodeURIComponent(n.dest) + '&src=weiguang';
      a.hidden = false;
    } else a.hidden = true;
    updateFamMap(s);
  }



  function render(s) {
    lastState = s;
    $('#setupCard').hidden = true;
    setLink(true);

    $('#elderName').textContent = s.elderName || '家里的老人';
    var fresh = (Date.now() - s.updatedAt) < 5 * 60 * 1000;
    $('#headSub').textContent = (s.local ? '本机数据 · ' : '') +
      '更新于 ' + fmtTime(s.updatedAt) + '（' + ago(s.updatedAt) + '）';

    // 今日概况
    $('#todayCard').hidden = false;
    $('#medNum').textContent = s.medTotal ? (s.medDone + '/' + s.medTotal) : '—';
    var pct = s.medTotal ? Math.round(s.medDone / s.medTotal * 100) : 0;
    $('#medBar').style.width = pct + '%';
    $('#medBar').style.background = pct >= 100 ? '#1A5C4C' : (pct >= 50 ? '#D9A33C' : '#CE4331');

    if (!s.medTotal) {
      $('#medNote').textContent = '还没有设置用药提醒。';
    } else if (s.medDone >= s.medTotal) {
      $('#medNote').textContent = '今天的药全部按时吃完了。';
    } else {
      var miss = [];
      (s.meds || []).forEach(function (m) {
        (m.items || []).forEach(function (it) {
          if (!it.taken) miss.push(m.name + ' ' + it.time);
        });
      });
      $('#medNote').textContent = '还有 ' + (s.medTotal - s.medDone) + ' 次没吃：' + miss.join('、');
    }

    // 用药明细
    var ml = $('#medList');
    ml.innerHTML = '';
    if (s.meds && s.meds.length) {
      $('#medCard').hidden = false;
      s.meds.forEach(function (m) {
        var li = document.createElement('li');
        li.innerHTML =
          '<div class="ml-top"><span class="ml-name">' + esc(m.name) + '</span>' +
          (m.dose ? '<span class="ml-dose">一次 ' + esc(m.dose) + '</span>' : '') + '</div>' +
          '<div class="ml-times">' + (m.items || []).map(function (it) {
            return '<span class="ml-t ' + (it.taken ? 'done' : 'miss') + '">' +
                   esc(it.time) + (it.taken ? ' ✓' : ' ○') + '</span>';
          }).join('') + '</div>';
        ml.appendChild(li);
      });
    } else {
      $('#medCard').hidden = true;
    }

    // 预警
    $('#alertCard').hidden = false;
    var alerts = s.alerts || [];
    var high = alerts.filter(function (a) { return a.level === 'high'; }).length;
    $('#alertNote').textContent = alerts.length
      ? '共 ' + alerts.length + ' 条，其中高风险 ' + high + ' 条'
      : '今天没有收到可疑电话，很好。';

    var al = $('#alertList');
    al.innerHTML = '';
    alerts.slice(0, 8).forEach(function (a) {
      var li = document.createElement('li');
      li.innerHTML =
        '<span class="al-flag ' + esc(a.level || 'low') + '"></span>' +
        '<div class="al-body">' +
          '<div class="al-when">' + fmtTime(a.at) + '</div>' +
          '<div class="al-text">' + esc(a.text) + '</div>' +
          '<span class="al-tag ' + esc(a.level || 'low') + '">' +
            esc(a.levelText || '') + ' · ' + (a.score != null ? a.score + ' 分' : '') + '</span>' +
        '</div>';
      al.appendChild(li);
    });

    // 天气
    if (s.weather) {
      $('#weatherCard').hidden = false;
      $('#weatherLine').textContent =
        s.weather.place + '，' + s.weather.text + '，现在 ' + s.weather.now + ' 度，' +
        '今天 ' + s.weather.min + '~' + s.weather.max + ' 度。' + (s.weather.advice || '');
    } else {
      $('#weatherCard').hidden = true;
    }
    renderPlans(s);
    renderHealth(s);
    renderNav(s);


    // 活动与位置
    renderCare(s);

    // 动作
    $('#actions').hidden = false;
    var phone = s.elderPhone || '';
    var call = $('#btnCall');
    if (phone) { call.href = 'tel:' + phone; call.textContent = '打电话给老人'; call.hidden = false; }
    else { call.hidden = true; }

    var fn = $('#footNote');
    fn.hidden = false;
    fn.textContent = s.local
      ? '当前显示的是这台设备上保存的数据。要远程查看，请填上家里的同步地址。'
      : '状态由老人端同步到家庭服务；语音和大模型仅在使用相应功能时调用第三方服务。';
  }

  /* ==========================================================
     事件
     ========================================================== */

  $('#btnConnect').addEventListener('click', function () {
    var v = $('#serverInput').value.trim().replace(/\/+$/, '');
    if (!v) return;
    server = v;
    try { localStorage.setItem(KEY_SERVER, server); } catch (e) {}
    $('#headSub').textContent = '正在连接…';
    load();
    pollNotice();
  });

  $('#btnPair').addEventListener('click', function () {
    var code = ($('#pairCodeInput').value || '').trim();
    if (!/^\d{6}$/.test(code)) {
      $('#pairState').textContent = '请输入六位数字配对码';
      return;
    }
    var base = server || (/^https?:$/.test(location.protocol) ? location.origin : '');
    if (!base) {
      $('#pairState').textContent = '请先填写老人端同步地址';
      return;
    }
    $('#btnPair').disabled = true;
    fetch(base.replace(/\/+$/, '') + '/api/pair/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (result) {
        $('#btnPair').disabled = false;
        if (!result.body || !result.body.ok) {
          $('#pairState').textContent = (result.body && result.body.error) || '配对失败';
          return;
        }
        pairConfirmed = true;
        $('#pairState').textContent = '配对成功，正在连接…';
        load();
        pollNotice();
        pollEvents();
      }).catch(function () {
        $('#btnPair').disabled = false;
        $('#pairState').textContent = '连不上老人端';
      });
  });
  $('#pairCodeInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('#btnPair').click();
  });

  $('#btnRefresh').addEventListener('click', function () {
    $('#headSub').textContent = '正在刷新…';
    load();
    pollNotice();
    pollEvents();
  });

  var sendBtn = document.querySelector('#btnSendMsg');
  if (sendBtn) {
    sendBtn.addEventListener('click', function () {
      var inp = document.querySelector('#msgInput');
      var t = (inp.value || '').trim();
      if (!t) { alert('先写点什么'); return; }
      var tv = document.querySelector('#msgTime').value;
      var at = tv ? new Date(tv).getTime() : 0;
      sendBtn.disabled = true;
      fetch(server + '/api/family/msg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t, at: at })
      }).then(function (r) { if (r.status === 404) throw new Error('old-server'); return r.json(); }).then(function (j) {
        sendBtn.disabled = false;
        if (!j || !j.ok) { alert('发送失败'); return; }
        var list = readSent();
        list.unshift({ text: t, at: at, at2: Date.now() });
        writeSent(list); renderSent();
        inp.value = ''; document.querySelector('#msgTime').value = '';
        document.querySelector('#sendState').textContent = '已经发出，老人端下次联网时会看到';
      }).catch(function (e) {
        sendBtn.disabled = false;
        document.querySelector('#sendState').textContent = (e && e.message === 'old-server')
          ? '服务还是旧版本，重启一下就能用了：关掉老人端电脑上的黑窗口，重新双击 start-http.bat'
          : '发不出去，检查是否连上了老人端';
      });
    });
    renderSent();
  }

  document.querySelector('#btnNoticeOk').addEventListener('click', function () { updateNotice('ack'); });
  document.querySelector('#btnNoticeContact').addEventListener('click', function () { updateNotice('contact'); });
  document.querySelector('#btnNoticeResolve').addEventListener('click', function () { updateNotice('resolve'); });
  setInterval(pollNotice, 15000);
  setInterval(pollEvents, 30000);
  setTimeout(pollEvents, 500);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { pollNotice(); pollEvents(); }
  });
  window.addEventListener('focus', function () { pollNotice(); pollEvents(); });

  if (timer) clearInterval(timer);
  timer = setInterval(load, 30000);
  load();
  pollNotice();
  setInterval(pollNotice, 15000);

})();
