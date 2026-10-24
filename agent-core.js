/* ============================================================
   微光护老 · Agent 规划核心

   这一层不直接接触页面和隐私数据，只负责：
   · 定义 Agent 可调用工具
   · 生成本地安全计划
   · 校验大模型返回的计划
   · 对高风险请求做强制安全兜底

   浏览器中挂到 window.WGAgent，Node 测试中通过 module.exports 导出。
   ============================================================ */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WGAgent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TOOLS = {
    get_time: {
      label: '读取当前时间',
      description: '查询现在的日期、星期和时间。',
      risk: 'safe'
    },
    get_weather: {
      label: '查询天气',
      description: '查询老人所在城市的实时天气，并给出简单出行提醒。',
      risk: 'safe'
    },
    get_medication_schedule: {
      label: '查看用药计划',
      description: '读取今天要吃哪些药、分别在什么时间吃。',
      risk: 'safe'
    },
    get_medication_status: {
      label: '核对用药状态',
      description: '检查今天的药是否已经打卡，并指出还没完成的次数。',
      risk: 'safe'
    },
    check_fraud: {
      label: '分析诈骗话术',
      description: '用可解释规则判断对方的话是否存在诈骗风险。',
      risk: 'safe'
    },
    find_contact: {
      label: '查找家人',
      description: '根据称呼查找老人已保存的家人联系方式。',
      risk: 'safe'
    },
    prepare_call: {
      label: '准备拨号',
      description: '准备一个拨号按钮。必须由老人亲自点击后才会拨出。',
      risk: 'sensitive'
    },
    prepare_emergency_call: {
      label: '准备急救电话',
      description: '为他人突发紧急情况准备 120 拨号按钮，仍由现场人员亲自点击。',
      risk: 'safe'
    },
    notify_family: {
      label: '通知家人',
      description: '把需要家人协同的事件推送到家人端。只发送必要信息。',
      risk: 'sensitive'
    },
    get_care_status: {
      label: '检查平安状态',
      description: '检查最近活动、无活动时长、活动范围和位置状态。',
      risk: 'safe'
    },
    get_location: {
      label: '获取位置',
      description: '读取当前定位，用于走失查找。',
      risk: 'sensitive'
    },
    create_reminder: {
      label: '创建提醒',
      description: '把一句话中的时间和事项保存为日程提醒。',
      risk: 'sensitive'
    },
    remember_fact: {
      label: '写入长期记忆',
      description: '记住老人明确要求长期保留的偏好或事实。',
      risk: 'sensitive'
    },
    open_page: {
      label: '打开功能页',
      description: '打开吃药、防骗、电话、日程等功能页面。',
      risk: 'safe'
    },
    ask_user: {
      label: '向老人确认',
      description: '信息不足或需要授权时，暂停任务并向老人问一个清楚的问题。',
      risk: 'safe'
    },
    converse: {
      label: '自然对话',
      description: '没有本地工具可用时，用简短、温和、非诊断性的语言回答。',
      risk: 'safe'
    }
  };

  /*
   * 紧急识别刻意分成两层：
   * 1. 求救、呼吸/胸痛、倒地、出血、走失等信号直接进入紧急计划；
   * 2. 普通不适先进入“需确认”，避免把“我有点头晕”直接当成最高风险，
   *    也避免在老人明确说“没有摔倒”时误触家人通知。
   */
  var STRONG_EMERGENCY_RE = new RegExp([
    '救命', '救救我', '快来救我', '快不行了',
    '呼吸困难', '喘不上气', '喘不过气', '憋气',
    '胸口疼', '胸口痛', '胸口发闷', '心慌得厉害',
    '叫不醒', '意识不清', '昏过去', '晕倒',
    '摔倒了', '摔了一跤', '摔了', '跌倒', '跌了',
    '起不来', '站不起来', '站不稳', '倒在地上', '爬不起来',
    '出血不止', '流血不止', '大量出血', '头破血流',
    '磕破头', '撞到头', '找不到回家的路', '迷路了', '走丢了'
  ].join('|'));
  var DISCOMFORT_RE = /不舒服|难受|头晕|恶心|没力气|疼得厉害|发烧/;
  var MILD_RE = /有点|稍微|一点点|轻微/;
  var EXPLICIT_OPTOUT_RE = /(?:别|不要|不用|先别).{0,4}(?:通知|告诉).{0,4}(?:家人|子女|女儿|儿子|亲人)/;
  var HYPOTHETICAL_RE = /如果|假如|万一|要是/;
  var NEGATED_EVENT_RE = /(?:没有|没|并未|并没有|不是|不曾|从没).{0,4}(?:真的)?(?:摔倒|摔了|跌倒|跌了|不舒服|难受|头晕|喘不上气|喘不过气|胸口疼|胸口痛|出血)/g;
  var MEDIA_CONTEXT_RE = /(?:电视|电影|电视剧|视频|节目|广播)(?:里|上|中|里面)|新闻(?:里|上|中|里面)|(?:看|刷)到(?:一条|个)?(?:新闻|视频|消息)|听说|听(?:别人|邻居|朋友|新闻|广播).{0,4}说|别人告诉我|朋友圈|群里|网上说/;
  var THIRD_PARTY_RE = /(?:我(?:的)?)?(?:老伴|爱人|儿子|女儿|儿媳|女婿|孙子|孙女|外孙|外孙女|父亲|母亲|爸爸|妈妈|邻居|朋友|亲戚|保姆|护工|路人|有人|他|她)(?:现在|刚刚|刚才|突然|好像|不小心)?[^，。！？,.!?]{0,10}(?:摔倒|摔了|跌倒|跌了|喘不上气|喘不过气|胸口疼|胸口痛|叫不醒|晕倒|出血|磕破头|迷路|走丢)/;
  var REPORTED_SELF_RE = /我.{0,12}(?:说|告诉|讲|问).{0,6}我(?:现在|刚刚|刚才|突然|真的|不小心)?[^，。！？,.!?]{0,8}(?:摔倒|摔了|跌倒|喘不上气|喘不过气|胸口疼|胸口痛|叫不醒|晕倒|出血|磕破头)/;
  var SELF_EMERGENCY_RE = /(?:^|[，。！？,.!?\s])我(?:现在|刚刚|刚才|突然|真的|不小心)?[^，。！？,.!?]{0,10}(?:摔倒|摔了|跌倒|跌了|站不起来|起不来|喘不上气|喘不过气|胸口疼|胸口痛|胸口发闷|叫不醒|晕倒|出血|磕破头)/;
  var DIRECT_HELP_RE = /(?:^|[，。！？,.!?\s])(?:救命|救救我|快来救我|快不行了)/;
  var NORMALIZE_PAIRS = [
    ['睡倒', '摔倒'], ['衰倒', '摔倒'], ['甩倒', '摔倒'],
    ['就命', '救命'], ['救名', '救命'],
    ['揣不上气', '喘不上气'], ['喘不上去', '喘不上气'],
    ['胸口发焖', '胸口发闷'], ['胸口发懑', '胸口发闷'],
    ['啥子时候', '什么时候'], ['啥时候', '什么时候'], ['啥辰光', '什么时候'],
    ['几时', '什么时候'], ['几时食', '什么时候吃'], ['多早晚', '什么时候'],
    ['点样', '怎么样'], ['哪能', '怎么样'], ['咋样', '怎么样'], ['咋个', '怎么'],
    ['啥子', '什么'], ['乜嘢', '什么'], ['啥', '什么'],
    ['莫得', '没有'], ['呒没', '没有'], ['冇', '没有'], ['没得', '没有'],
    ['莫要', '不要'], ['唔好', '不要'], ['勿要', '不要'],
    ['晓得', '知道'], ['知唔知', '知道吗'],
    ['食药', '吃药'], ['食饭', '吃饭'], ['而家', '现在'],
    ['中咗奖', '中奖'], ['中左奖', '中奖'], ['中着奖', '中奖'],
    ['畀钱', '给钱'], ['付钞票', '付钱'], ['钞票', '钱'],
    ['边个', '谁'], ['边度', '哪里'], ['啥地方', '哪里'],
    ['孃孃', '阿姨'], ['阿婆', '奶奶'], ['婶儿', '阿姨']
  ];
  var FRAUD_RE = /骗子|诈骗|骗人|安全账户|转钱|转账|洗钱|验证码|中奖|退款|冒充|公检法|保密/;
  var MED_RE = /吃什么药|吃哪些药|吃药|吃过药|药吃了|药吃过|用药|药没吃|药物|降压药/;
  var WEATHER_RE = /天气|下雨|下雨吗|气温|冷不冷|热不热|穿什么/;
  var CARE_RE = /平安|活动|动静|走失|离开范围|在哪里|位置/;
  var REMEMBER_RE = /^(?:请)?记住|以后都|以后要|我喜欢|我不喜欢|别忘了我/;
  var REMINDER_RE = /提醒我|叫我|安排一下|记一下|到时间/;
  var TIME_RE = /(今天|明天|后天|大后天|上午|中午|下午|晚上|凌晨|\d{1,2}\s*点|\d{1,2}[:：]\d{1,2}|\d+\s*分钟|\d+\s*小时)/;
  var CALL_RE = /打电话|打个电话|联系|拨给|找一下/;
  var NAV_RE = /我要去|怎么去|带我去|导航到|路线/;

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  function normalizeText(value) {
    var text = cleanText(value);
    NORMALIZE_PAIRS.forEach(function (pair) {
      text = text.split(pair[0]).join(pair[1]);
    });
    return text;
  }

  function classifyEmergencySubject(text) {
    if (MEDIA_CONTEXT_RE.test(text)) return 'media';
    if (REPORTED_SELF_RE.test(text)) return 'self';
    if (THIRD_PARTY_RE.test(text)) return 'third-party';
    if (SELF_EMERGENCY_RE.test(text) || DIRECT_HELP_RE.test(text)) return 'self';
    return 'self';
  }

  function assessUrgency(rawText) {
    var text = normalizeText(rawText);
    var hypothetical = HYPOTHETICAL_RE.test(text) && !/已经|刚刚|真的/.test(text);
    if (hypothetical) {
      return { level: 'normal', reason: 'hypothetical', subject: 'none', explicitOptOut: false };
    }

    var positiveText = text.replace(NEGATED_EVENT_RE, ' ');
    var explicitOptOut = EXPLICIT_OPTOUT_RE.test(text);
    var hasEmergencySignal = STRONG_EMERGENCY_RE.test(positiveText) || DISCOMFORT_RE.test(positiveText);
    var subject = hasEmergencySignal ? classifyEmergencySubject(positiveText) : 'none';
    if (subject === 'media') {
      return { level: 'normal', reason: 'media-context', subject: subject, explicitOptOut: explicitOptOut };
    }
    if (subject === 'third-party') {
      return { level: 'third-party', reason: 'third-party-emergency', subject: subject, explicitOptOut: explicitOptOut };
    }
    if (STRONG_EMERGENCY_RE.test(positiveText)) {
      return { level: 'urgent', reason: 'emergency-signal', subject: subject, explicitOptOut: explicitOptOut };
    }
    if (DISCOMFORT_RE.test(positiveText)) {
      if (explicitOptOut || MILD_RE.test(positiveText)) {
        return { level: 'caution', reason: 'discomfort-needs-check', subject: subject, explicitOptOut: explicitOptOut };
      }
      return { level: 'urgent', reason: 'discomfort', subject: subject, explicitOptOut: explicitOptOut };
    }
    return {
      level: 'normal',
      reason: 'none',
      subject: 'none',
      explicitOptOut: explicitOptOut
    };
  }

  function hasUrgentSignal(text) {
    return assessUrgency(text).level === 'urgent';
  }

  function contactNameFrom(text) {
    var m = /(?:给|联系|找|打给|拨给)([^，。！？,.!?\s]{1,8})(?:打|说|联系|号码|电话)/.exec(text) ||
            /(?:给|联系|找|打给|拨给)([^，。！？,.!?\s]{1,8})/.exec(text);
    if (!m) return '';
    var name = m[1].replace(/^(一下|个|我的|我)/, '');
    if (/什么|谁|电话|手机/.test(name)) return '';
    return name.slice(0, 8);
  }

  function step(tool, args, purpose) {
    var meta = TOOLS[tool] || TOOLS.converse;
    return {
      tool: tool,
      args: args || {},
      purpose: purpose || meta.description,
      risk: meta.risk || 'safe',
      requiresConfirmation: meta.risk === 'sensitive'
    };
  }

  function isToolName(name) {
    return typeof name === 'string' &&
      Object.prototype.hasOwnProperty.call(TOOLS, name);
  }

  function makePlan(goal, risk, steps, source, extra) {
    extra = extra || {};
    return {
      goal: goal || '完成老人的请求',
      risk: risk || 'normal',
      steps: steps,
      source: source || 'local',
      needsPlanner: !!extra.needsPlanner,
      safetyNotes: extra.safetyNotes || [],
      spoken: extra.spoken || ''
    };
  }

  function uniqueSteps(steps) {
    var seen = {};
    return steps.filter(function (s) {
      var key = s.tool + ':' + JSON.stringify(s.args || {});
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function addStep(list, tool, args, purpose) {
    var s = step(tool, args, purpose);
    var exists = list.some(function (x) {
      return x.tool === s.tool && JSON.stringify(x.args || {}) === JSON.stringify(s.args || {});
    });
    if (!exists) list.push(s);
    return s;
  }

  /* 本地规划专门负责紧急场景和高频任务。它不追求“什么都会”，
     但必须保证断网、没配大模型时核心养老能力仍然可执行。 */
  function planLocal(rawText, context) {
    var text = cleanText(rawText);
    var lower = text.toLowerCase();
    var urgency = assessUrgency(text);
    var urgent = urgency.level === 'urgent';
    var steps = [];
    var goal = '回应老人的请求';
    var risk = urgent ? 'urgent' : 'normal';
    var contactName = contactNameFrom(text);

    if (urgent) {
      goal = '确认老人状态并联系家人';
      addStep(steps, 'get_care_status', {}, '先读取最近活动和位置，给家人提供必要上下文');
      addStep(steps, 'find_contact', { name: contactName || '家人' }, '找到最合适的紧急联系人');
      addStep(steps, 'notify_family', {
        kind: '高风险',
        reason: text
      }, '把老人求助事件同步给家人端');
      addStep(steps, 'prepare_call', { name: contactName || '家人' }, '准备一个由老人确认后执行的拨号按钮');
      return makePlan(goal, risk, steps, 'local-safety', {
        safetyNotes: [
          '不做医学诊断',
          '不自动拨号，必须由老人本人点击',
          '高风险事件优先通知家人'
        ]
      });
    }

    if (urgency.level === 'third-party') {
      goal = '帮助老人处理他人的突发紧急情况';
      addStep(steps, 'prepare_emergency_call', {}, '准备由现场人员亲自点击的急救电话');
      if (/通知家人|联系家人|告诉家人/.test(text)) {
        addStep(steps, 'notify_family', { kind: '他人紧急', reason: text }, '按老人明确要求同步家人');
      }
      if (!/还有呼吸|有呼吸|能叫醒|清醒|没有呼吸|叫不醒|没意识/.test(text)) {
        addStep(steps, 'ask_user', {
          question: '先确认对方现在有没有呼吸、能不能叫醒。如果叫不醒或呼吸困难，请马上拨打 120。',
          slot: 'emergency-detail',
          resumeTool: 'prepare_emergency_call'
        }, '确认对方状态并提醒现场急救');
      }
      return makePlan(goal, 'caution', steps, 'local-safety', {
        safetyNotes: [
          '区分老人本人和他人发生的紧急情况',
          '只准备急救拨号，不自动拨出',
          '不把他人事故直接当成老人本人跌倒'
        ]
      });
    }

    if (urgency.level === 'caution' && DISCOMFORT_RE.test(text)) {
      goal = '确认老人当前状态并给出安全的求助方式';
      addStep(steps, 'get_care_status', {}, '先读取最近活动状态，避免继续执行无关任务');
      addStep(steps, 'ask_user', {
        question: '听起来你有点不舒服。现在坐着或躺着还稳吗？如果越来越难受，请马上告诉家里人。'
      }, '确认不适程度；在老人明确要求前不自动通知家人');
      return makePlan(goal, 'caution', steps, 'local-safety', {
        safetyNotes: [
          '识别到普通不适，先向老人确认',
          '老人明确表示暂不通知家人时不自动推送',
          '出现呼吸困难、胸痛或倒地等情况时仍按紧急场景处理'
        ]
      });
    }

    if (FRAUD_RE.test(text) && !/为什么|什么是|怎么识别/.test(text)) {
      goal = '判断诈骗风险并给出行动建议';
      addStep(steps, 'check_fraud', { text: text }, '分析对方的话里有哪些高风险话术');
      risk = 'caution';
      if (/告诉家里人|联系家里人|通知家人|给女儿|给儿子/.test(text)) {
        addStep(steps, 'find_contact', { name: contactName || '家人' }, '查找家人');
        addStep(steps, 'prepare_call', { name: contactName || '家人' }, '准备和家人核实');
      }
      return makePlan(goal, risk, steps, 'local', {
        safetyNotes: ['不索要验证码', '不建议转账', '不自动代替老人操作资金']
      });
    }

    /*
     * “提醒我明天吃药”是创建日程，不是查询用药计划。
     * 只有“今天吃什么药”“吃过药了吗”等问句才进入用药查询。
     */
    if (REMINDER_RE.test(text) && !WEATHER_RE.test(text) &&
        !/吃过药|吃了没|吃没吃|是否吃|吃什么药|哪些药|药吃了没|药物状态/.test(text)) {
      goal = '创建一条日程提醒';
      if (!TIME_RE.test(text)) {
        addStep(steps, 'ask_user', {
          question: '好，我记着这件事。请告诉我具体是哪一天、几点提醒你。',
          slot: 'time',
          resumeTool: 'create_reminder'
        }, '缺少具体时间，先向老人确认');
        return makePlan(goal, risk, steps, 'local', {
          safetyNotes: ['信息不足时不猜测时间']
        });
      }
      addStep(steps, 'create_reminder', { text: text }, '解析时间并保存提醒');
      return makePlan(goal, risk, steps, 'local');
    }

    if (MED_RE.test(text)) {
      goal = /吃过了|吃了没|吃没吃|是否吃|状态|吃过药/.test(text)
        ? '核对今天的用药状态'
        : '查看今天的用药计划';
      addStep(steps,
        /吃过了|吃了没|吃没吃|是否吃|状态|吃过药/.test(text) ? 'get_medication_status' : 'get_medication_schedule',
        {}, goal);
      if (/提醒家人|通知家人|告诉女儿|告诉儿子/.test(text)) {
        addStep(steps, 'notify_family', { kind: '用药', reason: text }, '同步用药情况');
      }
      return makePlan(goal, risk, steps, 'local');
    }

    if (WEATHER_RE.test(text)) {
      goal = '查询天气并给出适合老人的提醒';
      addStep(steps, 'get_weather', {}, goal);
      if (/提醒我|记一下|出门|公园|买菜/.test(text)) {
        addStep(steps, 'create_reminder', { text: text }, '把出行事项保存成提醒');
      }
      return makePlan(goal, risk, steps, 'local');
    }

    if (CARE_RE.test(text)) {
      goal = '检查老人的平安状态';
      addStep(steps, 'get_care_status', {}, '读取最近活动和位置状态');
      if (/定位|在哪里|位置/.test(text)) {
        addStep(steps, 'get_location', {}, '更新当前位置');
      }
      return makePlan(goal, risk, steps, 'local');
    }

    if (REMEMBER_RE.test(text)) {
      goal = '写入老人主动要求保留的记忆';
      addStep(steps, 'remember_fact', { text: text }, '保存偏好或重要事实');
      return makePlan(goal, risk, steps, 'local', {
        safetyNotes: ['只保存老人明确要求记住的内容']
      });
    }

    if (CALL_RE.test(text)) {
      goal = '帮助老人联系家人';
      addStep(steps, 'find_contact', { name: contactName || '' }, '查找要联系的人');
      addStep(steps, 'prepare_call', { name: contactName || '' }, '准备人工确认后的拨号按钮');
      return makePlan(goal, risk, steps, 'local');
    }

    if (NAV_RE.test(text)) {
      goal = '规划出行路线';
      addStep(steps, 'open_page', { page: 'nav', query: text }, '打开导航并继续解析目的地');
      return makePlan(goal, risk, steps, 'local');
    }

    if (REMINDER_RE.test(text)) {
      goal = '创建一条日程提醒';
      if (!TIME_RE.test(text)) {
        addStep(steps, 'ask_user', {
          question: '好，我记着这件事。请告诉我具体是哪一天、几点提醒你。',
          slot: 'time',
          resumeTool: 'create_reminder'
        }, '缺少具体时间，先向老人确认');
        return makePlan(goal, risk, steps, 'local', {
          safetyNotes: ['信息不足时不猜测时间']
        });
      }
      addStep(steps, 'create_reminder', { text: text }, '解析时间并保存提醒');
      return makePlan(goal, risk, steps, 'local');
    }

    if (/几点|什么时候了|几号|星期几|今天是什么日子|日期/.test(text)) {
      goal = '回答时间日期问题';
      addStep(steps, 'get_time', {}, goal);
      return makePlan(goal, risk, steps, 'local');
    }

    if (/你能做什么|怎么用|agent|智能体|会什么|帮我做什么/i.test(text)) {
      goal = '介绍 Agent 的能力边界';
      return makePlan(goal, risk, [
        step('converse', {
          prompt: '用三句以内、老人能听懂的话介绍：可以语音对话、查用药、判断诈骗、检查平安状态、通知家人和创建提醒；不代替医生，也不自动拨号。'
        }, goal)
      ], 'local', {
        spoken: '我可以陪你说话，也能查药、防骗、报平安和联系家人。危险的事，我会先提醒家里人。'
      });
    }

    /* 复合请求通常需要模型拆步骤。unknown 不直接等同于“回答不了”。 */
    goal = '理解并规划一个多步养老任务';
    return makePlan(goal, risk, [
      step('converse', { prompt: text }, '先给出自然语言回答')
    ], 'local', {
      needsPlanner: true
    });
  }

  function shouldUseRemote(text, localPlan) {
    var t = cleanText(text);
    if (!localPlan) return true;
    if (localPlan.risk === 'urgent') return false;
    if (localPlan.needsPlanner) return true;
    if (/吃药|吃过药|服药|服药过/.test(t) && /如果|要是|没吃就|没服就/.test(t)) return true;
    if (/先.+再|然后|顺便|同时|并且|帮我处理|规划一下|安排一下/.test(t) && localPlan.steps.length >= 1) {
      return true;
    }
    return false;
  }

  function normalizePlan(input, rawText) {
    if (!input || typeof input !== 'object') return null;
    var risk = /^(normal|caution|urgent)$/.test(input.risk) ? input.risk : 'normal';
    var rawSteps = Array.isArray(input.steps) ? input.steps : [];
    var steps = [];
    rawSteps.slice(0, 6).forEach(function (s) {
      if (!s) return;
      var name = typeof s === 'string' ? s : s.tool;
      if (!isToolName(name)) return;
      var args = (s && typeof s === 'object' && s.args && typeof s.args === 'object') ? s.args : {};
      var meta = TOOLS[name];
      steps.push({
        tool: name,
        args: args,
        purpose: String(s.purpose || meta.description).slice(0, 120),
        risk: meta.risk,
        requiresConfirmation: meta.risk === 'sensitive'
      });
    });
    steps = uniqueSteps(steps);
    if (!steps.length) steps = [step('converse', { prompt: cleanText(rawText) }, '自然语言回答')];

    var plan = makePlan(
      String(input.goal || '完成老人的请求').slice(0, 120),
      risk,
      steps,
      'llm',
      {
        safetyNotes: Array.isArray(input.safetyNotes)
          ? input.safetyNotes.slice(0, 5).map(function (x) { return String(x).slice(0, 100); })
          : [],
        spoken: String(input.spoken || '').slice(0, 240)
      }
    );
    return enforceSafety(plan, rawText);
  }

  /* 模型计划必须过安全门。模型漏掉紧急通知时，这里会强制补回来。 */
  function enforceSafety(plan, rawText) {
    if (!plan) return plan;
    var text = cleanText(rawText);
    if (!hasUrgentSignal(text)) return plan;

    plan.risk = 'urgent';
    plan.goal = plan.goal || '确认老人状态并联系家人';
    var names = plan.steps.map(function (s) { return s.tool; });
    if (names.indexOf('get_care_status') < 0) {
      plan.steps.unshift(step('get_care_status', {}, '读取必要上下文'));
    }
    if (names.indexOf('find_contact') < 0) {
      plan.steps.push(step('find_contact', { name: contactNameFrom(text) || '家人' }, '查找紧急联系人'));
    }
    if (names.indexOf('notify_family') < 0) {
      plan.steps.push(step('notify_family', { kind: '高风险', reason: text }, '高风险事件同步家人'));
    }
    if (names.indexOf('prepare_call') < 0) {
      plan.steps.push(step('prepare_call', { name: contactNameFrom(text) || '家人' }, '准备人工确认的拨号'));
    }
    plan.steps = uniqueSteps(plan.steps).slice(0, 8);
    plan.safetyNotes = (plan.safetyNotes || []).concat(['紧急场景由本地安全策略强制兜底']);
    return plan;
  }

  /* 敏感工具的执行授权。元数据标了 sensitive 还不够，运行时必须真正检查。
     查询类工具自动执行；明确说出的写入/通知动作可执行；
     模型自行推断出的敏感动作必须让老人确认。 */
  function authorizeSensitive(step, rawText, plan) {
    if (!step || !step.requiresConfirmation) return true;
    var text = cleanText(rawText);
    var tool = step.tool;
    if (tool === 'prepare_call' || tool === 'ask_user') return true;
    if (tool === 'get_location') {
      return /定位|位置|在哪里|走失|迷路|找不到家|来接我|来找我/.test(text);
    }
    if (plan && plan.risk === 'urgent' && tool === 'notify_family') return true;
    if (tool === 'notify_family') {
      if (assessUrgency(text).explicitOptOut) return false;
      return /通知.*(?:家|子女|女儿|儿子|亲人)|告诉.*(?:家|子女|女儿|儿子|亲人)|联系.*(?:家|子女|女儿|儿子|亲人)|报平安|求助/.test(text);
    }
    if (tool === 'remember_fact') return /记住|以后都|以后要|别忘了我/.test(text);
    if (tool === 'create_reminder') return /提醒我|叫我|安排一下|记一下|到时间/.test(text);
    return false;
  }

  function mergePendingInput(pending, rawText, now) {
    var text = normalizeText(rawText);
    now = Number(now) || Date.now();
    if (!pending || !pending.originalText) return { text: text, used: false, expired: false };
    if (now - (Number(pending.at) || 0) > 10 * 60 * 1000) {
      return { text: text, used: false, expired: true };
    }
    var slot = pending.slot || (pending.tool === 'create_reminder' ? 'time' : 'general');
    var accepted = false;
    if (slot === 'time') accepted = TIME_RE.test(text);
    else if (slot === 'contact') {
      accepted = /儿子|女儿|老伴|爱人|孙子|孙女|父亲|母亲|爸爸|妈妈|亲戚|朋友|电话|号码|手机|\d{6,}/.test(text);
    } else if (slot === 'location') {
      accepted = text.length <= 80 &&
        /路|街|公园|医院|广场|小区|门口|附近|不知道|在家|这里|\d+/.test(text);
    } else if (slot === 'confirmation') {
      accepted = /^(?:要|好|行|可以|对|是|嗯|不用|不要|不|取消|算了)/.test(text);
    } else if (slot === 'emergency-detail') {
      accepted = text.length <= 100 &&
        /呼吸|叫醒|清醒|意识|昏迷|疼|血|没事|还好|不知道/.test(text);
    }
    if (accepted) {
      return {
        text: cleanText(pending.originalText) + '，' + text,
        used: true,
        expired: false,
        slot: slot
      };
    }
    return { text: text, used: false, expired: false, slot: slot };
  }

  /* 独立安全 Agent：对完整计划给出审核结论，而不是只做字符串拦截。 */
  function safetyReview(plan, rawText) {
    var findings = [];
    var confirmations = [];
    var enforced = [];
    if (!plan || !Array.isArray(plan.steps)) {
      return {
        agent: 'safety-agent',
        decision: 'block',
        risk: 'urgent',
        findings: ['计划结构无效'],
        confirmations: [],
        enforced: []
      };
    }
    plan.steps.forEach(function (s) {
      if (!isToolName(s.tool)) findings.push('未知工具：' + s.tool);
      if (s.requiresConfirmation && !authorizeSensitive(s, rawText, plan)) {
        confirmations.push(TOOLS[s.tool].label);
      }
      if (s.tool === 'prepare_call') enforced.push('拨号必须由老人本人确认');
    });
    if (hasUrgentSignal(rawText)) {
      if (!plan.steps.some(function (s) { return s.tool === 'notify_family'; })) {
        findings.push('高风险请求缺少家人通知');
      }
      if (!plan.steps.some(function (s) { return s.tool === 'prepare_call'; })) {
        findings.push('高风险请求缺少拨号准备');
      }
    }
    return {
      agent: 'safety-agent',
      decision: findings.length ? 'needs-repair' : (confirmations.length ? 'needs-confirmation' : 'approve'),
      risk: plan.risk,
      findings: findings,
      confirmations: confirmations,
      enforced: enforced
    };
  }

  /* 根据工具失败结果调整计划。失败不是简单跳过，
     而是把“观察到的新事实”变成下一步行动。 */
  function replanAfterFailure(plan, failedStep, result, rawText) {
    var tool = failedStep && failedStep.tool;
    var message = String((result && result.text) || '').trim();
    if (tool === 'get_weather') {
      return {
        strategy: 'continue',
        reason: '天气工具不可用，保留原目标并继续执行不依赖天气的步骤',
        steps: []
      };
    }
    if (tool === 'find_contact') {
      return {
        strategy: 'ask-user',
        reason: '没有找到可用联系人，需要老人或家人补充号码',
        steps: [step('ask_user', {
          question: '我没有找到可以联系的家人。请告诉我是哪位家人，或者让家人先帮你保存一个电话号码。',
          slot: 'contact',
          resumeTool: 'find_contact'
        }, '补充缺失的联系人')]
      };
    }
    if (tool === 'create_reminder') {
      return {
        strategy: 'ask-user',
        reason: '提醒写入失败或时间不完整，需要重新确认时间',
        steps: [step('ask_user', {
          question: '这件事还没有保存成功。请再告诉我一次具体是哪一天、几点。',
          slot: 'time',
          resumeTool: 'create_reminder'
        }, '重新确认提醒时间')]
      };
    }
    if (tool === 'notify_family') {
      return {
        strategy: 'fallback-call',
        reason: '家人端通知失败，改为准备直接拨号',
        steps: [
          step('find_contact', { name: contactNameFrom(rawText) || '家人' }, '重新查找紧急联系人'),
          step('prepare_call', { name: contactNameFrom(rawText) || '家人' }, '准备人工确认的拨号')
        ]
      };
    }
    if (tool === 'get_location') {
      return {
        strategy: 'ask-user',
        reason: '定位不可用，需要老人说明当前位置或重新授权',
        steps: [step('ask_user', {
          question: '这次没有拿到位置。你知道自己现在在哪里吗？可以说附近的路名或店名。',
          slot: 'location',
          resumeTool: 'get_location'
        }, '请老人补充当前位置')]
      };
    }
    return message ? {
      strategy: 'continue',
      reason: '工具失败但任务仍可继续：' + message.slice(0, 80),
      steps: []
    } : null;
  }

  /* 后台主动关怀计划。Agent 不是只等用户输入，而是在检测到信号后主动发起。 */
  function planProactive(signal) {
    signal = signal || {};
    if (signal.type === 'inactive') {
      return makePlan('主动确认长时间无活动的老人是否安全', 'caution', [
        step('get_care_status', {}, '读取无活动时长和位置状态'),
        step('ask_user', {
          question: '你已经有' + (signal.hours || '较长时间') + '没有动静了。现在还好吗？请回我一句话。'
        }, '主动询问老人状态')
      ], 'proactive-agent', {
        safetyNotes: ['先主动询问，不立即打扰家人', '未回应后再升级协同']
      });
    }
    if (signal.type === 'medication') {
      return makePlan('主动确认漏服药物情况', 'caution', [
        step('get_medication_status', {}, '核对待完成的用药'),
        step('ask_user', {
          question: signal.question || '该吃的药还没有打卡，现在方便吃药吗？'
        }, '提醒老人确认用药状态')
      ], 'proactive-agent', {
        safetyNotes: ['不提供剂量和诊断建议']
      });
    }
    if (signal.type === 'event') {
      return makePlan('主动提醒临近日程', 'normal', [
        step('ask_user', {
          question: signal.question || '快到安排时间了，需要我帮你准备吗？'
        }, '主动确认日程准备情况')
      ], 'proactive-agent');
    }
    return null;
  }

  function buildProactiveEscalation(signal) {
    signal = signal || {};
    if (signal.type !== 'inactive') return null;
    return makePlan('老人未回应主动询问，升级为家庭协同', 'urgent', [
      step('get_care_status', {}, '再次确认最新平安状态'),
      step('find_contact', { name: '家人' }, '查找紧急联系人'),
      step('notify_family', {
        kind: '高风险',
        reason: signal.reason || '老人长时间无活动且未回应Agent询问'
      }, '把未回应事件通知家人'),
      step('prepare_call', { name: '家人' }, '准备人工确认的拨号')
    ], 'proactive-agent', {
      safetyNotes: ['老人未回应后升级家人协同', '拨号仍需人工确认']
    });
  }

  /*
   * 最终回答只使用真实执行结果。模型生成的 spoken 仅能用于纯闲聊，
   * 不能覆盖工具失败，也不能声称一个没有执行成功的动作已经完成。
   */
  function composeGroundedAnswer(plan, results, rawText) {
    plan = plan || {};
    results = Array.isArray(results) ? results : [];
    var asked = results.filter(function (item) { return item.result && item.result.askUser; })[0];
    if (asked) return asked.result.text;
    var cancelled = results.filter(function (item) { return item.result && item.result.cancelled; })[0];
    if (cancelled) return cancelled.result.text;

    var pureConversation = results.length > 0 && results.every(function (item) {
      return item.result && item.result.ok && item.step && item.step.tool === 'converse';
    });
    if (plan.spoken && (results.length === 0 || pureConversation)) return plan.spoken;

    if (plan.risk === 'urgent') {
      var notified = results.some(function (item) {
        return item.step && item.step.tool === 'notify_family' && item.result && item.result.ok;
      });
      var canCall = results.some(function (item) {
        return item.result && item.result.action && item.result.action.type === 'call';
      });
      return '你先别着急。' +
        (hasUrgentSignal(rawText) ? '如果摔倒了先别硬撑着起来。' : '') +
        (notified ? '我已经把求助信息发给家人。' : '家人通知还没有成功。') +
        (canCall ? '你可以点下面的按钮直接打电话。' : '通讯录里还没有可用号码，请让家人帮你存一个。');
    }

    var failures = results.filter(function (item) {
      return item.result && item.result.ok === false && !item.result.askUser && !item.result.cancelled;
    });
    var seen = {};
    var parts = [];
    results.forEach(function (item) {
      var text = String((item.result && item.result.text) || '').trim();
      if (text && !seen[text]) {
        seen[text] = true;
        parts.push(text);
      }
    });
    if (!parts.length) return '我没有得到可用的执行结果，这件事还没有完成。';
    return (failures.length ? '这件事没有全部完成。' : '') + parts.join(' ');
  }

  function toolCatalog() {
    return Object.keys(TOOLS).map(function (name) {
      return {
        name: name,
        label: TOOLS[name].label,
        description: TOOLS[name].description,
        risk: TOOLS[name].risk
      };
    });
  }

  return {
    TOOLS: TOOLS,
    toolCatalog: toolCatalog,
    planLocal: planLocal,
    normalizePlan: normalizePlan,
    enforceSafety: enforceSafety,
    authorizeSensitive: authorizeSensitive,
    mergePendingInput: mergePendingInput,
    safetyReview: safetyReview,
    replanAfterFailure: replanAfterFailure,
    planProactive: planProactive,
    buildProactiveEscalation: buildProactiveEscalation,
    shouldUseRemote: shouldUseRemote,
    hasUrgentSignal: hasUrgentSignal,
    assessUrgency: assessUrgency,
    contactNameFrom: contactNameFrom,
    cleanText: cleanText,
    normalizeText: normalizeText,
    composeGroundedAnswer: composeGroundedAnswer
  };
});
