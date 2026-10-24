/* 微光护老 · 可解释的轻量长期记忆检索。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WGMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STOP = /^(的|了|我|你|他|她|是|在|有|要|和|就|也|都|吗|呢|啊|请|帮|一下)$/;

  function tokens(text) {
    var value = String(text || '').toLowerCase();
    var words = value.match(/[a-z0-9]{2,}|[\u4e00-\u9fa5]/g) || [];
    return words.filter(function (word) { return !STOP.test(word); });
  }

  function scoreFact(fact, requestText, now) {
    var query = tokens(requestText);
    var haystack = tokens((fact && fact.text) || '');
    if (!query.length || !haystack.length) return 0;
    var hit = 0;
    query.forEach(function (word) {
      if (haystack.indexOf(word) >= 0) hit++;
    });
    var overlap = hit / Math.sqrt(query.length * haystack.length);
    var categoryBoost = fact.category === 'preference' ? 0.08 :
      (fact.category === 'care' ? 0.05 : 0);
    var ageDays = Math.max(0, (Number(now) - Number(fact.at || 0)) / 86400000);
    var freshness = 1 / (1 + ageDays / 30);
    return overlap * 0.85 + categoryBoost + freshness * 0.15;
  }

  function retrieveFacts(facts, requestText, count, now) {
    count = Math.max(1, Number(count) || 3);
    now = Number(now) || Date.now();
    return (Array.isArray(facts) ? facts : []).map(function (fact, index) {
      return { fact: fact, score: scoreFact(fact, requestText, now), index: index };
    }).sort(function (a, b) {
      return b.score - a.score || b.index - a.index;
    }).slice(0, count).filter(function (item) {
      return item.score > 0;
    }).map(function (item) { return item.fact; });
  }

  function addFact(facts, fact) {
    facts = Array.isArray(facts) ? facts : [];
    var text = String((fact && fact.text) || '').trim().slice(0, 160);
    if (!text) return null;
    var duplicate = facts.filter(function (item) {
      return String(item.text || '').trim() === text;
    })[0];
    if (duplicate) return duplicate;
    var item = {
      id: String((fact && fact.id) || ('mem-' + Date.now().toString(36))),
      at: Number(fact && fact.at) || Date.now(),
      text: text,
      category: ['preference', 'fact', 'care'].indexOf(fact && fact.category) >= 0
        ? fact.category : 'fact',
      source: String((fact && fact.source) || 'agent').slice(0, 40)
    };
    facts.unshift(item);
    if (facts.length > 20) facts.length = 20;
    return item;
  }

  function removeFact(facts, id) {
    if (!Array.isArray(facts)) return false;
    for (var i = 0; i < facts.length; i++) {
      if (facts[i].id === id) {
        facts.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  return {
    tokens: tokens,
    scoreFact: scoreFact,
    retrieveFacts: retrieveFacts,
    addFact: addFact,
    removeFact: removeFact
  };
});
