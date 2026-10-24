/* 微光护老 · 持久化 Agent 任务账本。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WGTaskStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_TASKS = 30;
  var ACTIVE_STATUSES = ['queued', 'running', 'executing', 'waiting_user', 'waiting_consent'];

  function ensure(list) {
    return Array.isArray(list) ? list : [];
  }

  function create(list, task) {
    list = ensure(list);
    var now = Date.now();
    var item = {
      id: String((task && task.id) ||
        ('task-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7))),
      goal: String((task && (task.goal || task.originalText)) || '').slice(0, 500),
      status: String((task && task.status) || 'queued'),
      attempts: Number(task && task.attempts) || 0,
      currentStep: '',
      error: '',
      createdAt: Number(task && task.createdAt) || now,
      updatedAt: now
    };
    list.unshift(item);
    prune(list);
    return item;
  }

  function update(list, id, patch) {
    list = ensure(list);
    var task = list.filter(function (item) { return item.id === id; })[0];
    if (!task) return null;
    Object.keys(patch || {}).forEach(function (key) {
      if (key === 'status') task.status = String(patch.status || '').slice(0, 40);
      else if (key === 'currentStep' || key === 'error' || key === 'goal') {
        task[key] = String(patch[key] || '').slice(0, 500);
      } else if (key === 'attempts') task.attempts = Math.max(0, Number(patch.attempts) || 0);
      else task[key] = patch[key];
    });
    task.updatedAt = Date.now();
    return task;
  }

  function prune(list) {
    list = ensure(list);
    if (list.length > MAX_TASKS) list.length = MAX_TASKS;
    return list;
  }

  function isActive(task) {
    return !!(task && ACTIVE_STATUSES.indexOf(task.status) >= 0);
  }

  function recoverInterrupted(list) {
    list = ensure(list);
    var recovered = [];
    list.forEach(function (task) {
      if (task.status === 'running' || task.status === 'executing' ||
          task.status === 'waiting_consent' || task.status === 'queued') {
        task.status = 'interrupted';
        task.error = '页面关闭或服务中断，任务未完成';
        task.updatedAt = Date.now();
        recovered.push(task);
      }
    });
    return recovered;
  }

  function recent(list, count) {
    return ensure(list).slice(0, Math.max(1, count || 8));
  }

  return {
    MAX_TASKS: MAX_TASKS,
    ensure: ensure,
    create: create,
    update: update,
    prune: prune,
    isActive: isActive,
    recoverInterrupted: recoverInterrupted,
    recent: recent
  };
});
