/* 前端安全与无障碍回归检查。 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = __dirname;
var mapSource = fs.readFileSync(path.join(root, 'map.js'), 'utf8');
var indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
var familySource = fs.readFileSync(path.join(root, 'family.html'), 'utf8');
var serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
var appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

assert(mapSource.includes('label.textContent = String(m.label)'),
  '地图标签必须通过 textContent 渲染');
assert(!/wm-label[^\n]*\+\s*m\.label/.test(mapSource),
  '地图标签不能直接拼接 m.label 到 innerHTML');
assert(indexSource.includes('aria-live="polite"') &&
  indexSource.includes('aria-live="assertive"'),
  '老人端必须提供动态内容播报区域');
assert(familySource.includes('aria-live="assertive"'),
  '家人端告警必须能被读屏软件主动播报');
assert(serverSource.includes("'Content-Security-Policy'"),
  '服务端必须设置 CSP');
assert(appSource.includes('AGENT_RUN') && appSource.includes('cancelAgentTask'),
  'Agent 必须具备单任务队列和停止能力');
assert(indexSource.indexOf('time-parser.js') < indexSource.indexOf('app.js'),
  '时间解析模块必须在 app.js 之前加载');
assert(indexSource.indexOf('task-store.js') < indexSource.indexOf('app.js') &&
  indexSource.indexOf('memory.js') < indexSource.indexOf('app.js'),
  '任务账本和记忆模块必须在 app.js 之前加载');
assert(appSource.includes('取消当前任务') || appSource.includes('正在停止当前任务'),
  '界面必须提供停止当前 Agent 任务的状态');
assert(!/\balert\s*\(/.test(familySource), '家人端不应使用阻塞式 alert');
assert(appSource.includes("action.className = 'toast-action'"),
  '删除和清空操作必须提供可撤销提示');

console.log('Frontend safety tests passed:', 11);
