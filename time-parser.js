/* 微光护老 · 中文相对时间解析。浏览器和 Node 测试共用。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WGTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CN_DIGIT = {
    '零': 0, '〇': 0, '一': 1, '两': 2, '二': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
  };

  function cnNum(value) {
    var text = String(value || '').trim();
    if (!text) return null;
    if (/^[0-9]+$/.test(text)) return parseInt(text, 10);
    var m = /^(.)?十(.)?$/.exec(text);
    if (m) {
      var tens = m[1] ? CN_DIGIT[m[1]] : 1;
      var ones = m[2] ? CN_DIGIT[m[2]] : 0;
      if (tens == null || ones == null) return null;
      return tens * 10 + ones;
    }
    if (text.length === 1 && CN_DIGIT[text] != null) return CN_DIGIT[text];
    return null;
  }

  function parseWhen(rawText, nowInput) {
    var text = String(rawText || '').trim();
    var now = nowInput instanceof Date ? new Date(nowInput.getTime()) : new Date(nowInput || Date.now());
    if (!text || isNaN(now.getTime())) return null;
    var m, value;

    if ((m = /([0-9]+|[一二两三四五六七八九十]+)\s*(?:分钟|分)\s*(?:以)?后/.exec(text))) {
      value = cnNum(m[1]);
      if (value == null || value < 0) return { error: 'invalid-offset' };
      return { at: new Date(now.getTime() + value * 60000), matched: m[0], clock: true, ambiguous: false };
    }
    if ((m = /半\s*(?:个)?\s*(?:小时|钟头)\s*(?:以)?后/.exec(text))) {
      return { at: new Date(now.getTime() + 30 * 60000), matched: m[0], clock: true, ambiguous: false };
    }
    if ((m = /([0-9]+|[一二两三四五六七八九十]+)\s*(?:个)?\s*(?:小时|钟头)\s*(?:以)?后/.exec(text))) {
      value = cnNum(m[1]);
      if (value == null || value < 0) return { error: 'invalid-offset' };
      return { at: new Date(now.getTime() + value * 3600000), matched: m[0], clock: true, ambiguous: false };
    }

    var dayOffset = null;
    var consumed = [];
    if ((m = /大后天/.exec(text))) { dayOffset = 3; consumed.push(m[0]); }
    else if ((m = /后天/.exec(text))) { dayOffset = 2; consumed.push(m[0]); }
    else if ((m = /明天|明日|明儿/.exec(text))) { dayOffset = 1; consumed.push(m[0]); }
    else if ((m = /今天|今日|今儿/.exec(text))) { dayOffset = 0; consumed.push(m[0]); }

    var period = null;
    if ((m = /凌晨/.exec(text))) { period = 'midnight'; consumed.push(m[0]); }
    else if ((m = /早上|早晨|一大早|清晨/.exec(text))) { period = 'am'; consumed.push(m[0]); }
    else if ((m = /上午/.exec(text))) { period = 'am'; consumed.push(m[0]); }
    else if ((m = /中午/.exec(text))) { period = 'noon'; consumed.push(m[0]); }
    else if ((m = /下午/.exec(text))) { period = 'pm'; consumed.push(m[0]); }
    else if ((m = /傍晚/.exec(text))) { period = 'pm'; consumed.push(m[0]); }
    else if ((m = /晚上|夜里|晚间/.exec(text))) { period = 'night'; consumed.push(m[0]); }

    var hh = null;
    var mm = 0;
    var timeMatch = '';
    if ((m = /([0-9]{1,2})[:：]([0-9]{1,2})/.exec(text))) {
      hh = parseInt(m[1], 10);
      mm = parseInt(m[2], 10);
      timeMatch = m[0];
    } else if ((m = /([0-9]{1,2}|[一二两三四五六七八九十]+)\s*点\s*(半|一刻|三刻|[0-9]{1,2}\s*分?|[一二两三四五六七八九十]+\s*分?)?/.exec(text))) {
      hh = cnNum(m[1]);
      timeMatch = m[0];
      if (m[2] === '半') mm = 30;
      else if (m[2] === '三刻') mm = 45;
      else if (m[2] === '一刻') mm = 15;
      else if (m[2]) {
        var minuteText = m[2].replace(/分/g, '').trim();
        mm = cnNum(minuteText);
      }
    }

    if (hh == null && !period) return null;
    if (hh == null) return { error: 'missing-clock', matched: consumed.join(''), clock: false, ambiguous: false };
    if (hh < 0 || hh > 23 || mm == null || mm < 0 || mm > 59) {
      return { error: 'invalid-time', matched: consumed.concat([timeMatch]).join(''), clock: true, ambiguous: false };
    }
    if ((period === 'am' || period === 'midnight' || period === 'noon') && hh > 12) {
      return { error: 'invalid-time', matched: consumed.concat([timeMatch]).join(''), clock: true, ambiguous: false };
    }

    var ambiguous = false;
    if (period === 'midnight' && hh === 12) {
      hh = 0;
      ambiguous = true;
    } else if (period === 'night' && hh === 12) {
      hh = 0;
      ambiguous = true;
    } else if (period === 'noon' && hh >= 1 && hh < 11) {
      hh += 12;
    } else if ((period === 'pm' || period === 'night') && hh >= 1 && hh < 12) {
      hh += 12;
    } else if ((period === 'am' || period === 'midnight') && hh === 12) {
      hh = 0;
    } else if (!period && hh >= 1 && hh <= 11) {
      ambiguous = true;
    }

    if (timeMatch) consumed.push(timeMatch);
    var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (dayOffset != null) date.setDate(date.getDate() + dayOffset);
    date.setHours(hh, mm, 0, 0);
    if (dayOffset == null && date.getTime() < now.getTime() - 60000) {
      date.setDate(date.getDate() + 1);
    }
    return {
      at: date,
      matched: consumed.join(''),
      clock: true,
      ambiguous: ambiguous,
      period: period || '',
      hour: hh,
      minute: mm
    };
  }

  return { parseWhen: parseWhen, cnNum: cnNum };
});
