/* ============================================================
   微光护老 · 网页内地图（自绘，不依赖外部地图组件）

   瓦片来自高德公开瓦片服务，坐标使用 GCJ-02（高德坐标系）。
   手机 GPS 拿到的是 WGS-84，显示前需要转换，见 wgs2gcj。
   ============================================================ */
(function () {
  'use strict';

  var TILE = 256;
  var SUBS = ['01', '02', '03', '04'];

  function tileUrl(x, y, z) {
    var s = SUBS[Math.abs(x + y) % 4];
    return 'https://webrd' + s + '.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=' + x + '&y=' + y + '&z=' + z;
  }
  function lon2tx(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function lat2ty(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  /* WGS-84 → GCJ-02（显示在中国地图上必须转，否则会偏几百米） */
  function outOfChina(lat, lon) {
    return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
  }
  function tLat(x, y) {
    var r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return r;
  }
  function tLon(x, y) {
    var r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return r;
  }
  function wgs2gcj(lat, lon) {
    if (outOfChina(lat, lon)) return { lat: lat, lon: lon };
    var a = 6378245.0, ee = 0.00669342162296594323;
    var dLat = tLat(lon - 105, lat - 35);
    var dLon = tLon(lon - 105, lat - 35);
    var rad = lat / 180 * Math.PI;
    var magic = Math.sin(rad);
    magic = 1 - ee * magic * magic;
    var sq = Math.sqrt(magic);
    dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sq) * Math.PI);
    dLon = (dLon * 180) / (a / sq * Math.cos(rad) * Math.PI);
    return { lat: lat + dLat, lon: lon + dLon };
  }

  function create(container, opts) {
    opts = opts || {};
    var state = { lat: opts.lat || 30.66, lon: opts.lon || 104.06, zoom: opts.zoom || 15 };
    var marks = [], line = [];

    container.classList.add('wgmap');
    container.innerHTML =
      '<div class="wgmap-tiles"></div>' +
      '<svg class="wgmap-svg" xmlns="http://www.w3.org/2000/svg"></svg>' +
      '<div class="wgmap-marks"></div>' +
      '<div class="wgmap-zoom">' +
        '<button type="button" data-z="in" aria-label="放大">＋</button>' +
        '<button type="button" data-z="out" aria-label="缩小">－</button>' +
      '</div>' +
      '<div class="wgmap-tip" hidden></div>';

    var layer = container.querySelector('.wgmap-tiles');
    var svg = container.querySelector('.wgmap-svg');
    var markBox = container.querySelector('.wgmap-marks');
    var tip = container.querySelector('.wgmap-tip');
    var cache = {};

    function size() { return { w: container.clientWidth || 300, h: container.clientHeight || 200 }; }
    function center() {
      return { x: lon2tx(state.lon, state.zoom) * TILE, y: lat2ty(state.lat, state.zoom) * TILE };
    }
    function px(lat, lon) {
      var c = center(), s = size();
      return {
        x: lon2tx(lon, state.zoom) * TILE - c.x + s.w / 2,
        y: lat2ty(lat, state.zoom) * TILE - c.y + s.h / 2
      };
    }

    function drawTiles() {
      var s = size(), c = center(), z = state.zoom;
      var n = Math.pow(2, z);
      var left = c.x - s.w / 2, top = c.y - s.h / 2;
      var x0 = Math.floor(left / TILE), x1 = Math.floor((left + s.w) / TILE);
      var y0 = Math.floor(top / TILE), y1 = Math.floor((top + s.h) / TILE);
      var want = {};

      for (var tx = x0; tx <= x1; tx++) {
        for (var ty = y0; ty <= y1; ty++) {
          if (ty < 0 || ty >= n) continue;
          var wx = ((tx % n) + n) % n;
          var k = z + '_' + wx + '_' + ty;
          want[k] = 1;
          var el = cache[k];
          if (!el) {
            el = document.createElement('img');
            el.className = 'wgmap-tile';
            el.alt = '';
            el.src = tileUrl(wx, ty, z);
            layer.appendChild(el);
            cache[k] = el;
          }
          el.style.left = (tx * TILE - left) + 'px';
          el.style.top = (ty * TILE - top) + 'px';
        }
      }
      Object.keys(cache).forEach(function (k) {
        if (!want[k]) { cache[k].remove(); delete cache[k]; }
      });
    }

    function drawMarks() {
      var s = size();
      svg.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);
      svg.setAttribute('width', s.w);
      svg.setAttribute('height', s.h);
      svg.innerHTML = '';

      if (line && line.length > 1) {
        var d = line.map(function (p, i) {
          var q = px(p.lat, p.lon);
          return (i ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1);
        }).join(' ');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#2C6FA8');
        path.setAttribute('stroke-width', '6');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('opacity', '0.75');
        svg.appendChild(path);
      }

      markBox.innerHTML = '';
      marks.forEach(function (m) {
        var q = px(m.lat, m.lon);
        var el = document.createElement('div');
        el.className = 'wgmap-mark ' + (m.type || '');
        el.style.left = q.x + 'px';
        el.style.top = q.y + 'px';
        el.innerHTML = '<span class="wm-dot"></span>' + (m.label ? '<span class="wm-label">' + m.label + '</span>' : '');
        markBox.appendChild(el);
      });
    }

    function render() { drawTiles(); drawMarks(); }

    function fit(points, pad) {
      if (!points || !points.length) return;
      pad = pad || 60;
      var lats = points.map(function (p) { return p.lat; });
      var lons = points.map(function (p) { return p.lon; });
      var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
      var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);
      state.lat = (minLat + maxLat) / 2;
      state.lon = (minLon + maxLon) / 2;
      var s = size();
      var z = 18;
      while (z > 3) {
        var dx = Math.abs(lon2tx(maxLon, z) - lon2tx(minLon, z)) * TILE;
        var dy = Math.abs(lat2ty(minLat, z) - lat2ty(maxLat, z)) * TILE;
        if (dx <= s.w - pad && dy <= s.h - pad) break;
        z--;
      }
      state.zoom = (maxLat - minLat < 0.0008 && maxLon - minLon < 0.0008) ? Math.max(z, 16) : z;
      render();
    }

    container.querySelector('.wgmap-zoom').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      var d = b.getAttribute('data-z');
      state.zoom = Math.max(3, Math.min(18, state.zoom + (d === 'in' ? 1 : -1)));
      render();
    });

    var w = 0;
    if (window.addEventListener) {
      window.addEventListener('resize', function () {
        clearTimeout(w);
        w = setTimeout(render, 200);
      });
    }

    return {
      setCenter: function (lat, lon) { state.lat = lat; state.lon = lon; render(); },
      setZoom: function (z) { state.zoom = z; render(); },
      setMarks: function (list) { marks = list || []; drawMarks(); },
      setLine: function (pts) { line = pts || []; drawMarks(); },
      fit: fit,
      render: render,
      tip: function (text) {
        if (!text) { tip.hidden = true; return; }
        tip.hidden = false;
        tip.textContent = text;
      },
      get state() { return state; }
    };
  }

  window.WGMap = { create: create, wgs2gcj: wgs2gcj };
})();
