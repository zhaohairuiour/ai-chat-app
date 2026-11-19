// ========== 状态 ==========
let currentUser = null;
let currentConvId = null;
let currentModel = '';
let streaming = false;
let deactivating = false;   // 账号是否处于注销冷静期（早于 refreshSpendDisplay 使用，必须声明在前）

// 复制文本（兼容 WebView：clipboard API 不可用时用 execCommand）
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  // WebView fallback：用 textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0'; ta.style.left = '0';
    ta.style.width = '2px'; ta.style.height = '2px';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}
let currentMaxTokens = 1500;
try { const _mt = parseInt(localStorage.getItem('aichat-maxtok'), 10); if (_mt > 0) currentMaxTokens = _mt; } catch (_) {}
let currentNode = 0;

// 联网三态开关：'auto' = AI 自动判断；'on' = 强制联网；'off' = 完全不联网
let webMode = 'auto';
// 自动联网的触发规则：时效性/事实性/对比类问题才搜，创作与闲聊不搜
const NEED_SEARCH_RE = /(最新|今天|今日|现在|近期|最近|价格|报价|多少钱|新闻|资讯|政策|发布|上市|股价|行情|天气|哪家|哪个好|对比|评测|推荐|搜一下|查一下|搜索|联网|官网|版本号)/i;

// ========== 技能系统（字段化模板，去除硬编码） ==========
// 每个技能由 fields + buildPrompt 组成；fields 为空时等同普通输入
// 字段类型：text / textarea / select；text 必填时发送前会校验
const SKILLS = [
  {
    icon: 'write', label: '写文案',
    fields: [
      { key: 'scene', label: '场景', type: 'select',
        options: ['通用', '朋友圈', '小红书', '抖音', '微博', '公众号', '知乎', '广告语', '短视频脚本', '产品介绍'],
        default: '通用' },
      { key: 'topic', label: '主题/要点', type: 'text', placeholder: '想写什么内容？例如：周末爬山、护肤品种草', required: true },
      { key: 'tone', label: '语气', type: 'select',
        options: ['不限', '幽默', '温暖', '专业', '文艺', '热血', '治愈', '搞笑'], default: '不限' },
      { key: 'length', label: '长度', type: 'select', options: ['不限', '短(50字内)', '中(50-200字)', '长(200字+)'], default: '不限' },
    ],
    buildPrompt: ({ scene, topic, tone, length }) => {
      const style = {
        '朋友圈': '生活化、有真实感、适当 emoji',
        '小红书': 'emoji 丰富、有吸引力的小标题、突出种草感、关键词加 #',
        '抖音': '口语化、节奏感强、前 3 秒抓眼球',
        '微博': '140 字以内、简短有梗',
        '公众号': '开头吸睛、结构清晰、有金句',
        '知乎': '有理有据、有观点、可信',
        '广告语': '简短有力、有记忆点',
        '短视频脚本': '分镜感、口播节奏、含钩子',
        '产品介绍': '突出卖点与适用人群',
      }[scene] || '风格自然';
      const toneText = tone && tone !== '不限' ? `语气：${tone}。` : '';
      const lenText = length && length !== '不限' ? `长度：${length}。` : '';
      return `请帮我写一段【${scene}】文案，主题/要点：${topic}。\n风格要求：${style}。${toneText}${lenText}请直接输出最终文案，不要解释为什么这么写。`;
    }
  },
  {
    icon: 'mail', label: '写邮件',
    fields: [
      { key: 'purpose', label: '邮件类型', type: 'select',
        options: ['通用', '工作汇报', '请假申请', '客户开发', '商务合作', '投诉处理', '感谢信', '求职信', '会议邀请', '催办'],
        default: '通用' },
      { key: 'recipient', label: '收件人', type: 'text', placeholder: '例如：王经理 / 客户张总' },
      { key: 'points', label: '要点/事由', type: 'textarea', placeholder: '邮件要传达的核心内容，可多行', required: true },
      { key: 'tone', label: '语气', type: 'select', options: ['正式', '友好', '诚恳', '简洁'], default: '正式' },
    ],
    buildPrompt: ({ purpose, recipient, points, tone }) =>
      `请帮我写一封${tone}的邮件。\n用途：${purpose}。\n收件人：${recipient || '未指定'}。\n要点/事由：\n${points}\n请输出完整邮件（含主题、正文、落款），不要附加解释。`
  },
  {
    icon: 'work', label: '职场建议',
    fields: [
      { key: 'situation', label: '情境描述', type: 'textarea', placeholder: '把遇到的问题尽量说清楚', required: true },
      { key: 'role', label: '你的身份', type: 'text', placeholder: '例如：产品经理 / 销售 / 应届生' },
    ],
    buildPrompt: ({ situation, role }) =>
      `我在工作中有以下问题需要建议：\n${situation}\n（我的身份：${role || '未指定'}）\n请给出具体、可执行的建议，分点列出，最后给出 1 个最关键的行动项。`
  },
  {
    icon: 'food', label: '菜谱推荐',
    fields: [
      { key: 'ingredients', label: '食材', type: 'text', placeholder: '例如：鸡胸肉', required: true, multi: true },
      { key: 'cuisine', label: '菜系', type: 'select',
        options: ['不限', '中式', '西式', '日韩', '东南亚', '甜品', '减脂餐'], default: '不限' },
      { key: 'difficulty', label: '难度', type: 'select', options: ['不限', '简单', '中等', '挑战'], default: '不限' },
    ],
    buildPrompt: ({ ingredients, cuisine, difficulty }) =>
      `我想用以下食材做菜：${ingredients}。\n菜系偏好：${cuisine}。难度：${difficulty}。\n请推荐 1 道最合适的菜，给出食材用量、步骤和小贴士。`
  },
  {
    icon: 'travel', label: '旅行攻略',
    fields: [
      { key: 'destination', label: '目的地', type: 'text', placeholder: '例如：日本京都、云南大理', required: true },
      { key: 'days', label: '天数', type: 'select', options: ['1天', '2天', '3天', '5天', '7天', '10天+'], default: '3天' },
      { key: 'companion', label: '同行人', type: 'select',
        options: ['不限', '情侣', '亲子', '朋友', '独自', '父母'], default: '不限' },
      { key: 'budget', label: '预算', type: 'text', placeholder: '例如：人均 3000 元', required: false },
    ],
    buildPrompt: ({ destination, days, companion, budget }) =>
      `请帮我规划 ${days} 的【${destination}】旅行攻略。\n同行人：${companion}。\n预算：${budget || '未指定'}。\n请按天给出每日行程（时间+地点+推荐理由）、必吃美食、避坑提醒，最后给出打包清单。`
  },
  {
    icon: 'study', label: '学习计划',
    fields: [
      { key: 'target', label: '想学什么', type: 'text', placeholder: '例如：Python 入门、英语口语', required: true },
      { key: 'level', label: '当前水平', type: 'select', options: ['零基础', '入门', '进阶', '高手'], default: '零基础' },
      { key: 'duration', label: '可用时间', type: 'select', options: ['一周', '一个月', '三个月', '半年', '一年'], default: '一个月' },
      { key: 'daily', label: '每天投入', type: 'text', placeholder: '例如：每天 1 小时', required: false },
    ],
    buildPrompt: ({ target, level, duration, daily }) =>
      `我想学：${target}。当前水平：${level}。计划周期：${duration}。每日可投入：${daily || '未指定'}。\n请给我一个分阶段学习计划：每周目标、推荐资源、关键练习、检验标准。`
  },
  {
    icon: 'fitness', label: '健身计划',
    fields: [
      { key: 'goal', label: '目标', type: 'select',
        options: ['减脂', '增肌', '塑形', '提升力量', '提高心肺', '康复'], default: '塑形' },
      { key: 'level', label: '当前水平', type: 'select', options: ['零基础', '入门', '进阶', '专业'], default: '入门' },
      { key: 'place', label: '场地', type: 'select', options: ['不限', '家里(无器械)', '家里(有哑铃)', '健身房'], default: '不限' },
      { key: 'days', label: '每周天数', type: 'select', options: ['3 天', '4 天', '5 天', '6 天'], default: '4 天' },
    ],
    buildPrompt: ({ goal, level, place, days }) =>
      `请帮我制定健身计划。\n目标：${goal}。水平：${level}。场地：${place}。每周：${days}。\n请按周给出训练安排（动作+组数+次数），并附饮食和恢复建议。`
  },
  {
    icon: 'translate', label: '翻译润色',
    fields: [
      { key: 'text', label: '原文', type: 'textarea', placeholder: '要翻译或润色的内容', required: true },
      { key: 'from', label: '源语言', type: 'select',
        options: ['自动识别', '中文', '英文', '日文', '韩文', '法文', '德文', '俄文', '西班牙文'], default: '自动识别' },
      { key: 'to', label: '目标语言', type: 'select',
        options: ['中文', '英文', '日文', '韩文', '法文', '德文', '俄文', '西班牙文'], default: '中文' },
      { key: 'style', label: '风格', type: 'select',
        options: ['直译', '意译', '信达雅', '口语化', '学术', '商务', '文学'], default: '信达雅' },
    ],
    buildPrompt: ({ text, from, to, style }) =>
      `请把以下内容（${from === '自动识别' ? '语言自动识别' : from}）翻译/润色为【${to}】，风格：${style}。\n原文：\n${text}\n\n只输出最终译文/润色结果，必要时附 1-2 句关键术语注释。`
  },
  {
    icon: 'brainstorm', label: '头脑风暴',
    fields: [
      { key: 'topic', label: '主题', type: 'text', placeholder: '例如：圣诞礼物、毕业论文选题', required: true },
      { key: 'count', label: '数量', type: 'select', options: ['5 个', '10 个', '15 个', '20 个'], default: '10 个' },
      { key: 'angle', label: '切入角度', type: 'select',
        options: ['不限', '新颖', '低成本', '高创意', '可执行', '反差感'], default: '不限' },
    ],
    buildPrompt: ({ topic, count, angle }) =>
      `请围绕主题【${topic}】头脑风暴 ${count} 创意方案。切入角度：${angle}。\n请用编号列表输出，每条不超过 2 行，给出亮点和可行性。`
  },
  {
    icon: 'data', label: '数据分析',
    fields: [
      { key: 'data', label: '数据/现象', type: 'textarea', placeholder: '可粘贴表格、关键指标或描述现象', required: true },
      { key: 'goal', label: '分析目标', type: 'text', placeholder: '例如：找出转化率下降原因', required: true },
    ],
    buildPrompt: ({ data, goal }) =>
      `请基于以下数据/现象做分析。\n分析目标：${goal}\n数据：\n${data}\n\n输出：1）核心结论；2）可能原因（分点）；3）建议行动；4）需要进一步获取的数据。`
  },
  {
    icon: 'interview', label: '面试准备',
    fields: [
      { key: 'position', label: '应聘岗位', type: 'text', placeholder: '例如：高级前端工程师', required: true },
      { key: 'company', label: '公司/行业', type: 'text', placeholder: '例如：字节 / 在线教育' },
      { key: 'round', label: '轮次', type: 'select',
        options: ['不限', 'HR 初面', '技术一面', '技术二面', '主管面', '终面'], default: '不限' },
    ],
    buildPrompt: ({ position, company, round }) =>
      `我要面试岗位：${position}。\n公司/行业：${company || '未指定'}。轮次：${round}。\n请准备：1）高频问题清单（8-10 个）+ 参考回答思路；2）反向提问建议；3）注意事项。`
  },
  {
    icon: 'movie', label: '影评剧评',
    fields: [
      { key: 'work', label: '作品名', type: 'text', placeholder: '例如：流浪地球 2 / 繁花', required: true },
      { key: 'angle', label: '评析角度', type: 'select',
        options: ['综合', '剧情', '演技', '视听', '主题', '文化背景', '与其他作品对比'], default: '综合' },
      { key: 'length', label: '长度', type: 'select', options: ['短评(150字)', '中评(500字)', '长评(1000字+)'], default: '中评(500字)' },
    ],
    buildPrompt: ({ work, angle, length }) =>
      `请写一篇关于《${work}》的${length}，角度：${angle}。\n要求观点鲜明、避免剧透关键转折、有个人洞见，结尾给出推荐人群。`
  },
  {
    icon: 'shop', label: '购物建议',
    fields: [
      { key: 'item', label: '想买什么', type: 'text', placeholder: '例如：人体工学椅、降噪耳机', required: true },
      { key: 'budget', label: '预算', type: 'text', placeholder: '例如：2000 元以内' },
      { key: 'priority', label: '侧重', type: 'select',
        options: ['不限', '性价比', '品质', '颜值', '耐用', '性能'], default: '不限' },
    ],
    buildPrompt: ({ item, budget, priority }) =>
      `我想买：${item}。\n预算：${budget || '未指定'}。侧重：${priority}。\n请推荐 3-5 款产品，对比表形式给出（型号、价格、亮点、不足、适合人群），最后给一个最终推荐。`
  },
  {
    icon: 'mood', label: '情绪疏导',
    fields: [
      { key: 'mood', label: '当前情绪', type: 'select',
        options: ['焦虑', '压力', '低落', '烦躁', '孤独', '迷茫', '愤怒', '失落'], default: '焦虑' },
      { key: 'context', label: '背景', type: 'textarea', placeholder: '发生了什么？愿意说多少说多少', required: true },
    ],
    buildPrompt: ({ mood, context }) =>
      `我最近感到${mood}，想被倾听和疏导。\n背景：${context}\n\n请先共情回应，再帮我梳理情绪来源，最后给 3 个可执行的小建议。不要讲大道理。`
  },
  {
    icon: 'science', label: '知识科普',
    fields: [
      { key: 'topic', label: '主题', type: 'text', placeholder: '例如：黑洞是什么', required: true },
      { key: 'audience', label: '讲给谁听', type: 'select',
        options: ['小学生', '中学生', '大学生', '成人', '专业人士'], default: '成人' },
    ],
    buildPrompt: ({ topic, audience }) =>
      `请用通俗易懂的话给【${audience}】解释：${topic}。\n要求：1）核心结论先说；2）用生活化类比；3）给一个能记住的"一句话总结"。`
  },
  {
    icon: 'code', label: '项目式编程',   // 生成完整多文件项目并自动打包 zip
    project: true,
    fields: [
      { key: 'requirement', label: '项目需求', type: 'textarea', required: true,
        placeholder: '详细描述要做的项目，例如：一个带本地存储的待办事项网站，支持增删改、分类筛选、深色模式，界面美观…' },
    ],
    buildPrompt: ({ requirement }) =>
      `请构建以下项目：\n${requirement}\n请输出完整可运行的项目，包含所有必要文件和 README.md。`
  },
  {
    icon: 'free', label: '自由任务',  // 没有任何字段，纯粹作为"我现在想自由发挥"的入口
    fields: [],
    buildPrompt: (text) => text  // 直接当 prompt 发
  },
];

const $ = (id) => document.getElementById(id);
const authScreen = $('auth-screen');
const app = $('app');

// ========== SVG 图标库（替换 emoji） ==========
const SVG_PATHS = {
  write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
  work: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  food: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><path d="M6 1v3"/><path d="M10 1v3"/><path d="M14 1v3"/>',
  travel: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  study: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  fitness: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  translate: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  brainstorm: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
  data: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  interview: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  movie: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
  shop: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
  mood: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  science: '<path d="M9 3h6"/><path d="M10 3v6L4.5 19a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 9V3"/><path d="M7 15h10"/>',
  free: '<path d="M12 3l1.9 5.8 5.8 1.9-5.8 1.9L12 18.5l-1.9-5.9L4.3 10.7l5.8-1.9L12 3z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  brain: '<path d="M9.5 2a2.5 2.5 0 0 0-2.45 3A2.5 2.5 0 0 0 5 7.5a2.5 2.5 0 0 0-.6 4.9A2.5 2.5 0 0 0 6.5 15a2.5 2.5 0 0 0 2.5 2.5V22h6v-4.5a2.5 2.5 0 0 0 2.5-2.5 2.5 2.5 0 0 0 2.1-2.6 2.5 2.5 0 0 0-.6-4.9A2.5 2.5 0 0 0 19 7.5a2.5 2.5 0 0 0-2.05-2.5A2.5 2.5 0 0 0 14.5 2h-5z"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  history: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  package: '<path d="M16.5 9.4 7.5 4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.27 6.96 8.73 5.05 8.73-5.05"/><path d="M12 22.08V12"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  send: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  ban: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  sparkles: '<path d="M12 3l1.9 5.8 5.8 1.9-5.8 1.9L12 18.5l-1.9-5.9L4.3 10.7l5.8-1.9L12 3z"/><path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z"/>',
};
function svgIcon(name, size = 16) {
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG_PATHS[name] || ''}</svg>`;
}

// ========== 模型品牌图标（智谱 / poixe，方形圆角） ==========
function providerBadge(provider, size = 18) {
  const s = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.58)}px;line-height:${size}px`;
  if (provider === 'zhipu') {
    return `<span class="pbadge pbadge-zhipu" style="${s}">Z</span>`;
  }
  return `<span class="pbadge pbadge-poixe" style="${s}">P</span>`;
}

// ========== 服务器地址（APK/网站通用）：默认相对路径（同源），可在侧栏「服务器地址」配置
// 后端地址：默认内置用户部署的后端，可在菜单中修改（localStorage apiBase）
const DEFAULT_API_BASE = '';
// 旧域名迁移：设备上若缓存过旧后端地址，会一直盖住新地址
try {
  const stored = localStorage.getItem('apiBase');
  if (stored && /ip\.lhdyx\.top/.test(stored)) localStorage.removeItem('apiBase');
} catch (_) {}
const API_BASE = (localStorage.getItem('apiBase') || DEFAULT_API_BASE).replace(/\/+$/, '');
// 登录凭据（token + 用户信息）：登录成功后保存，下次自动登录
const AUTH_KEY = 'ai-chat-auth';
function getAuth() { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (_) { return null; } }
function setAuth(v) {
  try { if (v) localStorage.setItem(AUTH_KEY, JSON.stringify(v)); else localStorage.removeItem(AUTH_KEY); } catch (_) {}
  // 登录态变化时刷新依赖登录的功能入口（终端悬浮按钮等）
  try { window.dispatchEvent(new Event('aichat:auth-changed')); } catch (_) {}
}
function authToken() { const a = getAuth(); return (a && a.token) || ''; }

// ========== 本地沙箱（v3.28：仅 APK 原生环境可用） ==========
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
let sandboxApi = null;
let sandboxReady = false;
let activeTerm = null;

function getSandbox() {
  if (sandboxApi) return sandboxApi;
  if (!window.Capacitor) return null;
  try {
    if (typeof window.Capacitor.registerPlugin === 'function') {
      sandboxApi = window.Capacitor.registerPlugin('Sandbox');
      return sandboxApi;
    }
  } catch (_) {}
  if (window.Capacitor.Plugins && window.Capacitor.Plugins.Sandbox) {
    sandboxApi = window.Capacitor.Plugins.Sandbox;
    return sandboxApi;
  }
  return null;
}

let _sandboxInitPromise = null;
let _sandboxListenerRegistered = false;
let _lastSandboxSeq = 0;
let _streamTick = 0;
let _activeStreamTerm = null;

// 解压进度条：由原生 progress 事件驱动（done/total），不再用文本行模拟
function showBootProgress(label) {
  const box = $('boot-progress');
  if (!box) return;
  const modal = document.getElementById('term-modal');
  const termVisible = !!(modal && !modal.classList.contains('hidden'));
  // 终端面板可见时进度只画在终端内（#term-progress），页面顶部这条一定隐藏，
  // 否则初始化与 OpenClaw 解压会同时出现两条一模一样的进度条
  if (termVisible || /OpenClaw/i.test(String(label || ''))) {
    box.classList.add('hidden');
    const tBox = document.getElementById('term-progress');
    const tLabel = document.getElementById('term-progress-label');
    if (termVisible && tBox && label) {
      tBox.classList.remove('hidden');
      if (tLabel) tLabel.textContent = label;
    }
    return;
  }
  box.classList.remove('hidden', 'indeterminate');
  if (label) $('boot-progress-label').textContent = label;
}
function updateBootProgress(text) {
  const box = $('boot-progress');
  if (!box) return;
  const m = String(text || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return;
  const done = +m[1], total = +m[2] || 1;
  const pct = Math.min(100, Math.round(done / total * 100));
  const isOpenclaw = /OpenClaw/i.test(String(text || ''));
  const labelEl = $('boot-progress-label');
  if (labelEl) labelEl.textContent = (isOpenclaw ? '正在安装 OpenClaw 运行时 ' : '正在解压运行环境 ') + pct + '%';
  const tip = window.__ocInstallTip;
  if (tip) tip.textContent = '正在安装 OpenClaw 运行时 ' + pct + '%';
  // OpenClaw 的进度只画在终端内那一条上，页面顶部的 boot-progress 同时显示会出现两条
  if (isOpenclaw) {
    box.classList.add('hidden');
  } else {
    box.classList.remove('hidden', 'indeterminate');
    $('boot-progress-fill').style.width = pct + '%';
    $('boot-progress-label').textContent = '正在解压运行环境 ' + pct + '%（' + done + '/' + total + '）';
  }
  // 终端内的同款进度条（聊天页的 #boot-progress 会被全屏终端遮住）
  const tBox = document.getElementById('term-progress');
  const tFill = document.getElementById('term-progress-fill');
  const tLabel = document.getElementById('term-progress-label');
  if (tBox && tFill) {
    tBox.classList.remove('hidden');
    tFill.style.width = pct + '%';
    if (tLabel) {
      tLabel.textContent = (isOpenclaw ? '正在解压 OpenClaw 运行时 ' : '正在解压运行环境 ')
        + pct + '%（' + done + '/' + total + '）';
    }
    if (pct >= 100) {
      if (tLabel) tLabel.textContent = '解压完成，正在配置环境…';
      setTimeout(() => tBox.classList.add('hidden'), 1500);
    }
  }
  if (pct >= 100) {
    $('boot-progress-label').textContent = '解压完成，正在配置环境…';
    setTimeout(() => box.classList.add('hidden'), 2500);
  }
}
function hideBootProgress() {
  const box = $('boot-progress');
  if (box) box.classList.add('hidden');
}

async function ensureSandbox() {
  const sb = getSandbox();
  if (!sb) throw new Error('沙箱仅在手机端可用');
  if (sandboxReady) return sb;
  if (!_sandboxInitPromise) {
    _sandboxInitPromise = (async () => {
      // 先注册 output 监听器（容错：addListener 不可用时静默跳过）
      if (!_sandboxListenerRegistered && typeof sb.addListener === 'function') {
        try {
          await sb.addListener('output', (ev) => {
            try {
              if (!ev) return;
              // seq 去重：同一原生事件即便被多个 listener 投递，也只渲染一次
              const seq = typeof ev.seq === 'number' ? ev.seq : 0;
              if (seq) {
                if (seq <= _lastSandboxSeq) return;
                _lastSandboxSeq = seq;
              }
              if (ev.stream === 'progress') { updateBootProgress(ev.text); return; }
              // Agent 运行时把最新一行原生输出写进气泡，避免长时间空白等结果
              if (window.__agentBubble && (ev.stream === 'stdout' || ev.stream === 'output')) {
                const raw = String(ev.text || '').replace(/\s+$/, '');
                const hint = window.__agentBubble.querySelector && window.__agentBubble.querySelector('.typing-hint');
                if (hint && raw && !raw.startsWith('{') && !raw.startsWith('[state/')) {
                  hint.textContent = raw.length > 72 ? raw.slice(0, 72) + '…' : raw;
                }
                // 完整日志实时写进气泡下的可展开区，不依赖终端
                const logBox = window.__agentLogBox;
                if (logBox && raw) {
                  const line = document.createElement('div');
                  line.textContent = raw;
                  logBox.appendChild(line);
                  while (logBox.childNodes.length > 300) logBox.removeChild(logBox.firstChild);
                  logBox.scrollTop = logBox.scrollHeight;
                }
              }
              _streamTick++;
              const t = _activeStreamTerm || activeTerm;
              if (!t) {
                // 终端没开也要留住 Agent 日志，避免用户只看得到对话里一行
                if (ev.stream === 'stdout' || ev.stream === 'output') {
                  window.__agentLogBuf = window.__agentLogBuf || [];
                  window.__agentLogBuf.push(String(ev.text || '').replace(/\s+$/, ''));
                  if (window.__agentLogBuf.length > 400) window.__agentLogBuf.shift();
                }
                return;
              }
              if (Array.isArray(ev.runs)) { t.pushRuns(ev.stream, ev.runs, !!ev.fin); return; }
              t.pushStream(ev.stream, ev.text);
            } catch (_) {}
          });
        } catch (_) {}
        try {
          await sb.addListener('screen', (ev) => { try { renderScreen(ev); } catch (_) {} });
        } catch (_) {}
        try {
          await sb.addListener('progress', (ev) => {
            try {
              if (!ev) return;
              const t = _activeStreamTerm || activeTerm;
              if (!t || typeof t.progressRuns !== 'function') return;
              if (Array.isArray(ev.runs)) { t.progressRuns(ev.runs); return; }
              if (ev.text) t.progress(ev.text);
            } catch (_) {}
          });
        } catch (_) {}
        _sandboxListenerRegistered = true;
      }
      showBootProgress('正在准备运行环境（首次约 1-2 分钟）…');
      let res;
      try {
        res = await Promise.race([
          sb.init(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('初始化超时(120s)')), 120000))
        ]);
      } catch (e) {
        // 超时或原生抛错时要清掉进度条与初始化锁，否则会一直停在「正在准备运行环境」
        hideBootProgress();
        _sandboxInitPromise = null;
        toast('运行环境初始化失败：' + (e && e.message ? e.message : e) + '，可稍后重试', 'error', 5000);
        throw e;
      }
      if (res && res.initialized === false) {
        const err = res.error || '未知错误';
        hideBootProgress();
        if (activeTerm) {
          activeTerm.line('❌ 沙箱初始化失败：', 'term-err');
          String(err).split('\n').slice(0, 10).forEach(l => activeTerm.line(l, 'term-err'));
        }
        throw new Error('Termux 初始化失败');
      }
      // 用户一输入就装好 OpenClaw，不必等打开终端再解压
      let ocTip = null;
      try {
        if (typeof sb.agentStatus === 'function') {
          const st = await sb.agentStatus();
          if (!st || !st.installed) {
            showBootProgress('正在安装 OpenClaw 运行时…');
            ocTip = document.createElement('div');
            ocTip.className = 'oc-install-tip';
            ocTip.textContent = '正在安装 OpenClaw 运行时… 0%';
            document.body.appendChild(ocTip);
            window.__ocInstallTip = ocTip;
            if (typeof sb.agentInit === 'function') await sb.agentInit();
          }
          // 无论是否刚装完都重写一次配置：旧版写入过 schema 不接受的键（timezone），
          // 必须覆盖成合法 JSON，否则 OpenClaw 每次启动都报 config is invalid
          if (typeof sb.agentConfigure === 'function') {
            let m2 = '';
            try { m2 = localStorage.getItem('aichat-agent-model') || ''; } catch (_) {}
            // 旧版可能把 openclaw:agent 写进缓存，strip 后只剩 "agent"，智谱直接 401
            if (!/^zhipu:glm-/.test(m2)) {
              m2 = 'zhipu:glm-4-flash';
              try { localStorage.setItem('aichat-agent-model', m2); } catch (_) {}
            }
            await sb.agentConfigure({ provider: 'zhipu', model: m2 });
          }
        }
      } catch (_) {}
      hideBootProgress();
      if (ocTip) { try { ocTip.remove(); } catch (_) {} }
      window.__ocInstallTip = null;
      sandboxReady = true;
      setTimeout(hideBootProgress, 2000);
      sb.exec({ cmd: 'true', timeout: 5000 }).catch(() => {});
      return sb;
    })();
    _sandboxInitPromise.catch(() => { hideBootProgress(); _sandboxInitPromise = null; });
  }
  return _sandboxInitPromise;
}

// 创建终端面板（AI 执行后用户可输入命令），挂到气泡内
// 运行时异常回显到终端，避免静默失败（真机无 logcat 时唯一线索）
window.addEventListener('error', (e) => {
  try {
    if (!activeTerm) return;
    const msg = (e && e.message) || '未知错误';
    activeTerm.line('[JS 异常] ' + msg, 'term-err');
  } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    if (!activeTerm) return;
    const r = e && e.reason;
    activeTerm.line('[未处理的异步异常] ' + (r && r.message ? r.message : String(r)), 'term-err');
  } catch (_) {}
});

// 自建确认框：Capacitor WebView 未实现 WebChromeClient.onJsConfirm，
// window.confirm 会静默返回 false，所有二次确认必须走这里
function uiPrompt(message, placeholder = '', okText = '确定', cancelText = '取消') {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'ui-confirm-mask';
    mask.innerHTML = `
      <div class="ui-confirm-card">
        <div class="ui-confirm-msg"></div>
        <textarea class="ui-prompt-input" rows="4"></textarea>
        <div class="ui-confirm-actions">
          <button type="button" class="ui-confirm-btn cancel"></button>
          <button type="button" class="ui-confirm-btn ok"></button>
        </div>
      </div>`;
    mask.querySelector('.ui-confirm-msg').textContent = message;
    const ta = mask.querySelector('.ui-prompt-input');
    ta.placeholder = placeholder;
    const cancelBtn = mask.querySelector('.ui-confirm-btn.cancel');
    const okBtn = mask.querySelector('.ui-confirm-btn.ok');
    cancelBtn.textContent = cancelText;
    okBtn.textContent = okText;
    const done = (v) => { mask.remove(); resolve(v); };
    cancelBtn.onclick = () => done(null);
    okBtn.onclick = () => done(ta.value.trim() || null);
    mask.addEventListener('click', (e) => { if (e.target === mask) done(null); });
    document.body.appendChild(mask);
    setTimeout(() => ta.focus(), 50);
  });
}

function uiConfirm(message, okText = '确定', cancelText = '取消') {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'ui-confirm-mask';
    mask.innerHTML = `
      <div class="ui-confirm-card">
        <div class="ui-confirm-msg"></div>
        <div class="ui-confirm-actions">
          <button type="button" class="ui-confirm-btn cancel"></button>
          <button type="button" class="ui-confirm-btn ok"></button>
        </div>
      </div>`;
    mask.querySelector('.ui-confirm-msg').textContent = message;
    mask.querySelector('.ok').textContent = okText;
    mask.querySelector('.cancel').textContent = cancelText;
    const done = (v) => { mask.remove(); resolve(v); };
    mask.querySelector('.ok').onclick = () => done(true);
    mask.querySelector('.cancel').onclick = () => done(false);
    mask.onclick = (e) => { if (e.target === mask) done(false); };
    document.body.appendChild(mask);
  });
}

// 判断用户是否正在该容器内选择文本。选择期间不得改动 DOM 或滚动位置：
// Android WebView 在选择手柄跟随滚动时极易崩溃。
function hasSelectionIn(el) {
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const node = sel.anchorNode;
    if (!node) return false;
    return el.contains(node.nodeType === 1 ? node : node.parentNode);
  } catch (_) { return false; }
}

function createTermPanel(bubble, title, cwd = '') {
  const panel = document.createElement('div');
  panel.className = 'term-panel';
  const head = document.createElement('div');
  head.className = 'term-head';
  head.innerHTML = '<svg class="icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>' + escapeHtml(title);
  const body = document.createElement('div');
  panel.appendChild(head);
  panel.appendChild(body);
  bubble.appendChild(panel);

  // 行数上限：apt update 这类命令会产生上千行，无上限会让 WebView DOM 无限增长直至崩溃
  const MAX_LINES = 1200;
  const trim = () => {
    while (body.childNodes.length > MAX_LINES) body.removeChild(body.firstChild);
  };
  // apt/dpkg 在 tty 下用 \r 原地刷新进度（(Reading database ... 50%），
  // 逐行落地会刷成上百条，这里把它当作“活动行”就地更新，观感与 Termux 一致
  // apt 的进度段都以 "xxx... N%" 形态原地刷新，统一识别为活动行，
  // 否则 Reading package lists / Building dependency tree 会各刷成一屏
  const LIVE_PREFIX = /^((Reading database|Reading package lists|Building dependency tree|Reading state information|Building data structures|Processing triggers for)\s*\.\.\.|Progress: |Unpacking |Preparing to unpack )/;
  const term = {
    panel, cwd,
    busy: false,
    _liveEl: null,
    classify(txt, stream) {
      const t = txt || '';
      // dpkg/apt 的 warning 走 stderr，但语义是警告，必须黄色而非红色
      if (/^(dpkg: warning|dpkg-deb: warning|W:|warning:|Ign:)/i.test(t)) return 'term-warn';
      if (/^(dpkg: error|dpkg-deb: error|E:|error:|Errors were encountered|Unable to locate|Permission denied)/i.test(t)
          || /(bad interpreter|command not found|No such file or directory|returned an error code|Aborted|SIGSYS|Bad system call)/i.test(t)) return 'term-err';
      if (/^(Get:|Fetched|Selecting previously|Unpacking|Setting up|Preparing to unpack|Processing triggers|Configuring|Building|Creating config|Need to get|After this operation)/i.test(t)
          || /\d+%\)?$/.test(t) || /^Setting up /.test(t)) return 'term-ok';
      if (stream === 'stderr') return 'term-err';
      if (stream === 'system') return 'term-sys';
      return '';
    },
    write(text, cls, stream) {
      if (hasSelectionIn(body)) return;
      const raw = String(text == null ? '' : text);
      const parts = raw.split('\n');
      for (let i = 0; i < parts.length; i++) {
        const line = parts[i];
        if (line === '' && i === parts.length - 1) continue;
        const klass = cls || this.classify(line, stream || 'stdout');
        if (LIVE_PREFIX.test(line)) {
          if (!this._liveEl || !body.contains(this._liveEl)) {
            this._liveEl = document.createElement('div');
            this._liveEl.className = 'term-ok';
            body.appendChild(this._liveEl);
          }
          this._liveEl.textContent = line;
          this._liveEl.className = klass || 'term-ok';
        } else {
          this._liveEl = null;
          const d = document.createElement('div');
          if (klass) d.className = klass;
          d.textContent = line;
          body.appendChild(d);
        }
      }
      trim();
      panel.scrollTop = panel.scrollHeight;
    },
    line(text, cls) {
      if (hasSelectionIn(body)) return;
      this._liveEl = null;
      const d = document.createElement('div');
      const klass = cls || this.classify(text, 'system');
      if (klass) d.className = klass;
      d.textContent = text;
      body.appendChild(d);
      trim();
      panel.scrollTop = panel.scrollHeight;
    },
    cmd(c) { this.line('$ ' + c, 'term-cmd'); },
    pushStream(stream, text) {
      const cls = stream === 'system' ? 'term-sys' : '';
      // pty（script）输出会带 ANSI 控制序列与 \r，直接写进 DOM 会显示成乱码/残行
      const clean = String(text == null ? '' : text)
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b\][^\x07\n]*\x07/g, '')
        // ESC 可能被桥接层吃掉，只剩 "[0m[01;34m" 这类裸序列，需要兜底剥离
        .replace(/\[\d+(?:;\d+)*m/g, '')
        .replace(/\[[0-9;]*[JKH]/g, '')
        // readline 的括号粘贴模式标记（ESC 若已丢失会剩成 [?2004h）
        .replace(/\[?\??2004[hl]/g, '')
        // 兜底：ESC 全丢后可能残留裸 "[?" 前缀
        .replace(/\[\?\d*[hl]/g, '')
        // 其余 C0 控制字节（不含换行与 tab）一律丢弃，否则渲染成方块
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/\r/g, '');
      if (!clean) return;
      this.write(clean, cls, stream);
      if (/(\[Y\/n\]|\[y\/N\]|Do you want to continue|\u662f\u5426\u7ee7\u7eed)/i.test(clean) && typeof window.__termAskConfirm === 'function') {
        window.__termAskConfirm();
      }
    },
  };

  // 用户输入行
  const inputRow = document.createElement('div');
  inputRow.className = 'term-input-row';
  const prompt = document.createElement('span');
  prompt.className = 'term-input-prompt';
  prompt.textContent = '$';
  const input = document.createElement('input');
  input.className = 'term-input';
  input.type = 'text';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.placeholder = '输入命令，回车执行';
  inputRow.appendChild(prompt);
  inputRow.appendChild(input);
  panel.appendChild(inputRow);

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || term.busy) return;
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    term.busy = true;
    try {
      await sandboxRun(term, cmd, { cwd: term.cwd || '', timeout: 120000 });
    } catch (err) {
      term.line('执行失败：' + err.message, 'term-err');
    } finally {
      term.busy = false;
      input.disabled = false;
      input.focus();
      panel.scrollTop = panel.scrollHeight;
    }
  });

  term.focusInput = () => input.focus();
  activeTerm = term;
  return term;
}

// 在沙箱内执行命令并把过程写入终端（命令行由调用方负责显示）
/** apt/pkg install 前弹确认：返回 false 表示用户取消 */
async function confirmPkgInstall(cmd) {
  const m = /\b(?:apt-get|apt|pkg|dpkg)\s+(-[^\s]+\s+)*install\s+(-[^\s]+\s+)*([^\s;&|]+)/i.exec(cmd || '');
  if (!m) return true;
  const pkgs = m[3].replace(/\s+/g, ' ').trim();
  return await uiConfirm('即将安装软件包：' + pkgs + '\n确认执行安装？', '安装', '取消');
}

async function sandboxRun(term, cmd, opts = {}) {
  if (!opts.confirmed) {
    const ok = await confirmPkgInstall(cmd);
    if (!ok) { term.line('已取消安装', 'term-dim'); return { code: 130, stdout: '' }; }
  }
  const sb = await ensureSandbox();
  const tickBefore = _streamTick;
  _activeStreamTerm = term;
  let r;
  try {
    r = await sb.exec({ cmd, cwd: opts.cwd || '', timeout: opts.timeout || 60000, noAutoYes: !!opts.noAutoYes, interactive: !!opts.interactive });
  } finally {
    if (_activeStreamTerm === term) _activeStreamTerm = null;
  }
  // 正常情况输出已通过 output 监听器实时推送；
  // 仅当本次命令期间没有任何流事件到达（监听器不可用/被移除）时才用返回值兜底，避免重复打印
  if (_streamTick === tickBefore) {
    if (r.stdout) term.pushStream('stdout', r.stdout);
    if (r.stderr) term.pushStream('stderr', r.stderr);
  }
  if (r.timedOut) term.line('（已超时终止）', 'term-sys');
  if (r && r.error) term.line('错误: ' + r.error, 'term-err');
  return r;
}

// 写文件到沙箱
async function sandboxWrite(term, relPath, content) {
  const sb = await ensureSandbox();
  await sb.writeFile({ path: relPath, content });
  term.line('write ' + relPath, 'term-dim');
}


// ========== 模型数据与能力 ==========
let modelList = { free: [], paid: [] };
let paidEnabled = false;
const CAPS_SHORT = { image: '图', video: '视频', file: '文件', audio: '语音', think: '思考' };
const KIND_SHORT = { image_gen: '绘图', video_gen: '视频', tts: '配音' };

function modelMeta(id) {
  if (!id) return null;
  const all = [...(modelList.free || []), ...(modelList.paid || [])];
  return all.find(m => (typeof m === 'object' ? m.id === id : m === id)) || null;
}
function modelProviderOf(id) {
  const s = String(id || '');
  if (s.startsWith('zhipu:')) return 'zhipu';
  if (s.startsWith('agnes:')) return 'agnes';
  if (s.startsWith('or:')) return 'openrouter';
  return 'poixe';
}

// ====== 每个模型独立图标：按家族形状 + 名称哈希配色，避免所有模型一个样式 ======
const GLYPH_COLORS = [
  '#5b8cff', '#8b6cff', '#22d3ee', '#34d399', '#f59e0b',
  '#f472b6', '#60a5fa', '#a78bfa', '#2dd4bf', '#fbbf24',
  '#4ade80', '#c084fc', '#38bdf8', '#fb7185', '#a3e635',
];
function glyphHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
// 形状池：六边形 / 圆 / 圆角方 / 三角 / 菱形 / 闪电 / 四芒星 / 双环
function glyphPath(shape, size) {
  const s = size, c = s / 2;
  switch (shape) {
    case 0: { // 六边形
      const r = s * 0.5, r2 = s * 0.25;
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i - Math.PI / 6;
        pts.push(`${(c + r * Math.cos(a)).toFixed(1)},${(c + r * Math.sin(a)).toFixed(1)}`);
      }
      return `<polygon points="${pts.join(' ')}" fill="none" stroke="${r2 ? 'currentColor' : ''}" stroke-width="1.6"/>`;
    }
    case 1:
      return `<circle cx="${c}" cy="${c}" r="${s * 0.38}" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
    case 2:
      return `<rect x="${s * 0.16}" y="${s * 0.16}" width="${s * 0.68}" height="${s * 0.68}" rx="${s * 0.22}" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
    case 3:
      return `<polygon points="${c},${s * 0.14} ${s * 0.88},${s * 0.82} ${s * 0.12},${s * 0.82}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`;
    case 4:
      return `<polygon points="${c},${s * 0.12} ${s * 0.88},${c} ${c},${s * 0.88} ${s * 0.12},${c}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`;
    case 5: // 闪电
      return `<polygon points="${s * 0.56},${s * 0.1} ${s * 0.28},${s * 0.54} ${s * 0.46},${s * 0.54} ${s * 0.4},${s * 0.9} ${s * 0.72},${s * 0.44} ${s * 0.52},${s * 0.44}" fill="currentColor" stroke="none"/>`;
    case 6: // 四芒星
      return `<path d="M${c} ${s * 0.1} L${s * 0.62} ${s * 0.38} L${s * 0.9} ${c} L${s * 0.62} ${s * 0.62} L${c} ${s * 0.9} L${s * 0.38} ${s * 0.62} L${s * 0.1} ${c} L${s * 0.38} ${s * 0.38} Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`;
    default: // 双环
      return `<circle cx="${c}" cy="${c}" r="${s * 0.36}" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="${c}" cy="${c}" r="${s * 0.13}" fill="currentColor"/>`;
  }
}
function modelGlyph(id, size = 20) {
  const sid = String(id || '').replace(/:free$/i, '');
  const name = sid.split(':').pop();
  const h = glyphHash(name);
  const color = GLYPH_COLORS[h % GLYPH_COLORS.length];
  let shape;
  if (/glm-4\.6|glm-5/i.test(name)) shape = 0;
  else if (/thinking|reason/i.test(name)) shape = 6;
  else if (/flash|mini|fast|air|lite/i.test(name)) shape = 5;
  else if (/v4v|vl|vision|image/i.test(name)) shape = 1;
  else if (/code|coder/i.test(name)) shape = 2;
  else if (/audio|tts|voice/i.test(name)) shape = 7;
  else if (/video/i.test(name)) shape = 3;
  else if (/deepseek|qwen|llama|mistral|gemma/i.test(name)) shape = 4;
  else shape = h % 8;
  return `<span class="mglyph" style="color:${color};width:${size}px;height:${size}px">` +
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">${glyphPath(shape, size)}</svg>` +
    `</span>`;
}
// 兼容旧调用
function providerBadge(_provider, size = 18) { return modelGlyph(currentModel, size); }
function modelCaps(id) {
  const m = modelMeta(id);
  return (m && typeof m === 'object' && Array.isArray(m.caps)) ? m.caps : [];
}
function modelKind(id) {
  const m = modelMeta(id);
  return (m && typeof m === 'object' && m.kind) ? m.kind : 'chat';
}
function modelSupports(id, cap) { return modelCaps(id).includes(cap); }
function modelDisplayName(m) {
  if (typeof m === 'string') return m.replace(/:free$/i, '');
  if (m && m.name) return m.name;
  if (m && m.id) {
    let id = String(m.id);
    if (id.startsWith('zhipu:')) id = id.slice(6);
    else if (id.startsWith('poixe:')) id = id.slice(6);
    return id.replace(/:free$/i, '');
  }
  return '未知';
}

// ========== 自定义模型选择器（网站内选择，非浏览器原生下拉；智谱官网风格方形圆角） ==========
// 面板智能定位：fixed 精确定位，自动判断上下方向与可用高度，不截断不遮挡输入框
function fitPanel(panel, root) {
  // 记录原本的显隐：测量需要可见，但绝不能因此把已关闭的面板重新显示出来
  const wasHidden = panel.classList.contains('hidden');
  const r = root.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  // 先显示再测真实高度
  panel.classList.remove('hidden');
  panel.classList.remove('up');
  panel.style.position = 'fixed';
  panel.style.top = 'auto';
  panel.style.bottom = 'auto';
  panel.style.left = 'auto';
  panel.style.right = 'auto';
  panel.style.maxHeight = '';
  panel.style.width = '';
  const ph = panel.offsetHeight || 280;
  const pw = Math.min(panel.offsetWidth || 260, vw - 16);
  const gap = 6;
  const spaceBelow = vh - r.bottom;   // 按钮下方可用空间
  const spaceAbove = r.top;          // 按钮上方可用空间
  let top, maxH;
  if (spaceBelow >= ph + gap) {
    // 下方空间够：向下完整展开
    top = r.bottom + gap;
    maxH = ph;
  } else if (spaceAbove >= ph + gap) {
    // 上方空间够：向上完整展开
    top = r.top - gap - ph;
    maxH = ph;
  } else if (spaceBelow >= spaceAbove) {
    // 都不够：优先下方，压缩到可用高度
    maxH = Math.max(140, spaceBelow - 4);
    top = r.bottom + gap;
  } else {
    // 优先上方，压缩到可用高度
    maxH = Math.max(140, spaceAbove - 4);
    top = Math.max(4, r.top - gap - maxH);
  }
  // 水平对齐按钮左缘，不超出视口
  let left = r.left;
  if (left + pw > vw - 8) left = vw - pw - 8;
  if (left < 8) left = 8;
  panel.style.position = 'fixed';
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
  panel.style.maxHeight = maxH + 'px';
  if (pw !== panel.offsetWidth) panel.style.width = pw + 'px';
  if (wasHidden) panel.classList.add('hidden');
}
class ModelPicker {
  constructor(root, onPick) {
    this.root = root;
    this.onPick = onPick;
    this.view = 'main';                 // main | more | think | length
    this.root.classList.add('model-picker');
    this.root.innerHTML = `
      <button type="button" class="mp-btn" title="切换模型">
        <span class="mp-ico"></span>
        <span class="mp-name">加载中…</span>
        <svg class="icon mp-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="mp-panel hidden"></div>`;
    this.btn = this.root.querySelector('.mp-btn');
    this.panel = this.root.querySelector('.mp-panel');
    this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    // 面板内部一律 stopPropagation，外部点击才关闭；select 的原生弹层
    // 关闭时 target 是 select 本身，仍在 root 内，不会触发关闭
    document.addEventListener('click', (e) => {
      if (this.root.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.mp-agent-row')) return;
      this.close();
    });
    this.panel.addEventListener('change', async (e) => {
      const sel = e.target.closest('.agent-model-sel');
      if (!sel) return;
      e.stopPropagation();
      try {
        const sb = await ensureSandbox();
        await sb.agentConfigure({ provider: 'zhipu', model: sel.value });
        try { localStorage.setItem('aichat-agent-model', sel.value); } catch (_) {}
        const label = this.panel.querySelector('.agent-model-label');
        if (label) label.textContent = '执行模型：' + sel.value.replace(/^zhipu:/, '');
        toast('Agent 执行模型已切换为 ' + sel.value, 'success', 2200);
      } catch (err) {
        toast('切换失败：' + (err && err.message ? err.message : err), 'error', 3000);
      }
    });
    this.panel.addEventListener('click', (e) => {
      e.stopPropagation(); // 阻止冒泡到 document 的全局关闭，否则面板内点击会被立即关闭
      // 返回按钮
      const back = e.target.closest('.kimi-back');
      if (back) { this.view = 'main'; this.render(); return; }
      // 三档（v3.27.2：仅设置 Token 上限，不切换模型）
      const tier = e.target.closest('.tier');
      if (tier) {
        currentMaxTokens = parseInt(tier.dataset.tokens, 10) || 8192;
        try { localStorage.setItem('aichat-maxtok', String(currentMaxTokens)); } catch (_) {}
        this.close();
        return;
      }
      // 设置行
      const row = e.target.closest('.kimi-row');
      if (row) {
        const act = row.dataset.action;
        if (act === 'more') { this.view = 'more'; this.render(); }
        else if (act === 'think') { this.view = 'think'; this.render(); }
        else if (act === 'length') { this.view = 'length'; this.render(); }
        return;
      }
      // 思考/长度子选项
      const opt = e.target.closest('.kimi-opt');
      if (opt) {
        if (this.view === 'think') {
          deepMode = opt.dataset.value === 'on';
          try { localStorage.setItem('aichat-deep', deepMode ? '1' : '0'); } catch (_) {}
        } else if (this.view === 'length') {
          currentMaxTokens = parseInt(opt.dataset.value, 10) || 8192;
          try { localStorage.setItem('aichat-maxtok', String(currentMaxTokens)); } catch (_) {}
        }
        // 选完即收起：之前只回到主视图，面板一直悬在输入框下方
        this.view = 'main';
        this.close();
        return;
      }
      // OpenClaw 行内的模型下拉与设置按钮，不能当成选中模型
      if (e.target.closest('.agent-model-sel')) { e.stopPropagation(); return; }
      const resetBtn = e.target.closest('.agent-reset-btn');
      if (resetBtn) {
        e.stopPropagation();
        (async () => {
          const sb = await ensureSandbox();
          const ok = await uiConfirm('重置将删除 OpenClaw 运行时、配置与记忆，并重新解压约 600MB。继续？', '重置', '取消');
          if (!ok) return;
          try {
            if (typeof sb.agentReset === 'function') await sb.agentReset();
            sandboxReady = false; _sandboxInitPromise = null;
            await ensureSandbox();
            toast('OpenClaw 已重置并重新安装', 'success', 3000);
          } catch (err) {
            toast('重置失败：' + (err && err.message ? err.message : err), 'error', 4000);
          }
        })();
        return;
      }
      const cfgBtn = e.target.closest('.agent-cfg-btn');
      if (cfgBtn) {
        if (typeof window.__openOcSettings === 'function') window.__openOcSettings();
        this.close();
        return;
      }
      // 完整模型列表项
      const item = e.target.closest('.mp-item');
      if (!item || item.classList.contains('disabled')) return;
      this.onPick(item.dataset.id);
      this.close();
    });
  }
  toggle() { this.panel.classList.contains('hidden') ? this.open() : this.close(); }
  open() {
    closeSidebar();
    document.querySelectorAll('.model-picker .mp-panel').forEach(p => { if (p !== this.panel) p.classList.add('hidden'); });
    this.view = 'main';
    this.render();
    this.panel.classList.remove('hidden');
    fitPanel(this.panel, this.btn);
  }
  close() { this.panel.classList.add('hidden'); }

  // Kimi 三档：仅 Token 预设，不切换模型
  tierDefs() {
    return [
      { id: 'tier-pro', name: 'Pro', desc: '复杂任务与专业工作兼备，全能旗舰', tokens: 3000 },
      { id: 'tier-mid', name: '均衡', desc: '性能与效果均衡，轻松够用', tokens: 1500 },
      { id: 'tier-fast', name: '快速', desc: '快速对话，即时响应', tokens: 1000 },
    ];
  }
  thinkLabel() { return deepMode ? '进阶' : '关闭'; }
  lengthLabel() { return currentMaxTokens >= 16000 ? '长' : currentMaxTokens >= 6000 ? '标准' : '短'; }

  render() {
    // 每次切换视图都要重新测量定位：内容高度变了，沿用旧 maxHeight 会把列表尾部裁掉
    const done = () => { try { fitPanel(this.panel, this.btn); } catch (_) {} };
    if (this.view === 'more') { this.renderMore(); done(); return; }
    if (this.view === 'think') { this.renderThink(); done(); return; }
    if (this.view === 'length') { this.renderLength(); done(); return; }
    // ---- 主视图：三档 + 三行设置 ----
    const tiers = this.tierDefs();
    const curName = (modelMeta(currentModel) ? modelDisplayName(modelMeta(currentModel)) : currentModel);
    this.panel.innerHTML = `
      <div class="tier-list">
        ${tiers.map(t => `
          <div class="tier${currentMaxTokens === t.tokens ? ' current' : ''}" data-tokens="${t.tokens}">
            <div class="tier-name">${t.name}</div>
            <div class="tier-desc">${t.desc}</div>
          </div>`).join('')}
      </div>
      <div class="kimi-divider"></div>
      <div class="kimi-row" data-action="more">
        <span class="kimi-row-label">更多模型</span>
        <span class="kimi-row-val">${curName.length > 14 ? curName.slice(0, 14) + '…' : curName}
          <svg class="icon kimi-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg></span>
      </div>
      <div class="kimi-row" data-action="length">
        <span class="kimi-row-label">对话长度</span>
        <span class="kimi-row-val">${this.lengthLabel()}
          <svg class="icon kimi-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg></span>
      </div>`;
  }

  renderMore() {
    const { free, paid } = modelList;
    const groups = [];
    const pick = (arr, prefix) => (arr || []).filter(m => typeof m === 'object' && String(m.id).startsWith(prefix));
    const oc = (free || []).filter(m => typeof m === 'object' && String(m.id) === 'openclaw:agent');
    if (oc.length) groups.push({ label: '本地 Agent · OpenClaw', items: oc });
    const zhipu = pick(free, 'zhipu:');
    if (zhipu.length) groups.push({ label: '智谱 · GLM', items: zhipu });
    const poixe = pick(free, 'poixe:');
    if (poixe.length) groups.push({ label: 'Poixe · AI', items: poixe });
    const or = pick(free, 'or:');
    if (or.length) groups.push({ label: 'OpenRouter · 免费', items: or });
    const agnes = pick(free, 'agnes:');
    if (agnes.length) groups.push({ label: 'Agnes AI · 免费', items: agnes });
    // 付费模型此前整组缺失，导致 Agnes/付费尾部看不到 —— 这里按供应商完整补齐
    const pz = pick(paid, 'zhipu:');
    if (pz.length) groups.push({ label: '智谱 · 付费', items: pz });
    const pr = pick(paid, 'or:');
    if (pr.length) groups.push({ label: 'OpenRouter · 付费', items: pr });
    const pa = pick(paid, 'agnes:');
    if (pa.length) groups.push({ label: 'Agnes AI · 付费', items: pa });
    const rest = (paid || []).filter(m => {
      const id = typeof m === 'object' ? String(m.id) : String(m);
      return !/^(zhipu|or|agnes|poixe):/.test(id);
    });
    if (rest.length) groups.push({ label: '其他 · 付费', items: rest });
    this.panel.innerHTML = `
      <div class="kimi-head">
        <button type="button" class="kimi-back" aria-label="返回">
          <svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="kimi-head-title">更多模型</span>
      </div>
      <div class="mp-search">
        <svg class="icon mp-search-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="mp-search-input" placeholder="搜索模型…" autocomplete="off" spellcheck="false">
      </div>
      <div class="mp-list">
        ${groups.map(g => `
        <div class="mp-group">
          <div class="mp-group-title">${g.label}</div>
          ${g.items.map(m => this.itemHTML(m, false)).join('')}
        </div>`).join('')}
      </div>`;
    const input = this.panel.querySelector('.mp-search-input');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('input', () => {
      const kw = input.value.trim().toLowerCase();
      this.panel.querySelectorAll('.mp-group').forEach(g => {
        let visible = 0;
        g.querySelectorAll('.mp-item').forEach(item => {
          const name = (item.querySelector('.mp-item-name')?.textContent || '').toLowerCase();
          const hit = !kw || name.includes(kw);
          item.style.display = hit ? '' : 'none';
          if (hit) visible++;
        });
        g.style.display = visible ? '' : 'none';
      });
    });
  }

  renderThink() {
    const opts = [
      { v: 'off', label: '关闭', desc: '不启用思考，响应更快' },
      { v: 'on', label: '进阶', desc: '先推理再回答，适合复杂问题' },
    ];
    this.panel.innerHTML = `
      <div class="kimi-head">
        <button type="button" class="kimi-back" aria-label="返回">
          <svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="kimi-head-title">思考等级</span>
      </div>
      ${opts.map(o => `
        <div class="kimi-opt${(deepMode ? 'on' : 'off') === o.v ? ' current' : ''}" data-value="${o.v}">
          <div>
            <div class="kimi-opt-name">${o.label}</div>
            <div class="kimi-opt-desc">${o.desc}</div>
          </div>
          ${(deepMode ? 'on' : 'off') === o.v ? '<svg class="icon kimi-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </div>`).join('')}`;
  }

  renderLength() {
    const opts = [
      { v: '2048', label: '短', desc: '约 1500 字，适合简单问答' },
      { v: '8192', label: '标准', desc: '约 6000 字，日常对话' },
      { v: '16384', label: '长', desc: '约 12000 字，长文/项目生成' },
    ];
    this.panel.innerHTML = `
      <div class="kimi-head">
        <button type="button" class="kimi-back" aria-label="返回">
          <svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="kimi-head-title">对话长度</span>
      </div>
      ${opts.map(o => `
        <div class="kimi-opt${String(currentMaxTokens) === o.v ? ' current' : ''}" data-value="${o.v}">
          <div>
            <div class="kimi-opt-name">${o.label}</div>
            <div class="kimi-opt-desc">${o.desc}</div>
          </div>
          ${String(currentMaxTokens) === o.v ? '<svg class="icon kimi-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </div>`).join('')}`;
  }

  itemHTML(m, wholeDisabled) {
    const isObj = typeof m === 'object';
    const id = isObj ? m.id : m;
    const disabled = wholeDisabled || (isObj && m.enabled === false);
    const prov = modelProviderOf(id);
    const note = isObj && m.note ? m.note : (disabled ? '不可用' : '');
    // 保留模型能力小徽章（图/视频/文件/语音/思考）
    const caps = (isObj && Array.isArray(m.caps)) ? m.caps : modelCaps(id);
    const kind = (isObj && m.kind) || 'chat';
    const capsBadges = caps.map(c => `<em class="mp-cap" data-cap="${c}">${CAPS_SHORT[c] || c}</em>`).join('')
      + (kind !== 'chat' ? `<em class="mp-cap mp-kind" data-kind="${kind}">${KIND_SHORT[kind] || kind}</em>` : '');
    const isCurrent = id === currentModel;
    let savedAgentModel = '';
    try { savedAgentModel = localStorage.getItem('aichat-agent-model') || ''; } catch (_) {}
    if (!/^zhipu:glm-/.test(savedAgentModel)) savedAgentModel = 'zhipu:glm-4-flash';
    const agentRow = id === 'openclaw:agent' ? `<div class="mp-agent-row">
      <select class="agent-model-sel" title="Agent 执行时使用的模型">${LOCAL_MODELS
        .filter(x => x.kind === 'chat' && x.enabled !== false && String(x.id).startsWith('zhipu:'))
        .map(x => `<option value="${x.id}"${x.id === savedAgentModel ? ' selected' : ''}>${x.name}</option>`).join('')}</select>
      <button type="button" class="agent-cfg-btn agent-reset-btn" title="重置 OpenClaw 运行时">重置</button>
      <button type="button" class="agent-cfg-btn" title="OpenClaw 设置（模型 / 记忆 / 工作区）">设置</button>
    </div>` : '';
    return `<div class="mp-item${disabled ? ' disabled' : ''}${isCurrent ? ' current' : ''}${id === 'openclaw:agent' ? ' mp-agent-item' : ''}" data-id="${id}">
      ${modelGlyph(id, 20)}
      <span class="mp-item-name">${modelDisplayName(m)}</span>
      ${capsBadges}
      <span class="mp-item-note">${note}</span>
      ${isCurrent ? '<svg class="icon mp-check" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
      ${agentRow}
    </div>`;
  }
  refresh() {
    const m = modelMeta(currentModel);
    this.btn.querySelector('.mp-ico').innerHTML = modelGlyph(currentModel, 18);
    this.btn.querySelector('.mp-name').textContent = m ? modelDisplayName(m) : '选择模型';
  }
}

const pickerSide = new ModelPicker($('model-picker-side'), setModel);
const pickerTool = new ModelPicker($('model-picker-tool'), setModel);
function setModel(id) {
  currentModel = id;
  pickerSide.refresh();
  pickerTool.refresh();
  if (typeof nodePicker !== 'undefined') nodePicker.refresh();
  updateAttachAvailability();
  updateDeepAvailability();
}

// ========== 网站内嵌提示（替代浏览器原生 alert / prompt / confirm） ==========
function toast(message, type = 'info', duration = 2600) {
  const wrap = $('toast-wrap');
  const el = document.createElement('div');
  const ico = type === 'error' ? svgIcon('x', 14) : type === 'success' ? svgIcon('sparkles', 14) : svgIcon('search', 14);
  el.className = 'toast toast-' + type;
  el.innerHTML = `<span class="toast-ico">${ico}</span><span class="toast-text">${escapeHtml(message)}</span>`;
  wrap.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 320);
  }, duration);
}

let appModalState = null;
function openAppModal({ title, message = '', input = false, defaultValue = '', okText = '确 定', cancelText = '取 消', onOk, onCancel }) {
  $('am-title').textContent = title;
  $('am-msg').textContent = message;
  const inp = $('am-input');
  inp.classList.toggle('hidden', !input);
  if (input) { inp.value = defaultValue || ''; inp.placeholder = message; }
  $('am-error').textContent = '';
  $('am-ok').textContent = okText;
  $('am-cancel').textContent = cancelText;
  appModalState = { onOk, onCancel, input };
  $('app-modal').classList.remove('hidden');
  if (input) setTimeout(() => inp.focus(), 60);
}
function closeAppModal() {
  $('app-modal').classList.add('hidden');
  appModalState = null;
}
$('am-ok').onclick = () => {
  if (!appModalState) return;
  if (appModalState.input) {
    const keepOpen = appModalState.onOk ? appModalState.onOk($('am-input').value.trim()) : undefined;
    if (keepOpen === false) return; // 校验失败保持打开
  } else {
    if (appModalState.onOk) appModalState.onOk();
  }
  closeAppModal();
};
$('am-cancel').onclick = () => {
  if (!appModalState) return;
  if (appModalState.onCancel) appModalState.onCancel();
  closeAppModal();
};
$('app-modal').onclick = (e) => { if (e.target === $('app-modal')) closeAppModal(); };
$('am-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('am-ok').click(); } });

// ========== 通用请求（顶部细进度条；短请求不闪烁，后台请求一律 silent） ==========
let _loadingCount = 0;
let _loadingTimer = null;
function showGlobalLoading() {
  _loadingCount++;
  // 延迟 350ms 才显示：localStorage/缓存级的快请求完全不出现动画
  if (_loadingTimer || _loadingCount > 1) return;
  _loadingTimer = setTimeout(() => {
    _loadingTimer = null;
    if (_loadingCount <= 0) return;
    let el = document.getElementById('global-loading-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'global-loading-overlay';
      el.innerHTML = '<div class="gld-bar"></div>';
      document.body.appendChild(el);
    }
    el.style.display = 'block';
  }, 350);
}
function hideGlobalLoading() {
  _loadingCount = Math.max(0, _loadingCount - 1);
  if (_loadingCount === 0) {
    if (_loadingTimer) { clearTimeout(_loadingTimer); _loadingTimer = null; }
    const el = document.getElementById('global-loading-overlay');
    if (el) el.style.display = 'none';
  }
}
async function api(path, opts = {}) {
  const silent = opts.silent;
  if (!silent) showGlobalLoading();
  try {
    const full = (API_BASE && !/^https?:\/\//.test(path)) ? API_BASE + path : path;
    const headers = { 'Content-Type': 'application/json' };
    const t = authToken();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    if (opts.headers) Object.assign(headers, opts.headers);
    const res = await fetch(full, { credentials: 'include', ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 搜索这类旁路请求 401 不应把用户踢下线
      if (res.status === 401 && !opts.keepAuth) setAuth(null);
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    if (!silent) hideGlobalLoading();
  }
}

// ========== 登录/注册 ==========
let authMode = 'login';
let codeCountdown = null; // 发送验证码倒计时定时器
function startCodeCountdown(btn, seconds) {
  const orig = btn.dataset.origText || btn.textContent;
  if (!btn.dataset.origText) btn.dataset.origText = orig;
  btn.disabled = true;
  let left = seconds;
  btn.textContent = left + 's';
  clearInterval(codeCountdown);
  codeCountdown = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(codeCountdown);
      btn.disabled = false;
      btn.textContent = btn.dataset.origText;
    } else {
      btn.textContent = left + 's';
    }
  }, 1000);
}
async function sendMailCode(btn, emailInput, purpose) {
  const email = String(emailInput.value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast(purpose === 'register' ? '请先填写有效邮箱，再发送验证码' : '请先填写已绑定的有效邮箱', 'error');
    emailInput.focus();
    return;
  }
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '发送中…';
  try {
    const r = await api('/api/send-code', { method: 'POST', body: JSON.stringify({ email, purpose }) });
    if (r.dev) {
      // 后端未配置 SMTP：直接回填验证码，避免用户拿不到码以为发送失败
      if (r.code) {
        const codeInput = document.getElementById('auth-code');
        if (codeInput) codeInput.value = String(r.code);
        toast('验证码已填入（当前环境未配置邮件服务）', 'info');
      } else {
        toast('验证码已生成，请查看服务端日志', 'info');
      }
      console.warn('[dev-code] 服务端返回开发模式验证码');
    } else {
      toast('验证码已发送至 ' + email + '，请查收邮箱', 'success');
    }
    startCodeCountdown(btn, 60);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

/* ============ 密码框显示/隐藏眼睛按钮（登录密码、注册密码、确认密码自动生效） ============ */
const EYE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
document.querySelectorAll('#auth-screen input[type="password"]').forEach(inp => {
  if (inp.closest('.pwd-wrap')) return;
  const wrap = document.createElement('div');
  wrap.className = 'pwd-wrap';
  if (inp.classList.contains('hidden')) wrap.classList.add('hidden'); // 同步隐藏态（如登录时的"确认密码"）
  inp.parentNode.insertBefore(wrap, inp);
  wrap.appendChild(inp);
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'pwd-eye';
  eye.setAttribute('aria-label', '显示或隐藏密码');
  eye.tabIndex = -1;
  eye.innerHTML = EYE_OFF_SVG;
  eye.onclick = (e) => {
    e.preventDefault();
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    eye.classList.toggle('on', show);
    eye.innerHTML = show ? EYE_SVG : EYE_OFF_SVG;
  };
  wrap.appendChild(eye);
});

function renderAuthTabs(mode) {
  authMode = mode || 'login';
  document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === authMode));
  const reg = authMode === 'register';
  $('auth-email').classList.toggle('hidden', !reg);
  $('auth-email-hint').classList.toggle('hidden', !reg);
  const pwd2 = $('auth-password2');
  pwd2.classList.toggle('hidden', !reg);
  if (pwd2.closest('.pwd-wrap')) pwd2.closest('.pwd-wrap').classList.toggle('hidden', !reg);
  $('auth-pwd-hint').classList.toggle('hidden', !reg);
  $('reg-code-row').classList.toggle('hidden', !reg);
  $('mail-login').classList.toggle('hidden', reg);
  $('auth-submit').textContent = reg ? '注 册' : '登 录';
  $('auth-error').textContent = '';
  if (!reg) { $('auth-email-hint').textContent = ''; $('auth-pwd-hint').textContent = ''; }
}
document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.onclick = () => renderAuthTabs(btn.dataset.mode);
});
renderAuthTabs('login');

/* 邮箱格式实时校验提示 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmailField() {
  const v = $('auth-email').value.trim();
  const hint = $('auth-email-hint');
  if (!v) { hint.textContent = ''; hint.classList.remove('ok'); return false; }
  if (!EMAIL_RE.test(v)) { hint.textContent = '邮箱格式不正确，例如 name@example.com'; hint.classList.remove('ok'); return false; }
  hint.textContent = '✓ 邮箱格式正确'; hint.classList.add('ok'); return true;
}
$('auth-email').addEventListener('input', validateEmailField);
$('auth-email').addEventListener('blur', validateEmailField);

/* 确认密码实时校验 */
function validatePwdField() {
  const p1 = $('auth-password').value;
  const p2 = $('auth-password2').value;
  const hint = $('auth-pwd-hint');
  if (!p2) { hint.textContent = ''; hint.classList.remove('ok'); return true; }
  if (p1 !== p2) { hint.textContent = '两次输入的密码不一致'; hint.classList.remove('ok'); return false; }
  hint.textContent = '✓ 两次密码一致'; hint.classList.add('ok'); return true;
}
$('auth-password').addEventListener('input', validatePwdField);
$('auth-password2').addEventListener('input', validatePwdField);

$('btn-send-code').onclick = () => {
  // 发送验证码前先校验邮箱格式
  if (!validateEmailField()) { $('auth-error').textContent = '请先输入正确格式的邮箱再发送验证码'; return; }
  sendMailCode($('btn-send-code'), $('auth-email'), authMode === 'login' ? 'login' : 'register');
};
$('btn-send-login-code').onclick = () => sendMailCode($('btn-send-login-code'), $('mail-login-email'), 'login');

$('btn-mail-login').onclick = async () => {
  $('auth-error').textContent = '';
  const email = $('mail-login-email').value.trim();
  const code = $('mail-login-code').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('auth-error').textContent = '请输入有效邮箱'; return; }
  if (!/^\d{6}$/.test(code)) { $('auth-error').textContent = '请输入 6 位邮箱验证码'; return; }
  try {
    const user = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, code }) });
    saveAuthFromUser(user);
    await afterLogin(user);
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
};

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const ident = $('auth-username').value.trim();
  const body = {
    // 登录支持用户名或邮箱；注册时 username 为登录用户名，另传 email
    username: ident,
    email: authMode === 'register' ? $('auth-email').value.trim() : (ident.includes('@') ? ident : ''),
    password: $('auth-password').value,
  };
  if (authMode === 'register') {
    if (!ident || ident.length < 3) { $('auth-error').textContent = '用户名至少 3 个字符'; return; }
    if (!validateEmailField()) { $('auth-error').textContent = '请填写有效邮箱（注册必须绑定邮箱）'; return; }
    if (!validatePwdField()) { $('auth-error').textContent = '两次输入的密码不一致'; return; }
    const cd = $('auth-code').value.trim();
    if (!/^\d{6}$/.test(cd)) {
      $('auth-error').textContent = '请输入 6 位邮箱验证码（先点击“发送验证码”）';
      return;
    }
    body.code = cd;
  }
  try {
    const user = await api('/api/' + authMode, { method: 'POST', body: JSON.stringify(body) });
    saveAuthFromUser(user);
    await afterLogin(user);
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
};

// 登录成功 → 保存 token 与用户信息，下次启动自动登录
function saveAuthFromUser(user) {
  const token = user && user.token ? user.token : '';
  setAuth({
    token,
    user: user ? { id: user.id, username: user.username, nickname: user.nickname, email: user.email } : null,
    ts: Date.now(),
  });
}

// ========== 登录后初始化 ==========
async function afterLogin(user) {
  currentUser = user;
  // currentUser 变化后刷新浮动终端入口（未登录/游客不显示）
  try { window.dispatchEvent(new Event('aichat:auth-changed')); } catch (_) {}
  const isGuest = !!user.guest;               // 游客 / 本地模式
  const isLocal = !!user.local;               // 后端不可达时的纯本地模式
  authScreen.classList.add('hidden');
  app.classList.remove('hidden');
  $('user-nickname').textContent = user.nickname;
  $('user-username').textContent = isLocal ? '本地模式 · 未连接后端'
    : (isGuest ? '游客模式 · 未登录账号' : '@' + user.username);
  $('user-avatar').textContent = (user.nickname || user.username || '?').slice(0, 1).toUpperCase();
  $('user-email').textContent = isLocal ? '数据仅保存在本设备'
    : (isGuest ? '登录后可同步账号' : (user.email ? user.email : '未绑定邮箱'));
  $('btn-login').classList.toggle('hidden', !(isGuest && !isLocal));
  $('btn-bind-email').classList.toggle('hidden', isGuest || isLocal);
  $('btn-edit-profile').classList.toggle('hidden', isGuest || isLocal);
  $('btn-logout').classList.toggle('hidden', isGuest || isLocal);
  $('btn-bind-email').innerHTML = svgIcon(user.email ? 'edit' : 'link', 12) + ' ' + (user.email ? '修改邮箱' : '绑定邮箱');
  await loadModels();
  // 从本地存储恢复对话历史（三份备份校验）
  try { if (window.localCore) await window.localCore.verifyAndRestore(); } catch (_) {}
  await loadConversations();
  await loadNodes();
  renderSkills();
  refreshWebToggleUI();
  refreshSpendDisplay();
  refreshAuthLine();
}

// 菜单显示今日额度（v3.27.3：完全从后端 /api/me 获取，不本地计算）
async function refreshSpendDisplay() {
  const line = $('spend-line');
  if (!line) return;
  try {
    const me = await api('/api/me', { silent: true });
    deactivating = !!me.deactivating;
    const spent = (me.spend && me.spent != null) ? Number(me.spent) : 0;
    const limit = Number(me.dailyLimit || 1);
    const pct = Math.min(100, Math.round(spent / limit * 100));
    line.classList.remove('hidden');
    line.innerHTML =
      `<div class="spend-head">` +
        `<span class="spend-ico">${svgIcon('wallet', 12)}</span>` +
        `<span class="spend-label">今日额度</span>` +
        `<b>¥${spent.toFixed(2)} / ¥${limit.toFixed(2)}</b>` +
      `</div>` +
      `<div class="spend-bar"><div class="spend-fill" style="width:${pct}%"></div></div>`;
  } catch (_) { line.classList.add('hidden'); }
}

// ========== 节点（网站内自定义选择器；智谱模型时禁用 poixe 节点） ==========
let nodes = [];
class NodePicker {
  constructor(root) {
    this.root = root;
    this.root.classList.add('node-picker');
    this.root.innerHTML = `
      <button type="button" class="np-btn" title="切换接入节点">
        <span class="np-name">节点…</span>
        <svg class="icon np-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="np-panel hidden"></div>`;
    this.btn = this.root.querySelector('.np-btn');
    this.panel = this.root.querySelector('.np-panel');
    this.btn.addEventListener('click', (e) => { e.stopPropagation(); if (this.root.classList.contains('disabled')) return; this.toggle(); });
    document.addEventListener('click', () => this.close());
    this.panel.addEventListener('click', (e) => {
      const item = e.target.closest('.np-item');
      if (!item || item.classList.contains('disabled')) return;
      currentNode = Number(item.dataset.id);
      this.render();
      this.close();
      this.refresh();
    });
  }
  toggle() { this.panel.classList.contains('hidden') ? this.open() : this.close(); }
  open() { this.render(); this.panel.classList.remove('hidden'); fitPanel(this.panel, this.btn); }
  close() { this.panel.classList.add('hidden'); }
  render() {
    const isZhipu = modelProviderOf(currentModel) === 'zhipu';
    this.panel.innerHTML = (nodes || []).map(n => {
      const disabled = isZhipu; // 智谱模型直连智谱 API，无需 poixe 节点
      const cur = Number(n.id) === currentNode;
      return `<div class="np-item${disabled ? ' disabled' : ''}${cur ? ' current' : ''}" data-id="${n.id}">
        <span class="np-name">${n.name}</span>
        ${cur ? '<svg class="icon np-check" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
      </div>`;
    }).join('') || '<div class="np-empty">无可用节点</div>';
  }
  refresh() {
    const isZhipu = modelProviderOf(currentModel) === 'zhipu';
    const n = (nodes || []).find(x => Number(x.id) === currentNode);
    this.btn.querySelector('.np-name').textContent = isZhipu ? '智谱直连' : (n ? n.name : '节点');
    this.root.classList.toggle('disabled', isZhipu);
    this.btn.title = isZhipu ? '智谱模型直接连接智谱 API，无需 poixe 节点' : '切换接入节点';
  }
}
const nodePicker = new NodePicker($('node-picker'));
async function loadNodes() {
  // 纯本地直连模式：无后端节点概念，隐藏节点选择器
  nodes = [];
  currentNode = 0;
  if (nodePicker && nodePicker.root) nodePicker.root.style.display = 'none';
}

// ========== 技能按钮渲染 ==========
function renderSkills() {
  const bar = $('skill-bar');
  bar.innerHTML = '';
  SKILLS.forEach((s, idx) => {
    const btn = document.createElement('button');
    btn.className = 'skill-chip';
    btn.innerHTML = `<span class="skill-icon">${svgIcon(s.icon, 14)}</span><span>${s.label}</span>`;
    btn.onclick = () => openSkill(idx);
    bar.appendChild(btn);
  });
}

// ========== 技能表单（动态字段） ==========
let activeSkill = null;

// 网站内自定义下拉（方形圆角，不用浏览器原生 select 提示）
function buildSkillSelect(f) {
  const wrap = document.createElement('div');
  wrap.className = 'skill-select-box';
  wrap.dataset.key = f.key;
  wrap.dataset.value = f.default || (f.options && f.options[0]) || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ss-btn';
  btn.innerHTML = `<span class="ss-btn-text">${wrap.dataset.value}</span><svg class="icon ss-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
  const panel = document.createElement('div');
  panel.className = 'ss-panel hidden';
  const syncCurrent = () => {
    panel.querySelectorAll('.ss-item').forEach(i => i.classList.toggle('current', i.textContent === wrap.dataset.value));
    btn.querySelector('.ss-btn-text').textContent = wrap.dataset.value;
  };
  (f.options || []).forEach(opt => {
    const it = document.createElement('div');
    it.className = 'ss-item' + (opt === wrap.dataset.value ? ' current' : '');
    it.textContent = opt;
    it.onclick = (e) => { e.stopPropagation(); wrap.dataset.value = opt; syncCurrent(); panel.classList.add('hidden'); };
    panel.appendChild(it);
  });
  btn.onclick = (e) => { e.stopPropagation(); panel.classList.toggle('hidden'); syncCurrent(); };
  document.addEventListener('click', () => panel.classList.add('hidden'));
  wrap.appendChild(btn);
  wrap.appendChild(panel);
  return wrap;
}
function openSkill(idx) {
  const s = SKILLS[idx];
  activeSkill = s;
  $('skill-form-title').innerHTML = `<span class="skill-icon">${svgIcon(s.icon, 15)}</span> ${s.label}`;
  const body = $('skill-form-body');
  body.innerHTML = '';

  if (!s.fields || s.fields.length === 0) {
    // 自由任务：一个 textarea + 提示
    body.innerHTML = `
      <div class="skill-field">
        <textarea id="sf-_free" class="skill-textarea" placeholder="输入任何任务描述，AI 将直接处理…" rows="3"></textarea>
      </div>`;
    setTimeout(() => $('sf-_free').focus(), 30);
  } else {
    s.fields.forEach(f => {
      const wrap = document.createElement('div');
      wrap.className = 'skill-field';
      const lbl = document.createElement('label');
      lbl.className = 'skill-label';
      lbl.textContent = f.label + (f.required ? ' *' : '');
      wrap.appendChild(lbl);

      if (f.multi) {
        // 多值字段：输入框 + 加号按钮，可动态添加多个输入框
        const list = document.createElement('div');
        list.className = 'multi-list';
        list.dataset.key = f.key;
        const addRow = (val) => {
          const row = document.createElement('div');
          row.className = 'multi-row';
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'skill-input multi-input';
          inp.dataset.key = f.key;
          inp.placeholder = f.placeholder || '';
          inp.value = val || '';
          const addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'multi-add';
          addBtn.title = '添加一项';
          addBtn.innerHTML = svgIcon('plus', 14);
          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'multi-remove';
          rmBtn.title = '删除这一项';
          rmBtn.innerHTML = svgIcon('x', 12);
          addBtn.onclick = () => { addRow(''); const inputs = list.querySelectorAll('.multi-input'); inputs[inputs.length - 1].focus(); };
          rmBtn.onclick = () => { row.remove(); syncRemoveBtns(); };
          // 多值输入框内按 Enter 添加新行，不触发整体发送
          inp.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); addRow(''); const inputs = list.querySelectorAll('.multi-input'); inputs[inputs.length - 1].focus(); }
          });
          row.appendChild(inp);
          row.appendChild(addBtn);
          row.appendChild(rmBtn);
          list.appendChild(row);
        };
        const syncRemoveBtns = () => {
          const rows = list.querySelectorAll('.multi-row');
          rows.forEach(r => r.querySelector('.multi-remove').classList.toggle('hidden', rows.length <= 1));
        };
        addRow('');
        syncRemoveBtns();
        wrap.appendChild(list);
        body.appendChild(wrap);
        return;
      }

      let ctrl;
      if (f.type === 'select') {
        // 自定义下拉（网站内选项框，不用浏览器原生提示）
        ctrl = buildSkillSelect(f);
      } else if (f.type === 'textarea') {
        ctrl = document.createElement('textarea');
        ctrl.className = 'skill-textarea';
        ctrl.dataset.key = f.key;
        ctrl.placeholder = f.placeholder || '';
        ctrl.rows = 3;
      } else {
        ctrl = document.createElement('input');
        ctrl.type = 'text';
        ctrl.className = 'skill-input';
        ctrl.dataset.key = f.key;
        ctrl.placeholder = f.placeholder || '';
        if (f.default) ctrl.value = f.default;
      }
      wrap.appendChild(ctrl);
      body.appendChild(wrap);
    });
    // 自动聚焦第一个必填或第一个字段
    setTimeout(() => {
      const first = body.querySelector('input, textarea, select');
      if (first) first.focus();
    }, 30);
  }

  // 显示表单行，隐藏普通输入行
  $('skill-form-row').classList.remove('hidden');
  $('input-row').classList.add('hidden');
  hideWelcome();
}
function closeSkill() {
  activeSkill = null;
  $('skill-form-row').classList.add('hidden');
  $('input-row').classList.remove('hidden');
  $('skill-form-body').innerHTML = '';
  $('input').focus();
}
function collectSkillValues() {
  if (!activeSkill) return {};
  if (!activeSkill.fields || activeSkill.fields.length === 0) {
    const v = ($('sf-_free').value || '').trim();
    if (!v) { $('sf-_free').focus(); return null; }
    return { _free: v };
  }
  const out = {};
  for (const f of activeSkill.fields) {
    if (f.multi) {
      // 多值字段：收集所有输入框的值，用顿号连接
      const els = $('skill-form-body').querySelectorAll('.multi-list[data-key="' + f.key + '"] .multi-input');
      const vals = [...els].map(el => (el.value || '').trim()).filter(Boolean);
      if (f.required && !vals.length) { const first = els[0]; if (first) first.focus(); return null; }
      out[f.key] = vals.join('、');
      continue;
    }
    const el = $('skill-form-body').querySelector('[data-key="' + f.key + '"]');
    let v = '';
    if (el) {
      // 自定义下拉：值存在 dataset.value；普通输入框取 value
      v = el.dataset.value !== undefined ? el.dataset.value : ((el.value || '') + '').trim();
    }
    if (!v && f.default) v = f.default;
    if (f.required && !v) { if (el) el.focus(); return null; }
    out[f.key] = v;
  }
  return out;
}
function sendSkill() {
  if (!activeSkill) return;
  const vals = collectSkillValues();
  if (!vals) return;
  let text;
  if (vals._free !== undefined) {
    text = activeSkill.buildPrompt(vals._free);
  } else {
    text = activeSkill.buildPrompt(vals);
  }
  if (!text || !text.trim()) return;
  const isProject = !!activeSkill.project;
  closeSkill();
  addMessage('user', text);
  doChat(text, false, { project: isProject });
}
$('skill-close').onclick = closeSkill;
$('btn-skill-send').onclick = sendSkill;

// 自由任务里按 Enter=发送（不换行）；表单里按 Enter 直接提交（多值输入框除外，Enter=新增一行）
$('skill-form-body').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const t = e.target;
    if (t.classList && t.classList.contains('multi-input')) return; // 多值输入框由自身处理
    e.preventDefault();
    sendSkill();
  }
});

// ========== 欢迎语 ==========
function hideWelcome() {
  const w = $('welcome');
  if (w) w.remove();
}

// ========== 模型 ==========
async function loadModels() {
  try {
    const data = localModelList();   // 本地内置模型清单，无需后端
    modelList = { free: data.free || [], paid: data.paid || [] };
    paidEnabled = !!data.paidEnabled;
    pickerSide.render();
    pickerTool.render();
    const firstFree = modelList.free.find(m => (typeof m === 'object' ? m.enabled !== false : true));
    if (firstFree && !currentModel) setModel(firstFree.id);
    setEndpoint(ZHIPU_BASE, true);
  } catch (e) { console.warn('加载模型失败', e); }
}
function setEndpoint(url, ok) {
  const dot = $('endpoint-dot');
  const txt = $('endpoint-text');
  if (!url) { txt.textContent = '未知'; return; }
  const short = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  dot.classList.toggle('down', !ok);
  txt.textContent = short;
  txt.title = ok ? '当前使用：' + url : '连接失败：' + url;
}

// ========== 会话列表 ==========
async function loadConversations() {
  const box = $('conv-list');
  box.innerHTML = '';
  localState.conversations.slice().reverse().forEach(c => {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === currentConvId ? ' active' : '');
    item.innerHTML = `<span class="title"></span><button class="del" title="删除">✕</button>`;
    item.querySelector('.title').textContent = c.title;
    item.onclick = () => { openConversation(c.id); closeSidebar(); };
    item.querySelector('.del').onclick = (e) => {
      e.stopPropagation();
      openAppModal({
        title: '删除会话',
        message: '确定要删除「' + c.title + '」吗？该操作不可恢复。',
        okText: '删 除',
        onOk: async () => {
          deleteConversation(c.id);
          await persistState();
          if (currentConvId === c.id) {
            currentConvId = null;
            $('messages').innerHTML = '';
            $('chat-title').textContent = '开始新对话';
          }
          loadConversations();
          toast('会话已删除', 'success');
        },
      });
    };
    box.appendChild(item);
  });
}

async function openConversation(id) {
  const conv = findConversation(id);
  if (!conv) return;
  currentConvId = id;
  $('chat-title').textContent = conv.title;
  if (conv.model) { currentModel = conv.model; setModel(conv.model); }
  const box = $('messages');
  box.innerHTML = '';
  (conv.messages || []).forEach((m, i) => {
    const { text: mText, attachList } = splitMessageContent(m.content);
    const { wrap, bubble } = addMessage(m.role, mText, undefined, attachList);
    if (m.role === 'assistant') finalizeAIMessage(wrap, bubble);
    else attachUserEdit(wrap, bubble, i);
  });
  loadConversations();
}

$('btn-new-chat').onclick = () => {
  // 游客限制：已达 3 个对话则前端拦截并提示登录解锁
  if (currentUser && currentUser.guest) {
    const convCount = document.querySelectorAll('#conv-list .conv-item').length;
    if (convCount >= 3) {
      toast(`游客模式最多创建 3 个对话，登录后解锁全部功能`, 'error', 3600);
      setTimeout(openLoginModal, 500);
      return;
    }
  }
  currentConvId = null;
  const box = $('messages');
  box.innerHTML = `
    <div class="welcome" id="welcome">
      <div class="welcome-logo">${svgIcon('sparkles', 48)}</div>
      <h1>你好，我是 AI 助手</h1>
      <p>有什么可以帮你的？选择下方技能，或直接输入问题开始对话。</p>
    </div>`;
  $('chat-title').textContent = '新的对话';
  document.querySelectorAll('.conv-item').forEach(i => i.classList.remove('active'));
  closeSidebar();
};
$('btn-new-topic').onclick = () => $('btn-new-chat').click();

// 从代码块围栏标注/代码内容里提取 AI 指定的文件名
function extractCodeFilename(lang, infostring, src) {
  const whole = String(infostring || '').trim();
  // 1) 围栏标注里 lang 之后的文件名，如 ```python:app.py、```html index.html
  const rest = whole.slice(lang ? whole.indexOf(lang) + lang.length : 0).trim();
  let m = rest.match(/([\w.\-]+\.[A-Za-z0-9]{1,12})/);
  if (m) return m[1];
  // 2) 代码前几行注释里的文件名：# filename: app.py / // file: xxx.js / <!-- xxx.html -->
  const head = String(src || '').split('\n').slice(0, 4).join('\n');
  m = head.match(/(?:filename|file|文件名|name)\s*[:：=]\s*[`'"]?([\w./\-]+\.[A-Za-z0-9]{1,12})/i);
  if (m) return m[1].split('/').pop();
  // 3) 常见约定：首行就是 `// app.js`、`# app.py`、`<!-- index.html -->`
  m = head.match(/^\s*(?:\/\/|#|<!--)\s*([\w.\-]+\.[A-Za-z0-9]{1,12})\s*(?:-->)?\s*$/m);
  if (m) return m[1];
  return '';
}

if (window.marked) {
  marked.setOptions({ breaks: true, gfm: true });
  marked.use({
    renderer: {
      code(code, infostring) {
        const isToken = typeof code === 'object' && code !== null;
        const src = isToken ? (code.text || code.raw || '') : code;
        const rawLang = String(isToken ? (code.lang || '') : (infostring || '')).trim();
        let lang = (rawLang.match(/^([\w+-]*)/) || ['', ''])[1];
        lang = lang || '';
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        let html = esc(src || '');
        const isAuto = /^auto?bash$/i.test(lang);
        let detected = isAuto ? 'bash' : lang;
        if (window.hljs) {
          try {
            if (lang && hljs.getLanguage(lang)) {
              html = hljs.highlight(src, { language: lang }).value;
            } else {
              // 未标注语言：自动识别代码语言
              const r = hljs.highlightAuto(src);
              html = r.value;
              if (!lang && r.language) detected = r.language;
            }
          } catch (_) { html = esc(src || ''); }
        }
        const label = detected || 'text';
        const filename = extractCodeFilename(lang, rawLang, src);
        const isHtml = /html|xml/.test(detected) || /^\s*<(?:!doctype|html|head|body|div|script|style|h[1-6]|p\b|table\b)/i.test(src);
        const actions =
          `<button type="button" class="code-act" data-act="copy" title="复制代码">${svgIcon('copy', 13)} 复制</button>` +
          `<button type="button" class="code-act" data-act="download" title="下载${filename ? '（' + filename + '）' : ''}">${svgIcon('download', 13)} 下载</button>` +
          (isHtml ? `<button type="button" class="code-act" data-act="preview" title="悬浮预览 HTML">${svgIcon('code', 13)} 预览</button>` : '');
        return `<div class="code-block${isAuto ? ' code-autobash' : ''}" data-filename="${esc(filename)}">` +
          `<div class="code-head"><span class="code-lang">${isAuto ? '自动执行' : esc(label)}${filename ? ' · ' + esc(filename) : ''}</span><span class="code-actions">${actions}</span></div>` +
          `<pre><code class="hljs language-${esc(label)}">${html}</code></pre>` +
          `</div>`;
      }
    }
  });
}

// 悬浮 HTML 预览浮层（不内嵌在代码块下方）
// files: 项目所有文件 [{path, content}]，用于把外部 CSS/JS 内联进 HTML
function openHtmlPreview(codeText, filename, files) {
  // 把同项目的 CSS/JS 内联进 HTML
  let html = codeText;
  if (Array.isArray(files) && files.length) {
    const fmap = {};
    for (const f of files) fmap[f.path.split('/').pop()] = f.content;
    // <link rel="stylesheet" href="xxx.css"> → <style>...</style>
    html = html.replace(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/gi, (m, href) => {
      const name = href.split('/').pop();
      const css = fmap[name];
      return css ? `<style>\n${css}\n</style>` : m;
    });
    // <script src="xxx.js"></script> → <script>...</script>
    html = html.replace(/<script[^>]+src=["']([^"']+\.js)["'][^>]*>\s*<\/script>/gi, (m, src) => {
      const name = src.split('/').pop();
      const js = fmap[name];
      return js ? `<script>\n${js}\n</script>` : m;
    });
  }
  // 关闭已有
  document.querySelector('.preview-modal')?.remove();
  const ov = document.createElement('div');
  ov.className = 'preview-modal';
  const title = filename || 'HTML 预览';
  ov.innerHTML = `
    <div class="preview-win">
      <div class="preview-bar">
        <span class="preview-ico">${svgIcon('globe', 14)}</span>
        <span class="preview-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        <button type="button" class="preview-opennew" title="在新标签页打开">${svgIcon('link', 13)} 新窗口</button>
        <button type="button" class="preview-x" title="关闭预览">${svgIcon('x', 18)}</button>
      </div>
      <div class="preview-body">
        <div class="preview-loading"><span class="typing-dots"><i></i><i></i><i></i></span></div>
        <iframe sandbox="allow-scripts allow-modals allow-forms allow-popups allow-same-origin" allow="camera; microphone; geolocation"></iframe>
      </div>
    </div>`;
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  const iframe = ov.querySelector('iframe');
  let loaded = false;
  iframe.onload = () => {
    loaded = true;
    iframe.classList.add('loaded');
    const ld = ov.querySelector('.preview-loading');
    if (ld) ld.classList.add('hidden');
  };
  // Capacitor WebView 对 srcdoc 支持不好，直接用 blob URL
  try {
    const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    ov._blobUrl = blobUrl;
    iframe.src = blobUrl;
  } catch (_) {
    iframe.srcdoc = html;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
  const close = () => {
    ov.classList.remove('show');
    document.body.style.overflow = '';
    setTimeout(() => { ov.remove(); if (ov._blobUrl) URL.revokeObjectURL(ov._blobUrl); }, 200);
  };
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.preview-x')) close();
  });
  ov.querySelector('.preview-opennew').onclick = () => {
    const win = window.open('', '_blank');
    if (win) { win.document.open(); win.document.write(codeText); win.document.close(); }
  };
  ov._esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', ov._esc);
}

// 代码操作：复制 / 下载（文件名与 AI 生成一致）/ HTML 悬浮预览
async function handleCodeAction(btn) {
  const block = btn.closest('.code-block');
  if (!block) return;
  const codeEl = block.querySelector('pre code');
  const codeText = codeEl ? codeEl.textContent : '';
  const act = btn.dataset.act;
  if (act === 'copy') {
    copyText(codeText).then(ok => {
      if (ok) {
        const prev = btn.innerHTML;
        btn.innerHTML = '✓ 已复制';
        setTimeout(() => { btn.innerHTML = prev; }, 1200);
      } else {
        toast('复制失败，请手动选择代码复制', 'error');
      }
    });
  } else if (act === 'download') {
    // 优先使用 AI 在围栏标注/代码里指定的文件名；没有则按语言扩展名兜底
    const extMap = { javascript: 'js', typescript: 'ts', python: 'py', html: 'html', css: 'css', json: 'json', sql: 'sql', bash: 'sh', shell: 'sh', xml: 'xml', markdown: 'md', java: 'java', c: 'c', 'c++': 'cpp', cpp: 'cpp', go: 'go', rust: 'rs', ruby: 'rb', php: 'php', yaml: 'yml' };
    let fname = (block.dataset.filename || '').trim();
    if (!fname) {
      const lang = ((block.querySelector('.code-lang') || {}).textContent || 'txt').split('·')[0].trim();
      fname = 'code.' + (extMap[lang] || lang || 'txt');
    }
    const blob = new Blob([codeText], { type: 'text/plain;charset=utf-8' });
    // APK 环境：用 Capacitor Filesystem 保存
    if (IS_NATIVE && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
      try {
        const FS = window.Capacitor.Plugins.Filesystem;
        const arr = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
        await FS.writeFile({ path: fname, data: btoa(bin), directory: FS.Directory.Data, recursive: true });
        toast('已保存：' + fname, 'success', 2500);
        return;
      } catch (_) {}
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } else if (act === 'preview') {
    openHtmlPreview(codeText, (block.dataset.filename || '').trim(), window._lastProjectFiles || null);
  }
}
// ============ 执行/展示标记 → 代码块 ============
// 关键点：标记块先替换成 HTML 注释占位，完全不进入 Markdown 解析，
// 否则 --auto-bash-- 会被部分渲染器当删除线，且块结构会被打散导致自动执行匹配不到。
const BH_OPEN = '(?:\\/--auto-bash--\\/|--auto-bash--|~~auto-bash~~)';
const BH_CLOSE = '(?:\\/--ending-bash--\\/|--ending-bash--|~~ending-bash~~)';
const BH_ALL = new RegExp(BH_OPEN + '|' + BH_CLOSE, 'g');

function bashBlockHtml(code, isAuto) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const src = String(code).trim();
  let body = esc(src);
  if (window.hljs) {
    try { body = hljs.highlight(src, { language: 'bash' }).value; } catch (_) {}
  }
  return '<div class="code-block' + (isAuto ? ' code-autobash' : '') + '" data-autobash="' + (isAuto ? '1' : '0') + '">'
    + '<div class="code-head"><span class="code-lang">' + (isAuto ? '自动执行' : 'bash') + '</span>'
    + '<span class="code-actions">'
    + (IS_NATIVE ? '<button type="button" class="code-act code-run" data-act="run" title="在终端执行">' + svgIcon('play', 13) + ' 执行</button>' : '')
    + '<button type="button" class="code-act" data-act="copy" title="复制代码">'
    + svgIcon('copy', 13) + ' 复制</button></span></div>'
    + '<pre><code class="hljs language-bash">' + body + '</code></pre></div>';
}

function carveBashBlocks(text) {
  let t = String(text || '');
  const blocks = [];
  const hold = (code, isAuto) => {
    blocks.push({ code, isAuto });
    return '\n\n<!--BH' + (blocks.length - 1) + '-->\n\n';
  };
  // 1) 标记独占一行的标准写法
  const blockRe = new RegExp('^[ \\t]*' + BH_OPEN + '[ \\t]*\r?\n([\\s\\S]*?)\r?\n[ \\t]*' + BH_CLOSE + '[ \\t]*$', 'gm');
  t = t.replace(blockRe, (m, code) => hold(code, true));
  // 2) 标记与命令贴在一起、或夹在正文里的写法
  const inlineRe = new RegExp(BH_OPEN + '([\\s\\S]*?)' + BH_CLOSE, 'g');
  t = t.replace(inlineRe, (m, code) => hold(code, true));
  // 3) 只展示不执行
  t = t.replace(/<bash>\s*([\s\S]*?)\s*<\/bash>/gi, (m, code) => hold(code, false));
  // 4) 流式未闭合时的残标记：直接抹掉，避免泄漏成正文
  t = t.replace(BH_ALL, '');
  return { text: t, blocks };
}

// 多模态 content（数组）拆成可渲染文本 + 缩略图附件列表
function splitMessageContent(content) {
  if (!Array.isArray(content)) return { text: String(content == null ? '' : content), attachList: undefined };
  const texts = [];
  const attachList = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text') { const t = String(p.text || ''); if (t) texts.push(t); }
    else if (p.type === 'image_url') {
      const url = (p.image_url && p.image_url.url) || '';
      attachList.push({ type: 'image', name: '图片', data: url, kind: 'history' });
    } else if (p.type === 'file') attachList.push({ type: 'file', name: '文件', data: '' });
  }
  return { text: texts.join('\n'), attachList: attachList.length ? attachList : undefined };
}

function renderMarkdown(text) {
  const src = typeof text === 'string' ? text : formatUserContent(text);
  const carved = carveBashBlocks(src);
  let html = '';
  if (window.marked) {
    try { html = marked.parse(carved.text); } catch (_) {}
  }
  if (!html) {
    html = carved.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  }
  // 占位符可能被包进段落，先处理带 <p> 的情况，再处理裸占位
  const fill = (m, i) => {
    const b = carved.blocks[+i];
    return b ? bashBlockHtml(b.code, b.isAuto) : '';
  };
  html = html.replace(/<p>\s*<!--BH(\d+)-->\s*<\/p>/g, fill);
  html = html.replace(/<!--BH(\d+)-->/g, fill);
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}

// 从字符流缓冲中提取 <think>...</think> 推理内容（标签可能被流式拆包）
function splitThink(buf) {
  const open = buf.indexOf('<think>');
  if (open === -1) return { clean: buf, think: '' };
  const close = buf.indexOf('</think>', open);
  if (close === -1) {
    // 未闭合：<think> 之前是正文，之后暂存为思考内容（持续增长）
    return { clean: buf.slice(0, open), think: buf.slice(open + 7), rest: '' };
  }
  const inner = buf.slice(open + 7, close);
  const after = buf.slice(close + 8);
  const sub = splitThink(after); // 可能后面还有多段 think
  return { clean: buf.slice(0, open) + sub.clean, think: inner + sub.think };
}
// 多模态用户消息（服务端以 JSON 数组存储）→ 可读占位文本
function formatUserContent(text) {
  if (Array.isArray(text)) {
    return text.map(p => {
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'text') return String(p.text || '');
      if (p.type === 'image_url') return '【图片】';
      if (p.type === 'video_url') return '【视频】';
      if (p.type === 'input_audio') return '【语音】';
      if (p.type === 'file') return '【文件】';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof text !== 'string') return String(text || '');
  const t = text.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) {
        const parts = arr.map(p => {
          if (p && p.type === 'image_url') return '【图片】';
          if (p && p.type === 'video_url') return '【视频】';
          if (p && p.type === 'input_audio') return '【语音】';
          if (p && p.type === 'file') return '【文件】' + (p.file && p.file.file_url ? ' ' + p.file.file_url : '');
          if (p && p.type === 'text') return p.text;
          return '';
        }).filter(Boolean);
        return parts.join('\n');
      }
    } catch (_) {}
  }
  return text;
}
// 本地消息就地编辑：只改本机记录并重发，不依赖服务端"修改消息"接口
function attachUserEdit(wrap, bubble, idx) {
  if (!bubble || bubble.dataset.editBound) return;
  bubble.dataset.editBound = '1';
  bubble.classList.add('msg-editable');
  bubble.addEventListener('click', async (e) => {
    if (e.target.closest('a') || e.target.closest('img')) return;
    if (streaming) { toast('正在生成回复，稍后再改', 'info', 1800); return; }
    const conv = currentConvId ? findConversation(currentConvId) : null;
    if (!conv || !conv.messages || !conv.messages[idx]) return;
    const m = conv.messages[idx];
    if (m.role !== 'user') return;
    const cur = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content)
          ? m.content.filter(x => x && x.type === 'text').map(x => x.text || '').join(' ')
          : '');
    const next = await uiPrompt('修改这条消息（只改本机记录，随后重新生成回复）', cur);
    if (next == null) return;
    const trimmed = String(next).trim();
    if (!trimmed || trimmed === cur) return;
    conv.messages = conv.messages.slice(0, idx);   // 丢弃该条及之后，按新内容重发
    try { await persistState(); } catch (_) {}
    await openConversation(currentConvId);
    input.value = trimmed;
    input.style.height = 'auto';
    sendMessage();
  });
}

function bindLastUserEdit() {
  const conv = currentConvId ? findConversation(currentConvId) : null;
  if (!conv || !conv.messages) return;
  const idx = conv.messages.length - 1;
  const wraps = document.querySelectorAll('#messages .msg.user');
  const last = wraps[wraps.length - 1];
  if (last) attachUserEdit(last, last.querySelector('.msg-bubble'), idx);
}

function addMessage(role, text, msgId, attachList) {
  const box = $('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  if (msgId) wrap.dataset.id = msgId;
  const avatar = document.createElement('div');
  avatar.className = 'avatar ' + (role === 'user' ? 'avatar-user' : 'avatar-ai');
  avatar.textContent = role === 'user' ? '我' : 'AI';
  const body = document.createElement('div');
  body.className = 'msg-body';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (role === 'user') {
    // 附件网格（照片缩略图 / 文件类型徽章）
    if (attachList && attachList.length) {
      const grid = document.createElement('div');
      grid.className = 'msg-attach';
      grid.innerHTML = attachList.map(a => {
        const isImg = a.type === 'image' && typeof a.data === 'string' && a.data.startsWith('data:');
        if (isImg) return `<img class="msg-attach-img" src="${a.data}" data-zoom alt="${escapeHtml(a.name)}">`;
        return `<span class="msg-attach-file">${fileBadgeHTML(a.name, a.type)}<span class="msg-attach-fname">${escapeHtml(a.name)}</span></span>`;
      }).join('');
      grid.querySelectorAll('img[data-zoom]').forEach(im => { im.onclick = () => openImagePreview(im.src); });
      bubble.appendChild(grid);
    }
    const t = document.createElement('span');
    t.textContent = formatUserContent(text);
    if (t.textContent) bubble.appendChild(t);
  } else {
    bubble.innerHTML = renderMarkdown(text);
  }
  body.appendChild(bubble);
  wrap.appendChild(avatar); wrap.appendChild(body);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return { wrap, bubble, body };
}

// ========== 点击用户消息即可修改 ==========
function startEditUserMessage(wrap) {
  const id = wrap.dataset.id;
  const bubble = wrap.querySelector('.msg-bubble');
  if (!bubble || !id) { toast('这条消息尚未保存到服务器，暂时无法修改', 'error'); return; }
  const orig = bubble.textContent;
  bubble.classList.add('editing');
  bubble.innerHTML = `
    <div class="edit-box">
      <textarea class="edit-area" placeholder="修改这条消息…"></textarea>
      <div class="edit-actions">
        <button type="button" class="edit-save">保存</button>
        <button type="button" class="edit-cancel">取消</button>
      </div>
    </div>`;
  const area = bubble.querySelector('.edit-area');
  area.value = orig;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  const save = async () => {
    const content = area.value.trim();
    if (!content) return;
    try {
      // 纯本地模式：直接更新本地对话里的这条用户消息
      const conv = findConversation(currentConvId);
      if (conv) {
        const m = conv.messages.find(x => x.role === 'user' && x.content === orig);
        if (m) m.content = content;
        await persistState();
      }
      bubble.classList.remove('editing');
      bubble.textContent = content;
      wrap.dataset.editing = '';
    } catch (err) {
      toast('修改失败：' + err.message, 'error');
    }
  };
  bubble.querySelector('.edit-save').onclick = save;
  bubble.querySelector('.edit-cancel').onclick = () => {
    bubble.classList.remove('editing');
    bubble.textContent = orig;
    wrap.dataset.editing = '';
  };
  area.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); }
  });
}

function finalizeAIMessage(wrap, bubble) {
  const body = wrap.querySelector('.msg-body');
  if (body.querySelector('.msg-actions')) return;
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  bar.innerHTML = `
    <button class="act-btn" data-act="copy" title="复制">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>
    <button class="act-btn" data-act="speak" title="朗读">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
    </button>
    <button class="act-btn" data-act="retry" title="重新生成">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    </button>
  `;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.act-btn');
    if (!btn) return;
    const act = btn.dataset.act;
    const content = bubble.textContent || '';
    if (act === 'copy') {
      copyText(content).then(ok => {
        if (ok) {
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1200);
        }
      });
    } else if (act === 'speak') {
      if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(content);
      u.lang = 'zh-CN';
      window.speechSynthesis.speak(u);
    } else if (act === 'retry') {
      retryLastAI(wrap);
    }
  });
  body.appendChild(bar);

  // 自动执行：渲染阶段已把 /--auto-bash--/ 块转成 .code-autobash，这里按块逐个执行
  if (IS_NATIVE && autoExec && !bubble.dataset.markerExecDone) {
    const textEl = bubble.querySelector('.msg-text');
    const blocks = textEl ? Array.from(textEl.querySelectorAll('.code-autobash')) : [];
    if (blocks.length) {
      bubble.dataset.markerExecDone = '1';
      blocks.forEach((block) => {
        if (block.dataset.execDone) return;
        block.dataset.execDone = '1';
        const cmd = (block.querySelector('pre code')?.textContent || '').trim();
        if (!cmd) return;

        const resultEl = document.createElement('div');
        resultEl.className = 'auto-exec-result';
        resultEl.innerHTML = '<span class="ae-run">▶ 自动执行：</span><span class="ae-wait">运行中…</span>'
          + '<button class="kill-cmd-btn" type="button">停止</button>';
        block.appendChild(resultEl);

        (async () => {
          try {
            const sb = await getSandbox();
            if (!sb) { resultEl.innerHTML = '<span class="ae-err">沙箱不可用</span>'; return; }
            await sb.init();
            const killBtn = resultEl.querySelector('.kill-cmd-btn');
            if (killBtn) killBtn.onclick = () => {
              sb.kill && sb.kill();
              resultEl.innerHTML = '<span class="ae-err">▶ 已手动停止</span>';
            };
            const r = await sb.exec({ cmd, timeout: 300000 });
            const out = ((r.stdout || '') + (r.stderr || '')).trim();
            resultEl.innerHTML = '<span class="ae-ok">▶ 执行完成</span>'
              + '<pre class="ae-out">' + escapeHtml(out.slice(0, 3000) || '（无输出）') + '</pre>';
          } catch (e) {
            resultEl.innerHTML = '<span class="ae-err">▶ 执行失败：' + escapeHtml(e.message || '') + '</span>';
          }
        })();
      });
    }
  }
}

// ========== 联网三态开关 ==========
function refreshWebToggleUI() {
  const el = $('auto-web-toggle');
  if (!el) return;
  el.classList.remove('mode-auto', 'mode-on', 'mode-off');
  el.classList.add('mode-' + webMode);
  if (webMode === 'auto') {
    el.innerHTML = svgIcon('search', 13) + ' 自动联网';
    el.title = '当前：自动（让 AI 决定是否联网）\n点击切到「强制联网」';
  } else if (webMode === 'on') {
    el.innerHTML = svgIcon('globe', 13) + ' 强制联网';
    el.title = '当前：强制联网（每次都会先搜索再回答）\n点击切到「关闭联网」';
  } else {
    el.innerHTML = svgIcon('ban', 13) + ' 关闭联网';
    el.title = '当前：完全关闭联网（不调用搜索）\n点击切回「自动」';
  }
}
function cycleWebMode() {
  webMode = { auto: 'on', on: 'off', off: 'auto' }[webMode];
  refreshWebToggleUI();
  // 触发即时反馈提示
  const el = $('auto-web-toggle');
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 350);
}

// ========== 附件系统（多模态：图片/视频/文件/语音，仅智谱模型） ==========
let attachments = []; // { type:'image'|'video'|'file'|'audio', name, data, format, kind }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// ============ 附件：按文件类型显示彩色图标 / 照片缩略图 ============
function fileExtOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)(?:\.tar)?$/i);
  return m ? m[1].toLowerCase() : '';
}
// 形状类图标（图片/视频/音频/压缩包）：返回内部 SVG（白色描边）
const FILE_SHAPES = {
  image: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.7"/><path d="M21 15l-5-5L5 21"/>',
  video: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M10.5 9.2v5.6l4.5-2.8z" fill="currentColor" stroke="none"/>',
  audio: '<path d="M9 18V5l11-2v11"/><circle cx="6" cy="18" r="2.6"/><circle cx="17" cy="14" r="2.6"/>',
  archive: '<path d="M14 2.5H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2.5 14 8 20 8"/><path d="M12 10.5v4" stroke-dasharray="1.4 1.6"/><circle cx="12" cy="16.8" r="0.4" fill="currentColor" stroke="none"/>'
};
// 扩展名 → 类别
const FILE_EXT_CATEGORY = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', heic: 'image', heif: 'image', avif: 'image', ico: 'image',
  mp4: 'video', mov: 'video', webm: 'video', avi: 'video', mkv: 'video', flv: 'video', m4v: 'video', '3gp': 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', flac: 'audio', wma: 'audio', opus: 'audio',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive',
  pdf: 'pdf',
  doc: 'word', docx: 'word',
  xls: 'excel', xlsx: 'excel', csv: 'excel',
  ppt: 'ppt', pptx: 'ppt',
  md: 'md', markdown: 'md',
  htm: 'html', html: 'html',
  css: 'css',
  py: 'python', pyw: 'python',
  c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  js: 'js', mjs: 'js', jsx: 'js',
  ts: 'ts', tsx: 'ts',
  java: 'java', kt: 'java',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  json: 'json', xml: 'xml', yaml: 'yml', yml: 'yml', sql: 'sql',
  txt: 'text', log: 'text',
  vue: 'vue'
};
// 类别配色
const FILE_CAT_COLOR = {
  image: '#10b981', video: '#8b5cf6', audio: '#f59e0b', archive: '#78716c',
  pdf: '#e53935', word: '#2b6cb0', excel: '#2e9e44', ppt: '#e8651b',
  md: '#475569', html: '#e34f26', css: '#1572b6',
  python: '#3776ab', cpp: '#00599c', js: '#b8860b', ts: '#3178c6',
  java: '#e76f00', go: '#0a98b5', rust: '#c85014', ruby: '#cc342d', php: '#7a6fc0', swift: '#e14d3b',
  sh: '#3f9a3a', json: '#c97a00', xml: '#8a8f98', yml: '#8a4baf', sql: '#d97706',
  text: '#64748b', file: '#94a3b8'
};
// 文字类徽章上显示的缩写
const FILE_CAT_LABEL = {
  pdf: 'PDF', word: 'DOC', excel: 'XLS', ppt: 'PPT', md: 'MD', html: 'HTML', css: 'CSS',
  python: 'PY', cpp: 'C++', js: 'JS', ts: 'TS', java: 'JAVA', go: 'GO', rust: 'RS',
  ruby: 'RB', php: 'PHP', swift: 'SW', sh: 'SH', json: 'JSON', xml: 'XML', yml: 'YML',
  sql: 'SQL', text: 'TXT'
};
function fileCategory(name, type) {
  // 优先按附件 type（image/video/audio），其次按扩展名
  if (type === 'image' || type === 'video' || type === 'audio') {
    // 但压缩包/其他不能误判；image/video/audio 直接采信
    const ext = fileExtOf(name);
    if (type === 'image' && FILE_EXT_CATEGORY[ext] && FILE_EXT_CATEGORY[ext] !== 'image') return FILE_EXT_CATEGORY[ext];
    if (type === 'video' && FILE_EXT_CATEGORY[ext] && FILE_EXT_CATEGORY[ext] !== 'video') return FILE_EXT_CATEGORY[ext];
    if (type === 'audio' && FILE_EXT_CATEGORY[ext] && FILE_EXT_CATEGORY[ext] !== 'audio') return FILE_EXT_CATEGORY[ext];
    return type;
  }
  const ext = fileExtOf(name);
  return FILE_EXT_CATEGORY[ext] || 'file';
}
// 生成文件类型彩色徽章（形状图标或文字缩写）
function fileBadgeHTML(name, type) {
  const cat = fileCategory(name, type);
  const color = FILE_CAT_COLOR[cat] || FILE_CAT_COLOR.file;
  if (FILE_SHAPES[cat]) {
    return `<span class="fi" style="background:${color}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${FILE_SHAPES[cat]}</svg></span>`;
  }
  let label = FILE_CAT_LABEL[cat];
  if (!label) {
    const ext = fileExtOf(name);
    label = ext ? ext.toUpperCase().slice(0, 4) : '?';
  }
  const small = label.length >= 3 ? ' fi-sm' : '';
  return `<span class="fi fi-text${small}" style="background:${color}">${label}</span>`;
}
function attachIcon(type) {
  // 已被 fileBadgeHTML 取代，保留空壳避免外部旧引用报错
  return svgIcon('link', 13);
}
function updateAttachAvailability() {
  const isZhipu = modelProviderOf(currentModel) === 'zhipu';
  const caps = modelCaps(currentModel);
  const anyMulti = ['image', 'video', 'file', 'audio'].some(c => caps.includes(c));
  const btn = $('btn-attach');
  btn.classList.toggle('disabled', !(isZhipu && anyMulti));
  btn.title = (isZhipu && anyMulti) ? '添加图片/视频/文件/语音' : '附件仅智谱多模态模型可用（如 GLM-5.3-Flash）';
  $('attach-panel').querySelectorAll('button[data-kind]').forEach(b => {
    const k = b.dataset.kind;
    const need = { image: 'image', camera: 'image', doc: 'file', audio: 'audio' }[k] || null;
    const disabled = need ? !caps.includes(need) : !(caps.includes('image') || caps.includes('video') || caps.includes('file'));
    b.classList.toggle('disabled', disabled);
  });
}
function readAsAttachment(file, kind) {
  // 先放一个"上传中"占位，显示读取进度
  const placeholder = { uploading: true, type: kind, name: file.name, progress: 0 };
  attachments.push(placeholder);
  const idx = attachments.length - 1;
  renderAttachChips();
  const updateChip = () => {
    const chip = document.querySelector(`.attach-chip[data-idx="${idx}"]`);
    if (!chip) return;
    const bar = chip.querySelector('.chip-progress-bar');
    const pct = chip.querySelector('.chip-progress-pct');
    if (bar) bar.style.width = placeholder.progress + '%';
    if (pct) pct.textContent = placeholder.progress + '%';
  };
  const reader = new FileReader();
  reader.onprogress = (e) => {
    if (e.lengthComputable) {
      placeholder.progress = Math.min(99, Math.round(e.loaded / e.total * 100));
      updateChip();
    }
  };
  reader.onload = () => {
    let data = reader.result;
    let format = '';
    if (kind === 'audio') {
      // input_audio 需要裸 base64 + format（wav/mp3/…）
      format = ((file.name.match(/\.(\w+)$/) || [])[1] || 'wav').toLowerCase();
      data = data.split(',')[1];
    }
    // 图片：个别情况浏览器把 MIME 识别成 application/octet-stream，按扩展名修正，保证缩略图可显示
    if (kind === 'image' && typeof data === 'string' && data.indexOf('data:image') !== 0) {
      const ext = ((file.name.match(/\.(\w+)$/) || [])[1] || 'jpeg').toLowerCase();
      const IMG_MIME = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', svg: 'svg+xml', bmp: 'bmp', heic: 'heic', heif: 'heif', avif: 'avif', ico: 'x-icon' };
      data = 'data:image/' + (IMG_MIME[ext] || 'jpeg') + ';base64,' + (data.split(',')[1] || '');
    }
    const commit = (finalData) => {
      attachments[idx] = { type: kind === 'doc' ? 'file' : kind, name: file.name, data: finalData, format, kind };
      renderAttachChips();
    };
    if (kind === 'image' && typeof data === 'string') {
      // 统一重编码：透明 PNG/HEIC 在深色气泡里会显示成一整块黑，且超大图会撑爆请求体
      normalizeImageData(data, commit);
    } else {
      commit(data);
    }
  };
  reader.onerror = () => {
    attachments.splice(idx, 1);
    renderAttachChips();
    toast('读取文件失败：' + file.name, 'error');
  };
  reader.readAsDataURL(file);
}
// 图片归一化：铺白底重编码为 jpeg，长边上限 1600；解码失败则保留原 data URL
function normalizeImageData(dataUrl, cb) {
  const img = new Image();
  img.onload = () => {
    try {
      const max = 1600;
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) return cb(dataUrl);
      const sc = Math.min(1, max / Math.max(w, h));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(w * sc));
      cv.height = Math.max(1, Math.round(h * sc));
      const cx = cv.getContext('2d');
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, cv.width, cv.height);
      cx.drawImage(img, 0, 0, cv.width, cv.height);
      cb(cv.toDataURL('image/jpeg', 0.85));
    } catch (_) { cb(dataUrl); }
  };
  img.onerror = () => cb(dataUrl);
  img.src = dataUrl;
}

function guessUrlKind(url) {
  const m = ((url.split('?')[0].match(/\.(\w+)$/) || [])[1] || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(m)) return { type: 'image', format: '' };
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(m)) return { type: 'video', format: '' };
  if (['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac'].includes(m)) return { type: 'audio', format: m };
  return { type: 'file', format: '' };
}
function renderAttachChips() {
  const box = $('attach-chips');
  box.classList.toggle('hidden', attachments.length === 0);
  box.innerHTML = attachments.map((a, i) => {
    if (a.uploading) {
      // 上传/读取中：进度条 + 百分比
      return `<span class="attach-chip chip-uploading" data-idx="${i}">
        <span class="file-badge">${svgIcon('upload', 16)}</span>
        <span class="chip-progress-wrap">
          <span class="chip-progress-name">${escapeHtml(a.name)}</span>
          <span class="chip-progress-track"><span class="chip-progress-bar" style="width:${a.progress}%"></span></span>
        </span>
        <span class="chip-progress-pct">${a.progress}%</span>
      </span>`;
    }
    const isImg = a.type === 'image' && typeof a.data === 'string' && a.data.startsWith('data:');
    const lead = isImg
      ? `<img class="attach-thumb" src="${a.data}" alt="照片预览" data-zoom="${i}">`
      : fileBadgeHTML(a.name, a.type);
    return `<span class="attach-chip" data-idx="${i}">${lead}<span class="attach-chip-name">${escapeHtml(a.name)}</span><button type="button" class="attach-chip-x" data-i="${i}" title="移除">${svgIcon('x', 11)}</button></span>`;
  }).join('');
  box.querySelectorAll('.attach-chip-x').forEach(b => {
    b.onclick = () => { attachments.splice(Number(b.dataset.i), 1); renderAttachChips(); };
  });
  // 点击照片缩略图放大预览
  box.querySelectorAll('.attach-thumb[data-zoom]').forEach(img => {
    img.onclick = () => openImagePreview(img.src);
  });
}
// 全屏图片预览（lightbox）
function openImagePreview(src) {
  const ov = document.createElement('div');
  ov.className = 'img-lightbox';
  ov.innerHTML = `<img src="${src}" alt="附件预览"><button type="button" class="img-lightbox-x" aria-label="关闭">${svgIcon('x', 22)}</button>`;
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
  const close = () => {
    ov.classList.remove('show');
    document.body.style.overflow = '';
    setTimeout(() => ov.remove(), 180);
  };
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.img-lightbox-x')) close();
  });
}
function attachSummaryText(text) {
  const tags = attachments.map(a => `【${a.type === 'image' ? '图片' : a.type === 'video' ? '视频' : a.type === 'audio' ? '语音' : '文件'}】${a.name}`).join(' ');
  return tags + (text ? '\n' + text : '');
}
function buildUserContent(text) {
  const parts = attachments.map(a => {
    if (a.type === 'image') return { type: 'image_url', image_url: { url: a.data } };
    if (a.type === 'video') return { type: 'video_url', video_url: { url: a.data } };
    if (a.type === 'audio') return { type: 'input_audio', input_audio: { data: a.data, format: a.format || 'wav' } };
    return { type: 'file', file: { file_url: a.data } };
  });
  parts.push({ type: 'text', text: text || '请描述以上内容' });
  return parts;
}
function clearAttachments() { attachments = []; renderAttachChips(); }

// GLM-4-Voice：把 WAV base64 播放出来，并在气泡内放一个可重复播放的播放器
// 把一段 WAV base64 解码后放进持久容器；autoplay=true 时尝试自动播放
function appendVoicePlayer(wrap, b64, autoplay) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: 'audio/wav' }));
    if (autoplay) { const a = new Audio(url); a.play().catch(() => {}); }
    const p = document.createElement('audio');
    p.controls = true; p.src = url; p.className = 'voice-player';
    p.style.cssText = 'margin-top:8px;max-width:100%;height:36px;display:block';
    wrap.appendChild(p);
  } catch (e) { console.log('voice append failed', e); }
}
function playVoiceAudio(b64, bubble) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    // 自动播放（若被浏览器拦截，用户可点播放器）
    const a = new Audio(url);
    a.play().catch(() => {});
    // 气泡内播放器
    if (bubble) {
      const p = document.createElement('audio');
      p.controls = true; p.src = url; p.className = 'voice-player';
      p.style.cssText = 'margin-top:8px;max-width:100%;height:36px';
      bubble.appendChild(p);
    }
  } catch (e) { console.log('voice play failed', e); }
}

// ============ 项目式编程：收集文件 / 项目卡片 / 下载 ZIP ============
function collectProjectFiles(bubble) {
  const files = [];
  const seen = new Set();
  bubble.querySelectorAll('.code-block').forEach(b => {
    const p = (b.dataset.filename || '').trim();
    if (!p || seen.has(p)) return;
    const code = b.querySelector('pre code');
    seen.add(p);
    files.push({ path: p, content: code ? code.textContent : '' });
  });
  return files;
}
// ============ 浏览器本地存储（IndexedDB）：项目文件与版本保存在使用用户的设备上，不传到服务器 ============
let _idbPromise = null;
function idbOpen() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const rq = indexedDB.open('ai-chat-local', 1);
    rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'convId' }); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  return _idbPromise;
}
async function idbGetProject(convId) {
  if (!convId) return null;
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readonly');
    const g = tx.objectStore('projects').get(convId);
    g.onsuccess = () => resolve(g.result || null);
    g.onerror = () => reject(g.error);
  });
}
async function idbSaveProject(convId, files, versions) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put({ convId, files: files || {}, versions: versions || [] });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
// 重新生成前快照：把当前工作区文件保存为版本 vN（数据只在用户浏览器设备内）
async function idbSnapshotProject(convId) {
  if (!convId) return null;
  const rec = await idbGetProject(convId);
  if (!rec || !rec.files || !Object.keys(rec.files).length) return null;
  const n = (rec.versions || []).length + 1;
  const ver = { id: n, time: Math.floor(Date.now() / 1000), files: rec.files };
  await idbSaveProject(convId, rec.files, [...(rec.versions || []), ver]);
  return n;
}

// ============ 前端 ZIP 打包（STORE 无压缩，纯浏览器生成，文件不经过服务器） ============
const _crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function makeZip(files) {
  const enc = new TextEncoder();
  const crc32 = (u) => { let c = 0xFFFFFFFF; for (const b of u) c = _crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(String(f.path || '').replace(/\\/g, '/'));
    const data = enc.encode(String(f.content || ''));
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), nameBytes, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true); ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
    ch.setUint32(34, 0, true); ch.setUint32(38, offset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdStart = offset, cdLen = central.reduce((s, c) => s + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdLen, true); eocd.setUint32(16, cdStart, true); eocd.setUint16(20, 0, true);
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const c of all) { out.set(c, o); o += c.length; }
  return new Blob([out], { type: 'application/zip' });
}
async function downloadProjectZip(name, files) {
  const zipName = name || 'project';
  try {
    const blob = makeZip(files || []);
    if (IS_NATIVE && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
      const FS = window.Capacitor.Plugins.Filesystem;
      const arr = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
      const b64 = btoa(bin);
      await FS.writeFile({ path: zipName + '.zip', data: b64, directory: FS.Directory.Data, recursive: true });
      toast('ZIP 已保存：' + zipName + '.zip', 'success', 3000);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = zipName + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch (e) {
    // 兜底：直接用 blob 下载
    try {
      const blob = makeZip(files || []);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = zipName + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (_) {
      toast('下载 ZIP 失败：' + (e.message || e), 'error', 4000);
    }
  }
}
// 项目式编程：分步进度 UI（复用气泡内的 .project-progress 容器）
function ensureProjectProgress(bubble) {
  let el = bubble.querySelector('.project-progress');
  if (!el) { el = document.createElement('div'); el.className = 'project-progress'; bubble.appendChild(el); }
  return el;
}
function addProjectStepLine(bubble, html) {
  const el = ensureProjectProgress(bubble);
  const d = document.createElement('div');
  d.className = 'project-step';
  d.innerHTML = html;
  el.appendChild(d);
  return d;
}
function renderProjectCard(bubble, files) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));  const card = document.createElement('div');
  card.className = 'project-card';
  card.innerHTML = `
    <div class="project-card-head">
      <span class="project-card-ico">${svgIcon('package', 16)}</span>
      <span class="project-card-title">项目 · ${files.length} 个文件</span>
      <div class="project-head-actions">
        <button type="button" class="project-ver-btn">${svgIcon('history', 13)} 版本历史</button>
        <button type="button" class="project-zip-btn">${svgIcon('download', 13)} 下载 ZIP</button>
      </div>
    </div>
    <div class="project-tree">
      ${sorted.map((f, i) => {
        const isHtml = /\.html?$/i.test(f.path);
        return `<div class="project-file" data-i="${i}">
          ${fileBadgeHTML(f.path, '')}
          <span class="project-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
          ${isHtml ? `<button type="button" class="project-file-preview" title="预览 HTML">${svgIcon('globe', 11)}</button>` : ''}
          <button type="button" class="project-file-dl" title="下载此文件">${svgIcon('download', 11)}</button>
          <button type="button" class="project-file-copy" title="复制该文件">${svgIcon('copy', 11)}</button>
        </div>`;
      }).join('')}
    </div>`;
  const convId = currentConvId;
  card.querySelector('.project-zip-btn').onclick = () => downloadProjectZip('project', sorted);
  card.querySelector('.project-ver-btn').onclick = () => openProjectVersions(card, convId);
  card.querySelectorAll('.project-file-copy').forEach(b => {
    b.onclick = () => {
      const f = sorted[Number(b.closest('.project-file').dataset.i)];
      copyText(f.content).then(ok =>
        toast(ok ? '已复制 ' + f.path : '复制失败', ok ? 'success' : 'error', 1200));
    };
  });
  card.querySelectorAll('.project-file-preview').forEach(b => {
    b.onclick = () => {
      const f = sorted[Number(b.closest('.project-file').dataset.i)];
      openHtmlPreview(f.content, f.path, sorted);
    };
  });
  card.querySelectorAll('.project-file-dl').forEach(b => {
    b.onclick = () => {
      const f = sorted[Number(b.closest('.project-file').dataset.i)];
      downloadSingleFile(f.path, f.content);
    };
  });
  bubble.prepend(card);
}

// 下载单个文件（APK 用 Filesystem，浏览器用 a.click）
async function downloadSingleFile(name, content) {
  try {
    if (IS_NATIVE && window.Capacitor?.Plugins?.Filesystem) {
      const FS = window.Capacitor.Plugins.Filesystem;
      // 处理路径中的子目录
      const parts = name.split('/');
      const fileName = parts.pop();
      const dir = parts.join('/');
      const opts = { data: content, directory: FS.Directory.Data, encoding: 'utf8', recursive: true };
      if (dir) opts.path = dir + '/' + fileName; else opts.path = fileName;
      await FS.writeFile(opts);
      toast('已保存：' + name, 'success', 2000);
      return;
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch (e) {
    // 兜底：blob 下载
    try {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (_) {
      toast('下载失败：' + (e.message || e), 'error');
    }
  }
}

// ============ 项目版本管理（数据全部保存在用户设备本地，不传输到云端） ============
async function openProjectVersions(card, convId) {
  if (!convId) { toast('版本信息暂不可用', 'error'); return; }
  const old = card.querySelector('.project-versions');
  if (old) { old.remove(); return; }
  const box = document.createElement('div');
  box.className = 'project-versions';
  box.innerHTML = '<div class="pv-loading">正在读取本地版本记录…</div>';
  card.appendChild(box);
  try {
    const rec = await idbGetProject(convId);
    const vers = (rec && rec.versions) || [];
    if (!vers.length) {
      box.innerHTML = '<div class="pv-empty">暂无历史版本（每次重新生成会自动保存上一版，仅存于本设备）</div>';
      return;
    }
    box.innerHTML = '<div class="pv-title">本设备版本记录</div>' + vers.map(v => `
      <div class="pv-row" data-v="${v.id}">
        <span class="pv-badge">v${v.id}</span>
        <span class="pv-meta">${new Date(v.time * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${Object.keys(v.files || {}).length} 个文件</span>
        <button type="button" class="pv-view-btn">查看</button>
        <button type="button" class="pv-restore-btn">回滚</button>
      </div>`).join('');
    box.querySelectorAll('.pv-row').forEach(row => {
      const v = row.dataset.v;
      const ver = vers.find(x => String(x.id) === String(v));
      row.querySelector('.pv-view-btn').onclick = () => {
        const detail = box.querySelector('.pv-detail');
        if (detail) detail.remove();
        const d = document.createElement('div');
        d.className = 'pv-detail';
        const farr = Object.entries(ver.files || {}).map(([path, content]) => ({ path, content }));
        d.innerHTML = '<div class="pv-detail-title">v' + v + ' 文件内容预览</div>' +
          farr.map(f => `<details class="pv-file"><summary>${escapeHtml(f.path)}</summary><pre>${escapeHtml(f.content.slice(0, 400))}${f.content.length > 400 ? '\n…（内容较长已截断）' : ''}</pre></details>`).join('') ||
          '<div class="pv-empty">该版本无文件</div>';
        row.after(d);
      };
      row.querySelector('.pv-restore-btn').onclick = async () => {
        const ok = await confirm('确定回滚到 v' + v + '？当前文件会被该版本覆盖。');
        if (!ok) return;
        try {
          const farr = Object.entries(ver.files || {}).map(([path, content]) => ({ path, content }));
          await idbSaveProject(convId, ver.files, vers);
          toast('已回滚到 v' + v + '（' + farr.length + ' 个文件）', 'success', 2600);
          // 重建项目卡片文件树
          const tree = card.querySelector('.project-tree');
          tree.innerHTML = farr.map((f, i) => `
            <div class="project-file" data-i="${i}">
              ${fileBadgeHTML(f.path, '')}
              <span class="project-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
            </div>`).join('');
          const title = card.querySelector('.project-card-title');
          title.textContent = '项目 · ' + farr.length + ' 个文件（已回滚 v' + v + '）';
          box.remove();
        } catch (e) { toast(e.message, 'error'); }
      };
    });
  } catch (e) {
    box.innerHTML = '<div class="pv-empty">读取版本失败：' + escapeHtml(e.message) + '</div>';
  }
}

$('btn-attach').onclick = () => {
  if ($('btn-attach').classList.contains('disabled')) {
    toast('当前模型不支持附件，请切换至智谱多模态模型（如 GLM-5.3-Flash）', 'error');
    return;
  }
  const panel = $('attach-panel');
  if (panel.classList.contains('hidden')) {
    // fixed 定位：紧贴输入行"＋"按钮上方，不随输入区滚动漂移（修复面板卡在消息区里）
    const r = $('btn-attach').getBoundingClientRect();
    const ph = panel.offsetHeight || 232;
    panel.style.position = 'fixed';
    panel.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 230)) + 'px';
    panel.style.top = Math.max(8, r.top - ph - 8) + 'px';
    panel.style.bottom = 'auto';
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
};
$('attach-panel').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-kind]');
  if (!btn || btn.classList.contains('disabled')) return;
  const kind = btn.dataset.kind;
  if (kind === 'camera') {
    $('attach-panel').classList.add('hidden');
    openCamera();
    return;
  }
  if (kind === 'url') {
    openAppModal({
      title: '粘贴链接',
      message: '输入图片 / 视频 / 文件 / 语音的链接：',
      input: true,
      okText: '添 加',
      onOk: (url) => {
        if (!url) { $('am-error').textContent = '链接不能为空'; return false; }
        const g = guessUrlKind(url);
        attachments.push({ type: g.type, name: url.split('/').pop() || url, data: url, format: g.format, kind: 'url' });
        renderAttachChips();
      },
    });
    return;
  }
  $('attach-file-' + kind).click();
});
['image', 'doc', 'audio'].forEach(kind => {
  $('attach-file-' + kind).addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    readAsAttachment(file, kind);
    e.target.value = '';
  });
});
document.addEventListener('click', (e) => {
  if (!$('attach-panel').classList.contains('hidden') && !$('attach-panel').contains(e.target) && e.target !== $('btn-attach') && !$('btn-attach').contains(e.target)) {
    $('attach-panel').classList.add('hidden');
  }
});

// ========== 摄像头拍照（仅支持图片的模型；getUserMedia 需 HTTPS 或 localhost） ==========
let cameraStream = null;
let capturedDataUrl = '';
function stopCameraStream() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    cameraStream = null;
  }
  const v = $('camera-video');
  if (v && v.srcObject) { v.srcObject = null; }
}
function setCameraPhase(phase) {
  // phase: 'live' 预览 | 'edit' 拍后涂画 | 'error'
  const v = $('camera-video'), p = $('camera-preview'), hint = $('camera-hint');
  const shutter = $('cam-shutter'), retake = $('cam-retake'), use = $('cam-use');
  const edit = $('camera-edit'), tools = $('camera-tools');
  v.hidden = phase !== 'live';
  p.hidden = true;                       // 拍完直接进编辑画布，不再单独显示静态预览
  hint.classList.toggle('hidden', phase !== 'error');
  shutter.classList.toggle('hidden', phase !== 'live');
  retake.classList.toggle('hidden', phase !== 'edit');
  use.classList.toggle('hidden', phase !== 'edit');
  if (edit) edit.classList.toggle('hidden', phase !== 'edit');
  if (tools) tools.classList.toggle('hidden', phase !== 'edit');
}
async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('当前环境不支持摄像头（需要 HTTPS 或 localhost 访问）', 'error', 3600);
    return;
  }
  capturedDataUrl = '';
  $('camera-preview').removeAttribute('src');
  $('camera-hint').textContent = '';
  $('camera-modal').classList.remove('hidden');
  setCameraPhase('live');
  try {
    // 优先后置摄像头（拍实物），桌面端自动回退默认摄像头
    // 全屏拍照：优先请求设备能给到的最高分辨率，拍讲义/公式才能看清
    const hi = { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } };
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: hi, audio: false });
    } catch (_) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    }
    cameraStream = stream;
    $('camera-video').srcObject = cameraStream;
    await $('camera-video').play().catch(() => {});
  } catch (err) {
    stopCameraStream();
    setCameraPhase('error');
    const name = err && err.name;
    const msg = name === 'NotAllowedError' || name === 'SecurityError'
      ? '摄像头权限被拒绝，请在浏览器设置中允许本站使用摄像头后重试'
      : name === 'NotFoundError' || name === 'OverconstrainedError'
        ? '未检测到可用的摄像头设备'
        : '摄像头启动失败：' + (err && err.message ? err.message : name || '未知错误');
    $('camera-hint').textContent = msg;
    toast(msg, 'error', 3600);
  }
}
function closeCamera() {
  stopCameraStream();
  $('camera-modal').classList.add('hidden');
  capturedDataUrl = '';
}
let camImg = null, camStrokes = [], camStroke = null, camColor = '#ef4444';

function takePhoto() {
  const v = $('camera-video');
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) { toast('摄像头尚未就绪，请稍候', 'error'); return; }
  const canvas = $('camera-canvas');
  const maxW = 2048;                    // 保留原始细节，只做上限约束
  const scale = Math.min(1, maxW / w);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
  camImg = new Image();
  camImg.onload = () => enterCamEdit();
  camImg.src = canvas.toDataURL('image/jpeg', 0.92);
}

function enterCamEdit() {
  const c = $('camera-edit');
  c.width = camImg.naturalWidth;
  c.height = camImg.naturalHeight;
  camStrokes = []; camStroke = null;
  drawCamEdit();
  setCameraPhase('edit');
}

function drawCamEdit() {
  const c = $('camera-edit');
  if (!c || !camImg) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(camImg, 0, 0, c.width, c.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const st of camStrokes) {
    if (!st.points.length) continue;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = Math.max(2, Math.round(c.width / 320));
    ctx.beginPath();
    ctx.moveTo(st.points[0][0], st.points[0][1]);
    for (const pt of st.points.slice(1)) ctx.lineTo(pt[0], pt[1]);
    ctx.stroke();
  }
  if (camStroke && camStroke.points.length) {
    ctx.strokeStyle = camStroke.color;
    ctx.lineWidth = Math.max(2, Math.round(c.width / 320));
    ctx.beginPath();
    ctx.moveTo(camStroke.points[0][0], camStroke.points[0][1]);
    for (const pt of camStroke.points.slice(1)) ctx.lineTo(pt[0], pt[1]);
    ctx.stroke();
  }
}

function camPoint(e) {
  const c = $('camera-edit');
  const r = c.getBoundingClientRect();
  const x = (e.clientX - r.left) * (c.width / r.width);
  const y = (e.clientY - r.top) * (c.height / r.height);
  return [Math.max(0, Math.min(c.width, x)), Math.max(0, Math.min(c.height, y))];
}

function bindCamEditor() {
  const c = $('camera-edit');
  if (!c || c.dataset.bound) return;
  c.dataset.bound = '1';
  c.addEventListener('pointerdown', (e) => {
    if (c.classList.contains('hidden')) return;
    e.preventDefault();
    camStroke = { color: camColor, points: [camPoint(e)] };
    drawCamEdit();
  });
  c.addEventListener('pointermove', (e) => {
    if (!camStroke) return;
    e.preventDefault();
    camStroke.points.push(camPoint(e));
    drawCamEdit();
  });
  const end = () => {
    if (camStroke && camStroke.points.length > 1) camStrokes.push(camStroke);
    camStroke = null;
    drawCamEdit();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('pointerleave', end);
  document.querySelectorAll('.cam-color').forEach(btn => {
    btn.addEventListener('click', () => {
      camColor = btn.dataset.color || '#ef4444';
      document.querySelectorAll('.cam-color').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  const undo = document.getElementById('cam-undo');
  const clear = document.getElementById('cam-clear');
  if (undo) undo.addEventListener('click', () => { camStrokes.pop(); drawCamEdit(); });
  if (clear) clear.addEventListener('click', () => { camStrokes = []; camStroke = null; drawCamEdit(); });
}
bindCamEditor();
function usePhoto() {
  const edit = $('camera-edit');
  if (edit && camImg && !edit.classList.contains('hidden')) {
    try { capturedDataUrl = edit.toDataURL('image/jpeg', 0.92); } catch (_) {}
  }
  if (!capturedDataUrl) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `照片_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
  attachments.push({ type: 'image', name, data: capturedDataUrl, format: '', kind: 'camera' });
  renderAttachChips();
  closeCamera();
  toast('照片已添加，可直接发送或继续添加', 'success', 1800);
}
$('cam-cancel').addEventListener('click', closeCamera);
document.getElementById('cam-retake') && document.getElementById('cam-retake').addEventListener('click', () => {
  camImg = null; camStrokes = []; camStroke = null; capturedDataUrl = '';
  setCameraPhase('live');
});
$('cam-shutter').addEventListener('click', takePhoto);
$('cam-retake').addEventListener('click', () => { capturedDataUrl = ''; setCameraPhase('live'); });
$('cam-use').addEventListener('click', usePhoto);
// 点遮罩空白处关闭
$('camera-modal').addEventListener('click', (e) => {
  if (e.target === $('camera-modal')) closeCamera();
});

// ========== 深度搜索（深度思考 + 强制联网；智谱/OpenRouter 思考模型可用） ==========
let deepMode = false;
function updateDeepAvailability() {
  const caps = modelCaps(currentModel);
  const canThink = caps.includes('think');
  const btn = $('btn-deep-toggle');
  btn.classList.toggle('disabled', !canThink);
  btn.title = canThink ? '深度思考模式' : '当前模型不支持深度思考';
  if (!canThink && deepMode) { deepMode = false; btn.classList.remove('active'); }
}
$('btn-deep-toggle').onclick = () => {
  if (!modelCaps(currentModel).includes('think')) {
    toast('当前模型不支持深度思考', 'error');
    return;
  }
  deepMode = !deepMode;
  $('btn-deep-toggle').classList.toggle('active', deepMode);
  // 深度思考不再自动强制联网，保持用户当前联网设置
};

// ========== 消息滚动：AI 回答期间允许用户上滑；完成后可点箭头回到底部 ==========
const msgBox = $('messages');
let autoFollow = true;
msgBox.addEventListener('scroll', () => {
  const nearBottom = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 140;
  autoFollow = nearBottom;
  $('scroll-down-btn').classList.toggle('hidden', nearBottom);
}, { passive: true });
function scrollToBottom() {
  autoFollow = true;
  msgBox.scrollTo({ top: msgBox.scrollHeight, behavior: 'smooth' });
  $('scroll-down-btn').classList.add('hidden');
}
$('scroll-down-btn').onclick = scrollToBottom;
try {
  const sdb = $('scroll-down-btn');
  // 祖先若有 transform/filter 会形成包含块，position:fixed 会退化成随内容滚动；挂到 body 直系即可
  if (sdb && sdb.parentElement !== document.body) document.body.appendChild(sdb);
} catch (_) {}

// ========== 发送（流式） ==========
const input = $('input');
const btnSend = $('btn-send');
const btnStop = $('btn-stop-gen');
if (btnStop) btnStop.onclick = async () => {
  if (chatAbort) { try { chatAbort.abort(); } catch (_) {} }
  // Agent 任务跑在原生进程里，必须杀进程才算真正取消
  if (window.__agentRunning) {
    try {
      const sb = getSandbox();
      if (sb && typeof sb.agentStop === 'function') await sb.agentStop();
      window.__agentRunning = false;
      if (window.__agentBubble) {
        const hint = window.__agentBubble.querySelector('.typing-hint');
        if (hint) hint.textContent = '已取消';
        window.__agentBubble.classList.remove('typing');
      }
      toast('Agent 任务已取消');
      return;
    } catch (_) {}
  }
  toast('已停止生成');
};
// 输入框自动扩展：内容超出后随输入增高（上限 180px，超出出现滚动条）
function autoGrowInput() {
  input.style.height = 'auto';
  const h = Math.min(input.scrollHeight, 180);
  input.style.height = (h > 24 ? h : 24) + 'px';
}
input.addEventListener('input', autoGrowInput);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
btnSend.onclick = sendMessage;

async function sendMessage() {
  const text = input.value.trim();
  const hasAttach = attachments.length > 0;
  if ((!text && !hasAttach) || streaming) return;
  const kind = modelKind(currentModel);
  // OpenClaw 本地执行：直接把任务交给内置 Agent，结果回填到对话
  if (kind === 'agent') {
    input.value = '';
    input.style.height = 'auto';
    hideWelcome();
    addMessage('user', text);
    clearAttachments();
    const { wrap, bubble } = addMessage('assistant', '');
    bubble.classList.add('typing');
    bubble.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span><span class="typing-hint">OpenClaw 启动中…</span>';
    window.__agentBubble = bubble;
    window.__agentRunning = true;
    // 详细日志区：折叠展示，点开可看 OpenClaw 全部原生日志
    const logWrap = document.createElement('details');
    logWrap.className = 'agent-log-wrap';
    logWrap.innerHTML = '<summary>OpenClaw 运行日志</summary><div class="agent-log-box"></div>';
    bubble.parentNode.appendChild(logWrap);
    window.__agentLogBox = logWrap.querySelector('.agent-log-box');
    try {
      const conv = ensureConversation(currentConvId, currentModel);
      if (!currentConvId) { currentConvId = conv.id; }
      appendConvMessage(currentConvId, { role: 'user', content: text });
      const r = await (window.__runAgentTask ? window.__runAgentTask(text, currentModel) : Promise.resolve(null));
      const out = (r && r.text) ? r.text : ('Agent 执行结束（退出码 ' + (r && r.code != null ? r.code : '?') + '）');
      window.__agentBubble = null;
      window.__agentRunning = false;
      window.__agentLogBox = null;
      bubble.classList.remove('typing');
      bubble.textContent = out;
      appendConvMessage(currentConvId, { role: 'assistant', content: out });
      try { await persistState(); } catch (_) {}
      loadConversations();
      finalizeAIMessage(wrap, bubble);
    } catch (e) {
      window.__agentBubble = null;
      bubble.classList.remove('typing');
      bubble.textContent = 'Agent 执行失败：' + (e && e.message ? e.message : e);
    }
    return;
  }
  // 生成类模型（绘图/视频/配音）：不需要附件，走专门的生成接口
  if (kind !== 'chat') {
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    hideWelcome();
    addMessage('user', text);
    clearAttachments();
    return doGenerate(text, kind);
  }
  input.value = '';
  input.style.height = 'auto';
  hideWelcome();
  const content = hasAttach ? buildUserContent(text) : text;
  const hasImage = attachments.some(a => a.type === 'image');
  addMessage('user', hasAttach ? attachSummaryText(text) : text, undefined, hasAttach ? attachments : null);
  clearAttachments();
  await doChat(content, false, { hasImage });
}

async function retryLastAI(aiWrap) {
  if (streaming) return;
  const kind = modelKind(currentModel);
  const msgs = document.querySelectorAll('#messages .msg');
  let userText = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] === aiWrap) continue;
    if (msgs[i].classList.contains('user')) {
      userText = msgs[i].querySelector('.msg-bubble').textContent;
      break;
    }
  }
  if (!userText) { toast('找不到上一条用户消息，无法重新生成', 'error'); return; }
  aiWrap.remove();
  if (kind !== 'chat') return doGenerate(userText, kind);
  await doChat(userText, true);
}

let chatAbort = null;          // 当前生成请求的中断控制器
function promptDeactivated(detail) {
  openAppModal({
    title: '账号已申请注销',
    message: (detail || '当前账号处于注销冷静期，AI 对话暂不可用。') +
      '\n冷静期内可随时取消注销，取消后立即恢复使用。',
    okText: '取消注销并恢复',
    cancelText: '知道了',
    onOk: async () => {
      try { await api('/api/deactivate', { method: 'DELETE' }); } catch (_) {}
      deactivating = false;
      toast('已取消注销，AI 对话已恢复', 'success');
      return true;
    },
  });
}

async function doChat(text, isRetry = false, opts = {}) {
  // 图片/多模态消息的 content 是 OpenAI content 数组，historical 版本这里直接 text.replace
  // 会抛 "text.replace is not a function"，导致图片一发就报错
  const textStr = Array.isArray(text)
    ? (text.filter(p => p && p.type === 'text').map(p => String(p.text || '')).join(' ').trim() || '【图片】')
    : (text && typeof text === 'object')
      ? String(text.text || text.content || '')
      : String(text == null ? '' : text);
  const isProject = opts.project === true;
  if (deactivating) { promptDeactivated(); return; }
  streaming = true;
  btnSend.disabled = true;
  if (btnStop) btnStop.classList.remove('hidden');
  chatAbort = new AbortController();
  const chatSeq = (window.__chatSeq = (window.__chatSeq || 0) + 1);
  const { wrap: aiWrap, bubble: aiBubble } = addMessage('assistant', '');
  aiBubble.classList.add('typing');
  aiBubble.classList.add('typing');
  aiBubble.innerHTML = '<span class="typing-dots" aria-label="正在思考"><i></i><i></i><i></i></span>'
    + (opts.hasImage ? '<span class="typing-hint">正在上传 / 解析图片…</span>' : '');
  const aiAvatar = aiWrap.querySelector('.avatar');
  if (aiAvatar) aiAvatar.classList.add('pulse');

  // 关键修复①：原版这里写的是 stopThinking(); 导致无限递归爆栈，
  // 把后续 aiBubble.innerHTML = ... 的赋值吞掉，所以流式内容刷新前不显示
  const stopThinking = () => {
    if (aiAvatar) aiAvatar.classList.remove('pulse');
  };

  // 只有"最新一次发送"才有权解锁输入框，避免旧请求的收尾覆盖新请求的状态
  const finishChat = (seq) => {
    if (seq !== window.__chatSeq) return;
    streaming = false;
    btnSend.disabled = false;
    if (btnStop) btnStop.classList.add('hidden');
    if (chatAbort) chatAbort = null;
    input.focus();
  };

  let received = '';
  let sawDone = false;
  let thinkingText = '';
  let voiceWrapEl = null;   // GLM-4-Voice 持久语音容器（renderAI 重建时保留）
  let voiceIdx = 0;         // 已收到的语音片段序号（首段自动播放）
  let contentBuf = ''; // 原始 delta 流缓冲（含 <think> 标签），received 始终为清洗后的正文

  // 深度思考内容块（reasoning_content），始终保留在气泡最上方，可折叠
  let thinkTimer = null;
  const renderThinkBox = (immediate) => {
    let tb = aiBubble.querySelector('.think-box');
    if (!tb) {
      tb = document.createElement('details');
      tb.className = 'think-box';
      tb.open = true;   // 思考过程中默认展开
      tb.innerHTML = '<summary>' + svgIcon('brain', 13) + ' 深度思考中…</summary><div class="think-content"></div>';
      aiBubble.prepend(tb);
    }
    tb.open = true;
    const paint = () => {
      thinkTimer = null;
      const box = tb.querySelector('.think-content');
      if (box) box.innerHTML = renderMarkdown(thinkingText);  // 思考内容支持 Markdown
      if (autoFollow) msgBox.scrollTop = msgBox.scrollHeight;  // 用户上滑后不强制拉回
    };
    if (immediate) { if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; } paint(); }
    else if (!thinkTimer) { thinkTimer = setTimeout(paint, 100); }  // 流式阶段节流，避免卡顿
  };

  // ---- 流式渲染节流：避免每个 delta 都全量重渲染 Markdown（大段代码时非常卡） ----
  const HEAVY_LEN = 8000; // 超过该长度，流式阶段改用纯文本渲染，结束时再整体渲染 Markdown
  let renderTimer = null;
  const cancelRender = () => { if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; } };
  const renderAI = (fullRender) => {
    // 保留思考块、搜索状态条、已展开的来源列表：先渲染正文，再依次放回
    const tb = aiBubble.querySelector('.think-box');
    const sb = aiBubble.querySelector('.search-badge');
    const ss = aiBubble.querySelector('.search-sources');
    const vw = aiBubble.querySelector('.voice-wrap');
    // 始终用 Markdown 渲染（含代码框），不再因内容长而降级成纯文本，
    // 避免长代码生成过程中代码框消失、完成后才恢复；渲染频率由 scheduleRender 的 60ms 节流控制
    aiBubble.dataset.rawText = received;
    aiBubble.innerHTML = renderMarkdown(received);
    if (ss) aiBubble.prepend(ss);
    if (sb) aiBubble.prepend(sb);
    if (ss && sb) sb.after(ss);
    if (tb) aiBubble.prepend(tb);
    if (vw) aiBubble.appendChild(vw);   // 语音播放器放正文末尾，不被覆盖
    if (autoFollow) msgBox.scrollTop = msgBox.scrollHeight;
  };
  // 搜索状态条（光影浮动文字）：searching=正在搜索；done=已搜索 N 份资料+网页图标（可展开来源）
  const ICON_SPIN = '<svg class="sb-spin" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>';
  const ICON_WEB = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>';
  const ICON_CHEVRON = '<svg class="sb-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let searchSources = [];
  const renderSearchBadge = (state, count, sources) => {
    let badge = aiBubble.querySelector('.search-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'search-badge';
      aiBubble.prepend(badge);
    }
    if (state === 'searching') {
      badge.className = 'search-badge searching';
      badge.innerHTML = ICON_SPIN + '<span class="sb-text">正在搜索</span><span class="sb-dots"><i>.</i><i>.</i><i>.</i></span>';
      badge.onclick = null;
    } else if (state === 'done') {
      searchSources = Array.isArray(sources) ? sources : [];
      badge.className = 'search-badge done clickable';
      badge.title = '点击查看资料来源';
      badge.innerHTML = ICON_WEB + '<span class="sb-text">已搜索 ' + count + ' 份资料</span>' + ICON_CHEVRON;
      badge.onclick = (e) => {
        e.stopPropagation();
        const existing = aiBubble.querySelector('.search-sources');
        if (existing) { existing.remove(); badge.classList.remove('open'); return; }
        const list = document.createElement('div');
        list.className = 'search-sources';
        list.innerHTML = searchSources.map((s, i) => {
          const t = escapeHtml(s.title || '未命名来源');
          let domain = '';
          try { domain = s.url ? new URL(s.url).hostname.replace(/^www\./, '') : ''; } catch (_) {}
          if (/^https?:\/\//.test(s.url || '')) {
            return `<a class="src-item" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">
              <span class="src-idx">${i + 1}</span>${ICON_WEB}
              <span class="src-body"><span class="src-title">${t}</span>${domain ? '<span class="src-domain">' + escapeHtml(domain) + '</span>' : ''}</span>
            </a>`;
          }
          return `<div class="src-item no-url"><span class="src-idx">${i + 1}</span>${ICON_WEB}<span class="src-body"><span class="src-title">${t}</span></span></div>`;
        }).join('');
        badge.after(list);
        badge.classList.add('open');
        if (autoFollow) msgBox.scrollTop = msgBox.scrollHeight;
      };
    } else {
      badge.className = 'search-badge none';
      badge.innerHTML = ICON_WEB + '<span class="sb-text">未找到相关资料</span>';
      badge.onclick = null;
    }
  };
  const scheduleRender = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAI(false);
    }, 60);
  };

  // 处理一个完整的 SSE 块（event: xxx\ndata: ...）
  const handleBlock = (block) => {
    const lines = block.split('\n');
    let event = 'message', dataStr = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) return;
    let data; try { data = JSON.parse(dataStr); } catch { return; }
    if (event === 'start') {
      if (!currentConvId && data.conversation_id) {
        currentConvId = data.conversation_id;
        $('chat-title').textContent = data.title;
        loadConversations();
      }
      // 绑定刚发送的用户消息 id，支持"点击即可修改"
      if (data.user_message_id) {
        const lastUser = [...document.querySelectorAll('#messages .msg.user')].pop();
        if (lastUser) lastUser.dataset.id = data.user_message_id;
      }
    } else if (event === 'title') {
      if (data.title) {
        if (!data.conversation_id || currentConvId === data.conversation_id) {
          $('chat-title').textContent = data.title;
        }
        loadConversations();
      }
    } else if (event === 'search_start') {
      stopThinking();
      received = '';
      renderSearchBadge('searching');
      renderAI(true);
    } else if (event === 'notice') {
      // 后端提示（如：主节点不可用，已自动切换至智谱；或回复达到长度上限）
      if (data.message) {
        stopThinking();
        cancelRender();
        const note = '> 注意：' + data.message + '\n\n';
        received = data.append ? (received + '\n\n' + note) : (note + received);
        renderAI(true);
      }
    } else if (event === 'search_done') {
      if (data.count > 0) {
        renderSearchBadge('done', data.count, data.sources);
      } else {
        renderSearchBadge('none');
      }
      renderAI(true);
    } else if (event === 'think') {
      // 深度思考流式内容（reasoning_content）
      if (data.text) {
        thinkingText += data.text;
        renderThinkBox();
      }
    } else if (event === 'delta') {
      stopThinking();
      contentBuf += data.text;
      const sp = splitThink(contentBuf);
      if (sp.think) { thinkingText = sp.think; renderThinkBox(); }
      received = sp.clean;
      scheduleRender();
    } else if (event === 'voice') {
      // GLM-4-Voice：每段是独立 WAV，放进持久容器（renderAI 重建时保留），首段自动播放
      if (data.data) {
        if (!voiceWrapEl) {
          voiceWrapEl = document.createElement('div');
          voiceWrapEl.className = 'voice-wrap';
        }
        appendVoicePlayer(voiceWrapEl, data.data, voiceIdx === 0);
        voiceIdx++;
        if (voiceWrapEl.parentElement !== aiBubble) aiBubble.appendChild(voiceWrapEl);
      }
    } else if (event === 'plan') {
      // 项目式编程：分步计划就绪
      if (isProject) {
        const p = ensureProjectProgress(aiBubble);
        p.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'project-step';
        head.innerHTML = '📋 分步计划（' + (data.total || '?') + ' 步）';
        p.appendChild(head);
        // 列出每一步
        if (data.steps && Array.isArray(data.steps)) {
          data.steps.forEach((s, i) => {
            const stepEl = document.createElement('div');
            stepEl.className = 'project-step plan-step';
            stepEl.innerHTML = '<span class="step-dot"></span> 第 ' + (i+1) + ' 步：' + escapeHtml(typeof s === 'string' ? s : (s.title || s.desc || ''));
            p.appendChild(stepEl);
          });
        }
      }
    } else if (event === 'step_start') {
      if (isProject) addProjectStepLine(aiBubble, '<b><span class="step-dot"></span> 第 ' + data.index + '/' + data.total + ' 步：' + escapeHtml(data.title || '') + '</b>');
    } else if (event === 'file') {
      if (isProject) addProjectStepLine(aiBubble, '<span class="project-file-line"><svg class="icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:4px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' + escapeHtml(data.path || '') + '</span>');
    } else if (event === 'step_done') {
      if (isProject) {
        const el = aiBubble.querySelector('.project-progress');
        const rows = el ? [...el.querySelectorAll('.project-step')] : [];
        const last = rows.filter(r => r.innerHTML.includes('step-dot')).pop();
        if (last) last.innerHTML = last.innerHTML.replace('step-dot', 'step-dot done');
      }
    } else if (event === 'project_done') {
      // 项目式编程：全部步骤完成，文件保存到本设备 IndexedDB，并渲染项目卡片
      sawDone = true;
      stopThinking();
      cancelRender();
      renderAI(true);
      if (isProject) {
        const el = aiBubble.querySelector('.project-progress');
        if (el) el.remove();
        if (data.files && data.files.length) {
          renderProjectCard(aiBubble, data.files);
          // 保存到使用用户的设备（浏览器 IndexedDB），服务器不落盘
          try {
            const filesMap = {};
            data.files.forEach(f => { filesMap[f.path] = f.content; });
            idbGetProject(currentConvId).then(rec =>
              idbSaveProject(currentConvId, filesMap, (rec && rec.versions) || [])
            ).catch(() => {});
          } catch (_) {}
        }
      }
      finalizeAIMessage(aiWrap, aiBubble);
      finishChat(chatSeq);
    } else if (event === 'error') {
      stopThinking();
      cancelRender();
      renderAI(true);
      aiBubble.appendChild(document.createTextNode(''));
      const errNode = document.createElement('div');
      errNode.style.cssText = 'color:#dc2626;font-size:13px;margin-top:6px;';
      errNode.textContent = '错误：' + (data.message || '未知错误');
      aiBubble.appendChild(errNode);
      sawDone = true; // 出错即结束，不再等 done
      finishChat(chatSeq);
    } else if (event === 'done') {
      sawDone = true;
      stopThinking();
      cancelRender();
      // done 到达即渲染最终结果并解锁输入框，不用等服务端标题生成完（那会多等数秒）
      const finalSplit = splitThink(contentBuf);
      if (finalSplit.think) { thinkingText = finalSplit.think; renderThinkBox(true); }
      received = finalSplit.clean;
      aiBubble.classList.remove('typing');
      renderAI(true);
      if (thinkingText) {
        const tb = aiBubble.querySelector('.think-box');
        if (tb) tb.querySelector('summary').innerHTML = svgIcon('brain', 13) + ' 已深度思考';
      }
      finalizeAIMessage(aiWrap, aiBubble);
      finishChat(chatSeq);
      // 项目式编程：收集所有带文件名的代码块，渲染项目卡片（文件树 + 下载 ZIP）
      if (isProject) {
        const pfiles = collectProjectFiles(aiBubble);
        if (pfiles.length) renderProjectCard(aiBubble, pfiles);
      }
      // 付费模型消费后仅刷新菜单里的额度显示，不再弹 toast 打扰用户
      if (data.spend && data.spend.cost > 0) refreshSpendDisplay();
    }
  };

  // 事件注入：把直连回调包装成 handleBlock 可解析的 SSE 块，复用全部现有 UI 逻辑
  const dispatch = (event, data) => handleBlock(`event: ${event}\ndata: ${JSON.stringify(data)}`);

  try {
    // 禁用期内禁止对话

    // 确保本地对话（新建或复用），并保存当前用户消息（数据只存使用用户设备）
    const conv = ensureConversation(currentConvId, currentModel);
    if (!currentConvId) {
      currentConvId = conv.id;
      const t0 = textStr.replace(/\s+/g, ' ').trim().slice(0, 12) || '新对话';
      setConvTitle(conv.id, t0);
      $('chat-title').textContent = t0;
    }
    appendConvMessage(currentConvId, { role: 'user', content: text });
    try { bindLastUserEdit(); } catch (_) {}
    dispatch('start', { conversation_id: currentConvId, title: conv.title, user_message_id: 0 });
    loadConversations();

    if (isProject) {
      // 项目式编程：重新生成前快照本设备 IndexedDB 工作区为新版本
      try { await idbSnapshotProject(currentConvId); } catch (_) {}

      // 沙箱改为「按需惰性」：AI 不输出 shell 块就完全不初始化；初始化失败也不阻塞项目生成
      let sandbox = null;
      if (IS_NATIVE) {
        const projectDir = 'projects/' + currentConvId;
        let projTerm = null;
        sandbox = {
          projectDir,
          get term() { return projTerm; },
          async ensure() {
            await ensureSandbox();
            if (!projTerm) {
              projTerm = createTermPanel(aiBubble, '沙箱终端', projectDir);
              await sandboxRun(projTerm, 'mkdir -p ' + projectDir, { cwd: '' });
              projTerm.line('沙箱已就绪（AI 按需执行，可自行输入命令）', 'term-ok');
            }
          },
          async run(cmd, dir) {
            try { await this.ensure(); } catch (e) { return { code: 127, stderr: '沙箱不可用: ' + e.message }; }
            return sandboxRun(projTerm, cmd, { cwd: dir || projectDir, timeout: 120000 });
          },
          async write(path, content, dir) {
            await this.ensure();
            await sandboxWrite(projTerm, (dir || projectDir) + '/' + path, content);
          },
        };
      }

      const finalFiles = await localProjectChat({
        rawText: text, modelId: currentModel,
        emit: (event, data) => dispatch(event, data),
        sandbox,
      });
      window._lastProjectFiles = finalFiles; // 供 HTML 预览内联 CSS/JS 使用
      if (sandbox && sandbox.term) {
        sandbox.term.line('项目完成，共 ' + finalFiles.length + ' 个文件，现在可输入命令', 'term-ok');
        setTimeout(() => sandbox.term.focusInput(), 300);
      }
      // 保存 assistant 汇总消息到本地对话
      const summary = '项目已分步生成完成，共 ' + finalFiles.length + ' 个文件：\n' +
        finalFiles.map(f => '- ' + f.path).join('\n') + '\n\n可点击「下载 ZIP」获取完整代码。';
      appendConvMessage(currentConvId, { role: 'assistant', content: summary });
      await persistState();
      loadConversations();
    } else {
      // 普通聊天：直连供应商（智谱/poixe），poixe 失败自动回退智谱
      // 直连绕过了后端 /api/chat 的检索环节，这里补一次 /api/search，把结果注入 system
      let searchNote = '';
      const needSearch = webMode === 'on'
        || (webMode === 'auto' && NEED_SEARCH_RE.test(textStr));
      if (needSearch) {
        try {
          renderSearchBadge('searching');
          if (!authToken()) throw new Error('搜索需要登录');
          const r = await api('/api/search', {
            method: 'POST',
            silent: true,
            keepAuth: true,
            body: JSON.stringify({ q: textStr.slice(0, 60) }),
          });
          const items = (r && r.results) || [];
          renderSearchBadge('done', items.length, items);
          if (items.length) {
            searchNote = '\n\n【联网检索结果（回答时优先采用并标注来源序号）】\n'
              + items.slice(0, 6).map((it, i) => `[${i + 1}] ${it.title || ''} ${it.url || ''}\n${String(it.snippet || it.content || '').slice(0, 300)}`).join('\n');
          }
        } catch (e) {
          renderSearchBadge('done', 0, []);
          searchNote = '\n\n【联网检索不可用：' + (e && e.message ? e.message : e) + '】';
        }
      }
      const messages = [
        { role: 'system', content: CHAT_SYSTEM_PROMPT + searchNote },
        ...buildLocalHistory(currentConvId),
      ];
      const full = await localChatStream({
        modelId: currentModel,
        messages,
        max_tokens: currentMaxTokens,
        thinking: deepMode,
        onDelta: (t) => dispatch('delta', { text: t }),
        onThink: (t) => dispatch('think', { text: t }),
        onVoice: (a) => dispatch('voice', { data: a.data }),
        signal: chatAbort ? chatAbort.signal : undefined,
      });
      appendConvMessage(currentConvId, { role: 'assistant', content: full });
      await persistState();
      dispatch('done', {});
    }

    // 兜底：正常结束但未收到 done（事件丢失），主动渲染已收到内容并结束
    if (!sawDone) {
      stopThinking();
      cancelRender();
      if (received) {
        renderAI(true);
        finalizeAIMessage(aiWrap, aiBubble);
      }
      finishChat(chatSeq);
    }
  } catch (e) {
    stopThinking();
    cancelRender();
    const aborted = e && (e.name === 'AbortError' || /aborted|中断/i.test(e.message || ''));
    if (aborted) {
      if (received) { renderAI(true); finalizeAIMessage(aiWrap, aiBubble); }
      else { aiBubble.textContent = '已停止生成'; }
      finishChat(chatSeq);
      return;
    }
    // 注销冷静期：后端会以 403 拒绝，这里给明确提示与取消入口
    if (/注销|deactivat/i.test(e.message || '')) {
      deactivating = true;
      if (aiBubble) { aiBubble.textContent = ''; }
      if (aiWrap) aiWrap.remove();
      promptDeactivated(e.message);
      finishChat(chatSeq);
      return;
    }
    // 游客额度用尽：toast 明确提示 + 引导登录解锁
    if (/游客模式/.test(e.message || '')) {
      toast(e.message, 'error', 3600);
      setTimeout(openLoginModal, 600);
    }
    if (received) {
      // 中途断流：保留已收到的部分内容，并提示连接中断，而不是清空成纯错误
      renderAI(true);
      aiBubble.appendChild(document.createTextNode(''));
      const errNode = document.createElement('div');
      errNode.style.cssText = 'color:#dc2626;font-size:13px;margin-top:6px;';
      errNode.textContent = '连接中断：' + e.message;
      aiBubble.appendChild(errNode);
      finalizeAIMessage(aiWrap, aiBubble);
    } else {
      aiBubble.textContent = '错误：' + e.message;
    }
    finishChat(chatSeq);
  } finally {
    cancelRender();
    finishChat(chatSeq);
  }
}

// 外部链接走系统 Chrome 渲染：APP 内置 WebView 内核由系统决定，版本常低于 Chrome，
// 打开外链会缺 API；这里统一交给外部浏览器处理，保持页面渲染能力与登录态
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href)) return;
  if (!IS_NATIVE) return;
  e.preventDefault();
  try { window.open(href, '_system'); } catch (_) { window.open(href, '_blank'); }
}, true);

// 代码块的“执行”按钮：直接投递到终端面板执行
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.code-act[data-act="run"]');
  if (!btn) return;
  e.preventDefault();
  const block = btn.closest('.code-block');
  const cmd = (block && block.querySelector('pre code') ? block.querySelector('pre code').textContent : '').trim();
  if (!cmd) return;
  if (typeof window.__runInTerminal === 'function') window.__runInTerminal(cmd);
});

// ========== 生成类模型（绘图 / 视频 / 配音） ==========
async function doGenerate(prompt, kind) {
  streaming = true;
  btnSend.disabled = true;
  const { wrap: aiWrap, bubble: aiBubble } = addMessage('assistant', '');
  aiBubble.classList.add('typing');
  const hintMap = { image_gen: '正在生成图片…', video_gen: '正在创建视频任务…', tts: '正在合成语音…' };
  aiBubble.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span>
    <span class="typing-hint gen-hint">${hintMap[kind] || '正在生成…'}</span>`;
  const aiAvatar = aiWrap.querySelector('.avatar');
  if (aiAvatar) aiAvatar.classList.add('pulse');
  const setHint = (t) => { const h = aiBubble.querySelector('.gen-hint'); if (h) h.textContent = t; };
  const finish = () => {
    streaming = false; btnSend.disabled = false;
    if (aiAvatar) aiAvatar.classList.remove('pulse');
    aiBubble.classList.remove('typing');
    input.focus();
  };
  const showError = (msg) => {
    aiBubble.innerHTML = '';
    const e = document.createElement('div');
    e.style.cssText = 'color:#dc2626;font-size:13px;';
    e.textContent = '提示：' + msg;
    aiBubble.appendChild(e);
  };
  const renderResult = (data) => {
    aiBubble.classList.remove('typing');
    if (aiAvatar) aiAvatar.classList.remove('pulse');
    if (data.type === 'image') {
      aiBubble.innerHTML = '';
      const img = document.createElement('img');
      img.src = data.url; img.className = 'gen-image'; img.alt = '生成的图片';
      aiBubble.appendChild(img);
      // 图片下载按钮：fetch 转 blob 本地保存（跨域也可靠），失败则退化为新窗口打开
      const dbtn = document.createElement('button');
      dbtn.type = 'button';
      dbtn.className = 'gen-dl-btn';
      dbtn.innerHTML = svgIcon('download', 13) + ' 下载图片';
      dbtn.onclick = async () => {
        try {
          const r = await fetch(data.url);
          const blob = await r.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'ai-image-' + Date.now() + '.png';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } catch (_) {
          window.open(data.url, '_blank');
        }
      };
      aiBubble.appendChild(dbtn);
    } else if (data.type === 'video') {
      aiBubble.innerHTML = '';
      const v = document.createElement('video');
      v.src = data.url; v.controls = true; v.className = 'gen-video';
      aiBubble.appendChild(v);
    } else if (data.type === 'audio') {
      aiBubble.innerHTML = '';
      const a = document.createElement('audio');
      a.controls = true; a.autoplay = true; a.className = 'gen-audio';
      a.src = 'data:audio/wav;base64,' + data.data;
      aiBubble.appendChild(a);
    }
  };
  try {
    // 本地对话管理：保存用户 prompt
    const conv = ensureConversation(currentConvId, currentModel);
    if (!currentConvId) {
      currentConvId = conv.id;
      const t0 = prompt.replace(/\s+/g, ' ').trim().slice(0, 12) || '新对话';
      setConvTitle(conv.id, t0); $('chat-title').textContent = t0;
    }
    appendConvMessage(currentConvId, { role: 'user', content: prompt });
    // 生成类（图片/视频/语音）仅智谱支持；若当前选的是 poixe 模型则自动用智谱对应模型
    const apiModel = String(currentModel).startsWith('poixe:')
      ? { image_gen: 'cogview-3-flash', video_gen: 'cogvideox-flash', tts: 'glm-tts' }[kind]
      : String(currentModel).replace(/^zhipu:/, '');

    if (kind === 'image_gen') {
      setHint('正在直连智谱生成图片…');
      const url = await zhipuImage(apiModel, prompt);
      renderResult({ type: 'image', url });
      appendConvMessage(currentConvId, { role: 'assistant', content: '图片：' + url });
    } else if (kind === 'video_gen') {
      setHint('正在提交视频任务…');
      const created = await zhipuVideoCreate(apiModel, prompt);
      const vid = created.id;
      let url = null;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const rj = await zhipuVideoResult(vid);
        setHint('视频生成中… ' + (rj.task_status || ''));
        if (rj.task_status === 'SUCCESS' || rj.task_status === 'FAIL') {
          if (rj.task_status === 'FAIL') throw new Error(rj.failed_reason || '视频生成失败');
          url = rj.video_result?.[0]?.url || rj.video_result?.url; break;
        }
      }
      if (!url) throw new Error('视频生成超时');
      renderResult({ type: 'video', url });
      appendConvMessage(currentConvId, { role: 'assistant', content: '视频：' + url });
    } else if (kind === 'tts') {
      setHint('正在合成语音…');
      const ab = await zhipuTTS(apiModel, prompt);
      const blob = new Blob([ab], { type: 'audio/wav' });
      const reader64 = new FileReader();
      const b64 = await new Promise((res) => { reader64.onload = () => res(reader64.result.split(',')[1]); reader64.readAsDataURL(blob); });
      renderResult({ type: 'audio', data: b64 });
      appendConvMessage(currentConvId, { role: 'assistant', content: '语音合成完成' });
    }
    await persistState();
    loadConversations();
    finalizeAIMessage(aiWrap, aiBubble);
    finish();
  } catch (e) {
    showError('生成失败：' + e.message);
    finish();
  }
}

// ========== 手机端抽屉 ==========
function openSidebar() {
  $('sidebar').classList.add('open');
  $('sidebar-mask').classList.add('show');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-mask').classList.remove('show');
}
$('btn-menu').onclick = openSidebar;
$('sidebar-mask').onclick = closeSidebar;

// ========== 账号状态行（v3.27.3：不显示后端地址） ==========
function refreshAuthLine() {
  const el = $('auth-line');
  if (!el) return;
  const a = getAuth();
  const who = a && a.user && a.user.username ? ('@' + a.user.username) : '未登录';
  el.textContent = who;
}

// ========== 注销账号（20 天冷静期，可取消） ==========
$('btn-deactivate').onclick = async () => {
  try {
    const me = await api('/api/me', { silent: true });
    if (me.deactivating) {
      // 已在冷静期，提示剩余天数 + 取消选项
      const days = Math.max(0, Math.ceil((new Date(me.deactivateAt).getTime() - Date.now()) / 86400000));
      openAppModal({
        title: '注销冷静期',
        message: `账号已提交注销申请，剩余 ${days} 天后将永久删除。期间不能使用 AI 对话。`,
        okText: '取消注销',
        cancelText: '关闭',
        onOk: async () => {
          await api('/api/deactivate', { method: 'DELETE' });
          toast('已取消注销，恢复使用', 'success');
          location.reload();
          return true;
        },
      });
    } else {
      openAppModal({
        title: '注销账号',
        message: '提交后进入 20 天冷静期，期间不能使用 AI 对话。冷静期内可随时取消。',
        okText: '确认注销',
        onOk: async () => {
          await api('/api/deactivate', { method: 'POST' });
          toast('已提交注销申请', 'success');
          location.reload();
          return true;
        },
      });
    }
  } catch (e) { toast(e.message, 'error'); }
};

// ========== 状态 UI（v3.27：不再本地禁用，仅显示本地对话数） ==========
function refreshBanUI() {
  const line = $('ban-info-line');
  if (line) line.classList.add('hidden');
}

// ========== 用户操作 ==========
$('btn-logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
};
$('btn-edit-profile').onclick = () => {
  openAppModal({
    title: '编辑昵称',
    message: '输入新昵称：',
    input: true,
    defaultValue: currentUser.nickname,
    okText: '保 存',
    onOk: async (nickname) => {
      if (!nickname) { $('am-error').textContent = '昵称不能为空'; return false; }
      await api('/api/profile', { method: 'POST', body: JSON.stringify({ nickname }) });
      currentUser.nickname = nickname;
      $('user-nickname').textContent = nickname;
      $('user-avatar').textContent = nickname.slice(0, 1).toUpperCase();
      toast('昵称已更新', 'success');
    },
  });
};

// ========== 绑定邮箱 ==========
function openBindEmailModal() {
  $('bind-email-input').value = currentUser.email || '';
  $('bind-password-input').value = '';
  $('bind-error').textContent = '';
  $('email-modal').classList.remove('hidden');
  setTimeout(() => $('bind-email-input').focus(), 50);
}
function closeBindEmailModal() {
  $('email-modal').classList.add('hidden');
}
$('btn-bind-email').onclick = openBindEmailModal;
$('btn-bind-cancel').onclick = closeBindEmailModal;
$('email-modal').onclick = (e) => { if (e.target === $('email-modal')) closeBindEmailModal(); };
async function submitBindEmail() {
  const email = $('bind-email-input').value.trim();
  const password = $('bind-password-input').value;
  $('bind-error').textContent = '';
  try {
    const data = await api('/api/bind-email', { method: 'POST', body: JSON.stringify({ email, password }) });
    currentUser.email = data.email;
    $('user-email').textContent = data.email;
    $('btn-bind-email').innerHTML = svgIcon('edit', 12) + ' 修改邮箱';
    closeBindEmailModal();
  } catch (err) {
    $('bind-error').textContent = err.message;
  }
}
$('btn-bind-confirm').onclick = submitBindEmail;
$('bind-email-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('bind-password-input').focus(); } });
$('bind-password-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitBindEmail(); } });

// ========== 消息区事件委托：点击用户消息可修改 + 代码块复制/下载/预览 ==========
$('messages').addEventListener('click', (e) => {
  const userMsg = e.target.closest('.msg.user');
  if (userMsg && !userMsg.dataset.editing) {
    userMsg.dataset.editing = '1';
    startEditUserMessage(userMsg);
    return;
  }
  const codeBtn = e.target.closest('.code-actions .code-act');
  if (codeBtn) {
    handleCodeAction(codeBtn);
    return;
  }
});

// ========== 启动（v3.27.2：邮箱登录，封禁状态从后端获取） ==========
(async () => {
  await silentLoad();
  await persistState().catch(() => {});
  try { reportEvent('app_open', { model: currentModel }); } catch (_) {}

  const saved = getAuth();
  if (saved && saved.token) {
    try {
      const me = await api('/api/me', { silent: true });
      // 后端下发封禁状态
      if (me && (me.banned || me.ban)) {
        showBanDialogFromServer(me.ban || me);
        return;   // 不进入应用，停留在登录页
      }
      const user = { ...me, token: saved.token };
      saveAuthFromUser(user);
      await afterLogin(user);
      return;
    } catch (e) {
      // token 失效或后端不可达 → 回登录页
      setAuth(null);
    }
  }
  authScreen.classList.remove('hidden');
  app.classList.add('hidden');
})();

// 后端下发的封禁弹窗
function showBanDialogFromServer(ban) {
  authScreen.classList.remove('hidden');
  app.classList.add('hidden');
  openAppModal({
    title: '账号已被封禁',
    message: (ban.reason || '账号违反使用规则') +
      (ban.daysLeft ? '\n剩余天数：' + ban.daysLeft + ' 天' : ''),
    okText: '我知道了',
    onOk: () => true,
  });
}

// v3.27.2：仅邮箱登录，本地账号入口已移除
$('btn-guest').onclick = async () => {
  toast('请使用邮箱登录', 'info');
};

// 游客模式点击登录 → 弹出登录/注册；也可用于游客额度用尽时引导登录
function openLoginModal() {
  authMode = 'login';
  renderAuthTabs();
  authScreen.classList.remove('hidden');
}
$('btn-login').onclick = () => openLoginModal();

// ========== 定时刷新后端状态（额度/封禁） ==========
const backendBanner = $('backend-banner');
let backendDown = false;
async function pingBackend() {
  try {
    refreshSpendDisplay();
  } catch (e) {}
}

// ========== 联网三态开关点击 ==========
$('auto-web-toggle').onclick = cycleWebMode;
refreshWebToggleUI();

setInterval(pingBackend, 30000);
pingBackend();

// ============ 设置面板 ============
let sandboxMode = 'native';
let autoExec = true;
try {
  sandboxMode = localStorage.getItem('aichat-sandbox-mode') || 'native';
  autoExec = localStorage.getItem('aichat-auto-exec') !== '0';
} catch (_) {}

$('btn-settings').onclick = () => {
  $('settings-modal').classList.remove('hidden');
  document.querySelectorAll('input[name="sandbox-mode"]').forEach(r => {
    r.checked = r.value === sandboxMode;
  });
  $('setting-auto-exec').checked = autoExec;
};
$('settings-close').onclick = () => $('settings-modal').classList.add('hidden');
$('settings-modal').addEventListener('click', e => {
  if (e.target === $('settings-modal')) $('settings-modal').classList.add('hidden');
});
document.querySelectorAll('input[name="sandbox-mode"]').forEach(r => {
  r.onchange = () => {
    sandboxMode = r.value;
    try { localStorage.setItem('aichat-sandbox-mode', sandboxMode); } catch (_) {}
    toast('沙箱模式已切换为：' + (sandboxMode === 'proot' ? 'Proot Linux' : '原生 Linux'), 'success');
  };
});
$('setting-auto-exec').onchange = (e) => {
  autoExec = e.target.checked;
  try { localStorage.setItem('aichat-auto-exec', autoExec ? '1' : '0'); } catch (_) {}
};
$('btn-install-proot').onclick = async () => {
  toast('正在安装 Proot 环境…', 'info', 2000);
  try {
    const sb = await getSandbox();
    if (!sb) { toast('沙箱不可用（需手机端）', 'error'); return; }
    await sb.exec({ cmd: 'pkg install -y proot proot-distro 2>&1 | tail -5', timeout: 120000 });
    toast('Proot 安装完成，可在终端运行 proot-distro install ubuntu', 'success', 4000);
  } catch (e) {
    toast('安装失败：' + e.message, 'error', 4000);
  }
};

// ============ 浮动终端 ============
let fabTerm = null;
async function initFloatingTerminal() {
  if (!IS_NATIVE) return;
  const fab = document.getElementById('term-fab');
  const modal = document.getElementById('term-modal');
  const body = document.getElementById('term-modal-body');
  const input = document.getElementById('term-modal-input');
  const tabsEl = document.getElementById('term-tabs');

  // 登录状态判断：未登录时隐藏 FAB
  // 本地终端是纯本地能力，与登录态无关；此前按 currentUser 判断，
  // 对话一次后 /api/me 被刷新为 guest/null，按钮就整块消失了
  function refreshFabVisibility() {
    // 终端只在原生端且已登录账号时提供：游客/本地模式/无有效 token 都不暴露入口
    if (!IS_NATIVE) { fab.classList.add('hidden'); return; }
    const loggedIn = !!(currentUser && !currentUser.guest && !currentUser.local && authToken());
    if (!loggedIn) { fab.classList.add('hidden'); return; }
    fab.classList.remove('hidden');
  }
  window.addEventListener('aichat:auth-changed', refreshFabVisibility);
  refreshFabVisibility();

  // FAB 拖动 + 自动靠边
  let dragging = false, dragMoved = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
  fab.style.position = 'fixed';
  fab.style.right = '16px';
  fab.style.bottom = '80px';
  fab.addEventListener('touchstart', (e) => {
    dragging = true; dragMoved = false;
    fab.classList.add('dragging');
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    const r = fab.getBoundingClientRect();
    origLeft = r.left; origTop = r.top;
    fab.style.right = 'auto'; fab.style.bottom = 'auto';
    fab.style.left = origLeft + 'px';
    fab.style.top = origTop + 'px';
  }, { passive: true });
  fab.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    const dx = t.clientX - startX, dy = t.clientY - startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragMoved = true;
    fab.style.left = (origLeft + dx) + 'px';
    fab.style.top = (origTop + dy) + 'px';
  }, { passive: true });
  fab.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    fab.classList.remove('dragging');
    if (!dragMoved) { fab.click(); return; }
    // 自动靠边：吸附到最近的左右边
    const r = fab.getBoundingClientRect();
    const midX = window.innerWidth / 2;
    if (r.left + r.width / 2 < midX) {
      fab.style.left = '16px';
    } else {
      fab.style.left = (window.innerWidth - r.width - 16) + 'px';
    }
  });

  // 首次安装完成提示只显示一次
  let _bootNoticeShown = false;
  // 多窗口状态
  let sessions = [];
  let activeIdx = -1;
  // 修饰键状态
  const mods = { CTRL: false, ALT: false, SHIFT: false };
  // 命令历史（每个会话独立）
  let histIdx = -1;

  // apt/dpkg 进度段（含下载进度 "45% [9 clang 28.5 MB/30.7 MB 93%]"）
  const LIVE_LINE = /^((Reading database|Reading package lists|Building dependency tree|Reading state information|Building data structures|Processing triggers for)\s*\.\.\.|Progress: |Unpacking |Preparing to unpack |\d+% \[|\d+% \()/;

  function makeSession(idx) {
    const s = {
      id: idx, name: '终端 ' + (idx + 1), cwd: '', busy: false,
      history: [],
      el: document.createElement('div'),
      _curLine: null,
      _liveEl: null,
      line(text, cls) {
        const d = document.createElement('div');
        if (cls) d.className = cls;
        d.textContent = text;
        d.style.whiteSpace = 'pre-wrap';
        this.el.appendChild(d);
        this._curLine = null;
        trimSession(this.el);
        if (!hasSelectionIn(this.el)) this.el.scrollTop = this.el.scrollHeight;
      },
      /** 行级语义分类：警告黄、错误红、apt 动作绿（与 Termux 观感一致） */
      classify(txt, stream) {
        const t = txt || '';
        if (/^(dpkg: warning|dpkg-deb: warning|W:|warning:|Ign:)/i.test(t)) return 'term-warn';
        if (/^(dpkg: error|dpkg-deb: error|E:|error:|Errors were encountered|Unable to locate)/i.test(t)
            || /(bad interpreter|command not found|returned an error code|Aborted|Bad system call)/i.test(t)) return 'term-err';
        if (/^(Get:|Fetched|Selecting previously|Unpacking|Setting up|Preparing to unpack|Processing triggers|Configuring|Building|Creating config|Need to get|After this operation)/i.test(t)
            || /^\d+% \[/.test(t) || /\d+%\)?$/.test(t)) return 'term-ok';
        if (stream === 'stderr') return 'term-err';
        if (stream === 'system') return 'term-sys';
        return '';
      },
      write(text, cls, stream) {
        const raw = String(text == null ? '' : text);
        const parts = raw.split('\n');
        parts.forEach((part, i) => {
          if (i > 0) this._curLine = null;
          if (!part) return;
          // apt 的进度段用 \r 原地刷新（Reading database ... 50% / 45% [9 clang ...]），
          // 逐条落地会刷满整屏，这里识别为活动行并就地覆盖
          if (LIVE_LINE.test(part)) {
            if (!this._liveEl || !this.el.contains(this._liveEl)) {
              this._liveEl = document.createElement('div');
              this._liveEl.style.whiteSpace = 'pre-wrap';
              this._liveEl.className = 'term-ok';
              this.el.appendChild(this._liveEl);
            }
            // 进度行只用一行：整体绿色，末尾百分比再提亮，效果与 Termux 一致
            const pm = /^(.*?)(\d+%|Done)\s*$/.exec(part);
            if (pm) {
              this._liveEl.innerHTML = escapeHtml(pm[1]) +
                '<span class="term-pct">' + escapeHtml(pm[2]) + '</span>';
            } else {
              this._liveEl.textContent = part;
            }
            this._liveEl.className = (cls || this.classify(part, stream)) || 'term-ok';
            this._curLine = this._liveEl;
            return;
          }
          this._liveEl = null;
          if (!this._curLine) {
            this._curLine = document.createElement('div');
            this._curLine.style.whiteSpace = 'pre-wrap';
            this.el.appendChild(this._curLine);
          }
          const span = document.createElement('span');
          const klass = cls || this.classify(part, stream || 'stdout');
          if (klass) span.className = klass;
          span.textContent = part;
          this._curLine.appendChild(span);
        });
        trimSession(this.el);
        if (!hasSelectionIn(this.el)) this.el.scrollTop = this.el.scrollHeight;
      },
      /** 按原生 SGR 片段渲染，颜色完全由程序输出决定，不做文本猜测 */
      renderRunsInto(container, runs) {
        for (let i = 0; i < runs.length; i++) {
          const r = runs[i];
          const span = document.createElement('span');
          if (typeof r === 'string') {
            span.textContent = r;
          } else if (r) {
            if (typeof r.c === 'number' && r.c >= 0) span.className = 'tc-' + r.c;
            span.textContent = r.t || '';
          }
          if (span.textContent) container.appendChild(span);
        }
      },
      /** 活动行（\r 重绘中的那一行）：覆盖同一个 div */
      progressRuns(runs) {
        if (!this._liveEl || !this.el.contains(this._liveEl)) {
          this._liveEl = document.createElement('div');
          this._liveEl.style.whiteSpace = 'pre-wrap';
          this.el.appendChild(this._liveEl);
        }
        this._liveEl.innerHTML = '';
        this.renderRunsInto(this._liveEl, runs);
        this._curLine = this._liveEl;
        trimSession(this.el);
        if (!hasSelectionIn(this.el)) this.el.scrollTop = this.el.scrollHeight;
      },
      /** fin=true：这一行结束，固化为独立行；fin=false 等同活动行更新 */
      pushRuns(stream, runs, fin) {
        if (!fin) { this.progressRuns(runs); return; }
        if (this._liveEl && this.el.contains(this._liveEl)) {
          this._liveEl.innerHTML = '';
          this.renderRunsInto(this._liveEl, runs);
          this._liveEl = null;
        } else {
          const d = document.createElement('div');
          d.style.whiteSpace = 'pre-wrap';
          this.renderRunsInto(d, runs);
          this.el.appendChild(d);
        }
        this._curLine = null;
        trimSession(this.el);
        if (!hasSelectionIn(this.el)) this.el.scrollTop = this.el.scrollHeight;
      },
      /** 原生 progress 通道：同一进度行原地更新，不再逐行落地 */
      progress(text) {
        const part = String(text == null ? '' : text).replace(/\r/g, '');
        if (!part.trim()) return;
        if (!this._liveEl || !this.el.contains(this._liveEl)) {
          this._liveEl = document.createElement('div');
          this._liveEl.style.whiteSpace = 'pre-wrap';
          this._liveEl.className = 'term-ok';
          this.el.appendChild(this._liveEl);
        }
        const pm = /^(.*?)(\d+%|Done)\s*$/.exec(part);
        if (pm) {
          this._liveEl.innerHTML = escapeHtml(pm[1]) +
            '<span class="term-pct">' + escapeHtml(pm[2]) + '</span>';
        } else {
          this._liveEl.className = 'term-ok';
          this._liveEl.textContent = part;
        }
        this._curLine = this._liveEl;
        trimSession(this.el);
        if (!hasSelectionIn(this.el)) this.el.scrollTop = this.el.scrollHeight;
      },
      cmd(c) { this.line('$ ' + c, 'term-cmd'); },
      pushStream(stream, text) {
        // pty 输出含 ANSI 与 readline 的括号粘贴序列，ESC 被桥接层吃掉后只剩裸 "[?2004h"
        const clean = String(text == null ? '' : text)
          .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
          .replace(/\x1b\][^\x07\n]*\x07/g, '')
          .replace(/\[\d+(?:;\d+)*m/g, '')
          .replace(/\[?\??2004[hl]/g, '')
          .replace(/\[\?\d*[hl]/g, '')
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
          .replace(/\r/g, '');
        if (!clean) return;
        this.write(clean, '', stream);
      },
    };
    s.el.className = 'term-session';
    s.line('Termux 终端已就绪 v' + (window.__APP_VER || '?') + '，输入命令开始使用', 'term-sys');
    return s;
  }

  // 终端节点上限：apt update 一类命令输出上千行，节点无限增长会拖垮 WebView；
  // 用户正在选词时不做删除，避免选择锚点被移除（Android WebView 在选区节点被销毁时易崩）
  const TERM_MAX_LINES = 1200;
  function trimSession(el) {
    if (hasSelectionIn(el)) return;
    while (el.childNodes.length > TERM_MAX_LINES) el.removeChild(el.firstChild);
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    sessions.forEach((s, i) => {
      const tab = document.createElement('div');
      tab.className = 'term-tab' + (i === activeIdx ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'term-tab-name';
      name.textContent = s.name;
      name.onclick = () => switchSession(i);
      const close = document.createElement('button');
      close.className = 'term-tab-close';
      close.textContent = '✕';
      close.title = '关闭此窗口';
      close.onclick = (e) => { e.stopPropagation(); closeSession(i); };
      tab.appendChild(name);
      if (sessions.length > 1) tab.appendChild(close);
      tabsEl.appendChild(tab);
    });
  }

  function switchSession(i) {
    if (activeIdx >= 0 && sessions[activeIdx]) body.removeChild(sessions[activeIdx].el);
    activeIdx = i;
    body.appendChild(sessions[i].el);
    renderTabs();
    input.focus();
  }

  function closeSession(i) {
    const s = sessions[i];
    if (s.busy) { s.line('命令正在执行，无法关闭', 'term-err'); return; }
    body.removeChild(s.el);
    sessions.splice(i, 1);
    if (sessions.length === 0) {
      closeModal();
      return;
    }
    if (activeIdx >= sessions.length) activeIdx = sessions.length - 1;
    else if (activeIdx > i) activeIdx--;
    body.appendChild(sessions[activeIdx].el);
    renderTabs();
  }

  // ---- 运行态控制：结束命令按钮 ----
  const stopRow = document.getElementById('term-stop-row');
  function updateStopBar() {
    if (!stopRow) return;
    const running = sessions.some(s => s.busy);
    stopRow.classList.toggle('hidden', !running);
    // 供 beforeunload 使用（sessions 是闭包内变量）
    window.__termAnyBusy = running;
  }
  async function stopAllCommands(silent) {
    // 屏幕模式下命令跑在持久 pty 里，SIGINT 只能靠写 ^C
    if (screenStarted && termRenderMode() === 'screen') {
      await sendScreen('\x03');
      sessions.forEach(s => { s.busy = false; });
      updateStopBar();
      if (!silent) toast('已发送 Ctrl+C', 'info', 2000);
      return true;
    }
    const running = sessions.filter(s => s.busy);
    if (!running.length) return false;
    try {
      const sb = getSandbox();
      if (sb && sb.kill) await sb.kill();
    } catch (_) {}
    running.forEach(s => { s.busy = false; s.line('^C', 'term-err'); });
    updateStopBar();
    if (!silent) toast('已结束当前命令');
    return true;
  }
  const stopBtn = document.getElementById('term-stop-btn');
  if (stopBtn) stopBtn.onclick = () => stopAllCommands(false);

  let _indexAskPending = false;
  const INDEX_FLAG = 'aichat-index-synced';
  function indexSynced() { try { return localStorage.getItem(INDEX_FLAG) === '1'; } catch (_) { return false; } }
  function markIndexSynced() { try { localStorage.setItem(INDEX_FLAG, '1'); } catch (_) {} }
  async function askSyncIndex(session) {
    if (!session || _indexAskPending) return;
    // 只在装好后的第一次询问，之后不再每次启动都弹
    if (indexSynced()) return;
    _indexAskPending = true;
    try {
      const ok = await uiConfirm('是否立即同步软件源索引（apt update）？同步后才能安装软件包。', '立即同步', '稍后');
      if (!ok) {
        markIndexSynced();
        session.line('已跳过索引同步，可随时手动执行 apt update', 'term-sys');
        return;
      }
      session.line('正在同步软件源索引…', 'term-sys');
      session.busy = true; updateStopBar();
      try {
        await sandboxRun(session, 'apt update', { cwd: session.cwd || '', timeout: 300000 });
        markIndexSynced();
      } finally {
        session.busy = false; updateStopBar();
      }
    } catch (e) {
      session.line('索引同步失败：' + e.message, 'term-err');
    } finally {
      _indexAskPending = false;
    }
  }

  function newSession() {
    if (activeIdx >= 0 && sessions[activeIdx]) body.removeChild(sessions[activeIdx].el);
    const s = makeSession(sessions.length);
    sessions.push(s);
    activeIdx = sessions.length - 1;
    body.appendChild(s.el);
    s.el.style.animation = 'termFadeIn .2s ease-out';
    renderTabs();
    const newTab = tabsEl.lastElementChild;
    if (newTab) newTab.style.animation = 'tabSlideIn .2s ease-out';
    input.focus();
    return s;
  }

  // ============ Termux 屏幕模式：terminal-emulator 的 VT 屏幕在 WebView 里渲染 ============
  const RENDER_MODE_KEY = 'aichat-term-render';
  let screenStarted = false, screenEl = null, screenCursor = null;
  let screenCols = 80, screenRows = 24;
  const screenLineH = 18;
  let screenCharW = 7.8;

  // 屏幕模式（原生 Canvas 网格）在多数机型上无法稳定输入与刷新，已下线：一律列表模式
  function termRenderMode() { return 'list'; }

  const XTERM_16 = ['#0b0b0d', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
                    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
  function xtermColor(i) {
    if (i == null || i < 0) return null;
    if (i < 16) return XTERM_16[i];
    if (i < 232) {
      const n = i - 16, r = Math.floor(n / 36), g = Math.floor((n % 36) / 6), b = n % 6;
      const lv = [0, 95, 135, 175, 215, 255];
      return 'rgb(' + lv[r] + ',' + lv[g] + ',' + lv[b] + ')';
    }
    const g = 8 + (i - 232) * 10;
    return 'rgb(' + g + ',' + g + ',' + g + ')';
  }

  function measureChar() {
    try {
      const probe = document.createElement('span');
      probe.textContent = 'MMMMMMMMMM';
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:18px';
      document.body.appendChild(probe);
      const w = probe.getBoundingClientRect().width / 10;
      probe.remove();
      if (w > 3) screenCharW = w;
    } catch (_) {}
  }

  function ensureScreenEl() {
    if (screenEl && document.body.contains(screenEl)) return screenEl;
    screenEl = document.createElement('div');
    screenEl.id = 'term-screen';
    screenEl.className = 'term-screen hidden';
    body.parentNode.insertBefore(screenEl, body.nextSibling);
    screenCursor = document.createElement('div');
    screenCursor.className = 'ts-cursor';
    screenEl.appendChild(screenCursor);
    measureChar();
    return screenEl;
  }

  let lastScreenAt = 0;
  function renderScreen(ev) {
    if (!ev) return;
    lastScreenAt = Date.now();
    const el = ensureScreenEl();
    if (ev.cols) screenCols = ev.cols;
    if (ev.rows) screenRows = ev.rows;
    if (el.dataset.rows !== String(screenRows)) {
      el.querySelectorAll('.ts-row').forEach(n => n.remove());
      for (let r = 0; r < screenRows; r++) {
        const d = document.createElement('div');
        d.className = 'ts-row';
        el.appendChild(d);
      }
      el.dataset.rows = String(screenRows);
    }
    const rows = el.querySelectorAll('.ts-row');
    (ev.lines || []).forEach(item => {
      const row = rows[item.r];
      if (!row) return;
      row.textContent = '';
      (item.runs || []).forEach(run => {
        const span = document.createElement('span');
        if (typeof run === 'string') {
          span.textContent = run;
        } else if (run) {
          span.textContent = run.t || '';
          if (typeof run.fg === 'number' && run.fg >= 0) span.style.color = xtermColor(run.fg);
          if (typeof run.bg === 'number' && run.bg >= 0) span.style.background = xtermColor(run.bg);
          if (run.b) span.style.fontWeight = '700';
        }
        if (span.textContent) row.appendChild(span);
      });
    });
    if (screenCursor) {
      screenCursor.style.display = ev.cursorVisible === false ? 'none' : 'block';
      screenCursor.style.transform = 'translate(' + ((ev.cursorCol || 0) * screenCharW) + 'px,' + ((ev.cursorRow || 0) * screenLineH) + 'px)';
    }
  }

  // 事件通道仍以 notifyListeners 为主，轮询只做兜底：某些机型 WebView 事件节流会让屏幕停在首帧
  let screenPollTimer = null;
  function startScreenPoll() {
    if (screenPollTimer) return;
    screenPollTimer = setInterval(async () => {
      if (termRenderMode() !== 'screen' || !screenStarted) return;
      const modal = document.getElementById('term-modal');
      if (!modal || modal.classList.contains('hidden')) return;
      try {
        const sb = await ensureSandbox();
        if (sb && typeof sb.termScreen === 'function') {
          const snap = await sb.termScreen({ full: false });
          if (snap) renderScreen(snap);
        }
      } catch (_) {}
    }, 400);
  }

  function applyRenderMode() {
    const el = ensureScreenEl();
    const mode = termRenderMode();
    if (mode === 'screen') {
      el.classList.remove('hidden');
      body.classList.add('hidden');
      // 切到屏幕模式时若 pty 未启动或已退出，重新拉起；否则只做一次 resize
      setTimeout(() => { if (!screenStarted) startScreenShell(); }, 30);
    } else {
      el.classList.add('hidden');
      body.classList.remove('hidden');
      const act = sessions[activeIdx];
      if (act && !(act.el.textContent || '').trim()) {
        act.line('环境已就绪，输入命令开始使用', 'term-ok');
      }
    }
    const btn = document.getElementById('term-render-toggle');
    if (btn) btn.classList.add('hidden');
  }

  async function startScreenShell() {
    if (termRenderMode() !== 'screen') return;
    let sb;
    try { sb = await ensureSandbox(); } catch (_) { return; }
    if (!sb || typeof sb.termShellStart !== 'function') return;
    const el = ensureScreenEl();
    measureChar();
    screenCols = Math.max(40, Math.floor((el.clientWidth || 380) / screenCharW));
    screenRows = Math.max(14, Math.floor((el.clientHeight || 420) / screenLineH));
    if (screenStarted) {
      try { await sb.termResize({ cols: screenCols, rows: screenRows }); } catch (_) {}
      return;
    }
    try {
      await sb.termShellStart({ cols: screenCols, rows: screenRows });
      screenStarted = true;
      startScreenPoll();
      if (typeof sb.termScreen === 'function') {
        sb.termScreen().then(renderScreen).catch(() => {});
      }
      setTimeout(async () => {
        const el = ensureScreenEl();
        if ((el.textContent || '').trim()) return;
        // 空屏兜底：pty 可能已退出但 screenStarted 还是 true，强制重启一次
        if (screenStarted && Date.now() - lastScreenAt > 1500) {
          try { await sb.termShellStop(); } catch (_) {}
          screenStarted = false;
          setTimeout(() => startScreenShell(), 120);
          return;
        }
        screenHint('pty 已启动但没有输出：切到「列表模式」可回到逐行输出，请把设备型号反馈给我定位');
      }, 1800);
    } catch (e) {
      screenHint('启动 pty 失败：' + (e && e.message ? e.message : e));
      toast('终端 pty 启动失败：' + (e && e.message ? e.message : e), 'error', 5000);
    }
  }

  function screenHint(msg) {
    const el = ensureScreenEl();
    const d = document.createElement('div');
    d.className = 'ts-hint';
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  let idleTimer = null;
  function idleWatch() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      const running = sessions.filter(s => s.busy);
      if (!running.length) return;
      if (Date.now() - lastScreenAt < 700) { idleWatch(); return; }  // 仍在输出，继续等
      running.forEach(s => { s.busy = false; });
      updateStopBar();
    }, 900);
  }

  async function sendScreen(data) {
    try {
      const sb = await ensureSandbox();
      if (sb && typeof sb.termInput === 'function') await sb.termInput({ data: String(data) });
    } catch (_) {}
  }

  // ---------- OpenClaw Agent 运行时 ----------
  let agentReady = false;

  async function ensureAgentRuntime() {
    const sb = await ensureSandbox();
    if (!sb || typeof sb.agentStatus !== 'function') return false;
    const st = await sb.agentStatus();
    if (st && st.installed) { agentReady = true; return true; }
    const ok = await uiConfirm('首次使用需解压 OpenClaw 运行时（约 600MB，1-2 分钟，占用机身存储）。确认安装？', '安装', '取消');
    if (!ok) return false;
    try { localStorage.setItem(RENDER_MODE_KEY, 'list'); } catch (_) {}
    applyRenderMode();
    const s = sessions[sessions.length - 1];
    if (s) s.line('正在安装 OpenClaw 运行时…', 'term-sys');
    await sb.agentInit();
    const st2 = await sb.agentStatus();
    agentReady = !!(st2 && st2.installed);
    if (s) s.line(agentReady ? 'OpenClaw 运行时已就绪' : '❌ OpenClaw 运行时安装不完整', agentReady ? 'term-ok' : 'term-err');
    return agentReady;
  }

  async function configureAgent(model) {
    const sb = await ensureSandbox();
    await sb.agentConfigure({ provider: 'zhipu', model: model || 'glm-4-flash' });
  }

  window.__runAgentTask = (t, m) => runAgentTask(t, m);

  async function runAgentTask(task, model) {
    const sb = await ensureSandbox();
    const s = sessions[sessions.length - 1];
    if (s) { s.line('$ agent: ' + task, 'term-dim'); s.busy = true; updateStopBar(); }
    try {
      await configureAgent(model);
      const r = await sb.agentRun({ message: task, timeout: 240 });
      if (s) {
        if (r && r.text) s.line(r.text, 'term-ok');
        else if (r && r.code !== 0) s.line('agent 退出码 ' + r.code + '（输出见终端上方）', 'term-err');
        else s.line('agent 完成（无文本回复）', 'term-sys');
      }
      return r;
    } catch (e) {
      if (s) s.line('agent 执行失败：' + (e && e.message ? e.message : e), 'term-err');
      return null;
    } finally {
      if (s) { s.busy = false; updateStopBar(); }
    }
  }

  // ---------- 重装终端：清空 PREFIX 后重新解压 bootstrap ----------
  let reinstalling = false;
  async function reinstallTerminal() {
    if (reinstalling) return;
    const ok1 = await uiConfirm('重装终端会删除全部已安装的软件包、家目录文件与终端配置，且无法恢复。是否继续？', '继续', '取消');
    if (!ok1) return;
    const ok2 = await uiConfirm('再次确认：软件包、projects 目录与家目录文件都会被清空，确定重装？', '确定重装', '取消');
    if (!ok2) return;

    reinstalling = true;
    const btn = document.getElementById('term-reinstall');
    if (btn) { btn.disabled = true; btn.textContent = '重装中…'; }
    // 重装进度由 emit('output') 推送，只有列表模式的 DOM 能显示
    try { localStorage.setItem(RENDER_MODE_KEY, 'list'); } catch (_) {}
    applyRenderMode();
    screenStarted = false;
    let s = sessions[sessions.length - 1];
    if (!s) s = newSession();
    activeTerm = s;
    try { s.el.innerHTML = ''; } catch (_) {}
    s.line('正在重装终端环境（约 1 分钟）…', 'term-sys');

    try {
      const sb = await ensureSandbox();
      try { if (sb && typeof sb.termShellStop === 'function') await sb.termShellStop(); } catch (_) {}
      await sb.termReinstall();
      try { localStorage.removeItem('aichat-index-synced'); } catch (_) {}
      // 重装后索引为空，install 会一直 "Unable to locate package"，顺手同步一次
      s.line('正在同步软件源索引…', 'term-sys');
      try {
        await sandboxRun(s, 'apt update', { cwd: s.cwd || '', timeout: 300000 });
        markIndexSynced();
      } catch (e2) {
        s.line('索引同步失败：' + (e2 && e2.message ? e2.message : e2), 'term-err');
      }
      // termReinstall 会清空 prefix，OpenClaw 运行时（prefix/opt/openclaw）随之消失；
      // 必须重置初始化标记，让 ensureSandbox 重新走 init + agentInit
      sandboxReady = false;
      _sandboxInitPromise = null;
      s.line('正在重新安装 OpenClaw 运行时…', 'term-sys');
      try { await ensureSandbox(); } catch (e3) {
        s.line('OpenClaw 重装失败：' + (e3 && e3.message ? e3.message : e3), 'term-err');
      }
      s.line('重装完成，正在启动 shell', 'term-ok');
      toast('终端环境已重装', 'success', 3000);
    } catch (e) {
      s.line('❌ 重装失败：' + (e && e.message ? e.message : e), 'term-err');
      toast('重装失败：' + (e && e.message ? e.message : e), 'error', 5000);
    } finally {
      reinstalling = false;
      if (btn) { btn.disabled = false; btn.textContent = '重装'; }
      try { localStorage.setItem(RENDER_MODE_KEY, 'screen'); } catch (_) {}
      applyRenderMode();
      screenStarted = false;
      setTimeout(() => startScreenShell(), 500);
    }
  }

  function openModal() {
    modal.classList.remove('hidden');
    modal.classList.add('term-open');
    // 限制选区：终端打开时只有终端内文本可被选中，拖动越过边界不会选到聊天区
    document.body.classList.add('term-select-lock');
    // 回放 Agent 在终端关闭期间产生的日志
    try {
      const buf = window.__agentLogBuf;
      const cur = sessions[sessions.length - 1] || null;
      if (buf && buf.length && cur) {
        cur.line('—— OpenClaw 运行日志 ——', 'term-sys');
        buf.slice(-200).forEach(l => { if (l) cur.line(l, 'term-dim'); });
        window.__agentLogBuf = [];
      }
    } catch (_) {}
    if (sessions.length === 0) {
      const s = newSession();
      activeTerm = s;
      // 后台初始化，进度通过 output 监听器实时推送到终端
      s.line('正在初始化 Termux 环境（首次约需 1-2 分钟）…', 'term-sys');
      ensureSandbox().then(() => {
        // 首次安装完成后清掉过程报告，只在上方小窗提示一次
        if (!_bootNoticeShown) {
          _bootNoticeShown = true;
          s.el.innerHTML = '';
          s.line('环境已就绪，输入命令开始使用', 'term-ok');
          toast('Termux 环境安装完成');
        }
        // 环境就绪后再询问同步索引，避免沙箱未起时执行必然失败
        setTimeout(() => askSyncIndex(s), 300);
      }).catch((e) => {
        s.line('❌ ' + e.message, 'term-err');
      });
    }
    applyRenderMode();
    setTimeout(() => input.focus(), 150);
    activeTerm = sessions[activeIdx];
  }

  // apt/dpkg 询问确认时给用户明确入口（pty 下提示文本不显眼，且输入框默认无焦点）
  window.__termAskConfirm = () => {
    if (window.__askConfirmAt && Date.now() - window.__askConfirmAt < 2500) return;
    window.__askConfirmAt = Date.now();
    toast('命令在等待确认：在输入框敲 y 回车继续，n 取消', 'info', 5000);
    const modal = document.getElementById('term-modal');
    const visible = modal && !modal.classList.contains('hidden');
    const target = visible ? document.getElementById('term-modal-input') : document.getElementById('input');
    if (target) { try { target.focus(); target.scrollIntoView({ block: 'nearest' }); } catch (_) {} }
  };

  // ---------- OpenClaw 设置（记忆 / 工作区文件 / 原始配置） ----------
  let ocFilesCache = {};
  const ocModal = document.getElementById('oc-settings-modal');
  const ocFileSel = document.getElementById('oc-file-select');
  const ocFileBody = document.getElementById('oc-file-body');
  const ocCfgBody = document.getElementById('oc-config-body');
  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  async function openOcSettings() {
    const sb = await ensureSandbox();
    if (!sb || typeof sb.agentSettingsGet !== 'function') { toast('当前版本不支持 OpenClaw 设置', 'error', 3000); return; }
    try {
      const r = await sb.agentSettingsGet();
      $('oc-settings-path').textContent = (r.workspacePath || '') + '\n' + (r.configPath || '');
      $('oc-mem-size').textContent = fmtBytes(r.memoryBytes || 0);
      ocFilesCache = r.files || {};
      const modelSel = document.getElementById('oc-agent-model');
      if (modelSel) {
        const models = LOCAL_MODELS.filter(x => x.kind === 'chat' && String(x.id).startsWith('zhipu:'));
        let cur = '';
        try { cur = localStorage.getItem('aichat-agent-model') || ''; } catch (_) {}
        modelSel.innerHTML = models.map(x => `<option value="${x.id.split(':')[1]}">${x.name}</option>`).join('');
        const curId = cur.split(':')[1] || 'glm-4-flash';
        modelSel.value = models.some(x => x.id.split(':')[1] === curId) ? curId : 'glm-4-flash';
        const cfgModel = (String(r.config || '').match(/"model"\s*:\s*"zhipu\/([^"]+)"/) || [])[1];
        if (cfgModel && models.some(x => x.id.split(':')[1] === cfgModel)) modelSel.value = cfgModel;
      }
      ocFileSel.value = 'AGENTS.md';
      ocFileBody.value = ocFilesCache['AGENTS.md'] || '';
      ocCfgBody.value = r.config || '';
      ocModal.classList.remove('hidden');
    } catch (e) {
      toast('读取 OpenClaw 设置失败：' + (e && e.message ? e.message : e), 'error', 4000);
    }
  }
  window.__openOcSettings = openOcSettings;
  const ocQuickBtn = document.getElementById('oc-quick-settings');
  if (ocQuickBtn) ocQuickBtn.addEventListener('click', (e) => { e.stopPropagation(); openOcSettings(); });
  const ocSettingsBtn = document.getElementById('term-settings');
  if (ocSettingsBtn) ocSettingsBtn.addEventListener('click', (e) => { e.stopPropagation(); openOcSettings(); });
  if (ocFileSel) {
    ocFileSel.onchange = () => {
      ocFilesCache[ocFileSel.value] = ocFileBody.value;
      ocFileBody.value = ocFilesCache[ocFileSel.value] || '';
    };
  }
  if (ocFileBody) ocFileBody.oninput = () => { ocFilesCache[ocFileSel.value] = ocFileBody.value; };
  if (ocModal) {
    document.getElementById('oc-settings-cancel').onclick = () => ocModal.classList.add('hidden');
    document.getElementById('oc-settings-save').onclick = async () => {
      const sb = await ensureSandbox();
      try {
        const modelSel = document.getElementById('oc-agent-model');
        if (modelSel && modelSel.value) {
          await sb.agentConfigure({ provider: 'zhipu', model: modelSel.value });
          try { localStorage.setItem('aichat-agent-model', 'zhipu:' + modelSel.value); } catch (_) {}
        }
        await sb.agentSettingsSave({ config: ocCfgBody.value, files: ocFilesCache });
        toast('OpenClaw 设置已保存，下次执行 Agent 生效', 'success', 3000);
        ocModal.classList.add('hidden');
      } catch (e) {
        toast('保存失败：' + (e && e.message ? e.message : e), 'error', 4000);
      }
    };
    document.getElementById('oc-mem-clear').onclick = async () => {
      const sb = await ensureSandbox();
      const ok = await uiConfirm('清空 OpenClaw 的长期记忆与向量索引？AI 将忘记此前积累的偏好与事实。', '清空', '取消');
      if (!ok) return;
      try {
        const r = await sb.agentMemoryClear();
        $('oc-mem-size').textContent = '0 B';
        toast('已清空 ' + (r && r.removed ? r.removed + ' 项' : '记忆'), 'success', 2500);
      } catch (e) {
        toast('清空失败：' + (e && e.message ? e.message : e), 'error', 4000);
      }
    };
  }

  const agentBtn = document.getElementById('term-agent');
  if (agentBtn) agentBtn.onclick = async () => {
    if (agentBtn.disabled) return;
    agentBtn.disabled = true;
    try {
      const ready = await ensureAgentRuntime();
      if (!ready) return;
      const task = await uiPrompt('交给 OpenClaw 执行的任务（在终端内运行，模型请求走后端）', '例如：查看当前目录结构并安装 python');
      if (!task) return;
      await runAgentTask(task);
    } finally { agentBtn.disabled = false; }
  };

  const reinstallBtn = document.getElementById('term-reinstall');
  if (reinstallBtn) reinstallBtn.onclick = () => { reinstallTerminal(); };

  const renderToggle = document.getElementById('term-render-toggle');
  if (renderToggle) {
    renderToggle.onclick = () => {
      try { localStorage.setItem(RENDER_MODE_KEY, termRenderMode() === 'screen' ? 'list' : 'screen'); } catch (_) {}
      applyRenderMode();
      if (termRenderMode() === 'screen') startScreenShell();
    };
  }

  // 供消息里的“执行”按钮直接投递到终端
  window.__runInTerminal = async (cmd) => {
    if (!IS_NATIVE) { toast('终端仅在手机端可用', 'error'); return; }
    openModal();
    let s = sessions[sessions.length - 1];
    if (!s) s = newSession();
    activeTerm = s;
    if (termRenderMode() === 'screen') {
      await startScreenShell();
      await sendScreen(cmd + '\r');
      return;
    }
    s.line('$ ' + cmd, 'term-dim');
    // openclaw 的 doctor/configure 会画 TUI，pty + ANSI 光标定位在本终端里会退化成逐字符换行，
    // 用 TERM=dumb 让上游按纯文本流输出
    let execCmd = cmd;
    if (/^\s*openclaw\b/.test(execCmd)) execCmd = 'TERM=dumb NO_COLOR=1 ' + execCmd;
    try {
      await sandboxRun(s, execCmd, { cwd: s.cwd || '', timeout: 300000, noAutoYes: true, interactive: true });
    } catch (err) {
      s.line('执行失败：' + err.message, 'term-err');
    }
  };

  async function closeModal() {
    // 关闭只是收起面板：命令继续在后台执行，结果仍会写回会话；
    // 需要终止时用命令行内的「停止」或工具栏「重装」
    modal.classList.add('term-closing');
    setTimeout(() => {
      modal.classList.add('hidden');
      document.body.classList.remove('term-select-lock');
      modal.classList.remove('term-open', 'term-closing');
    }, 180);
    activeTerm = null;
    updateStopBar();
  }

  fab.onclick = openModal;
  document.getElementById('term-modal-close').onclick = closeModal;
  document.getElementById('term-new-tab').onclick = () => {
    newSession();
    input.focus();
  };

  // 控制键
  document.querySelectorAll('.term-keys .tk').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.k;
      if (btn.classList.contains('toggle')) {
        mods[k] = !mods[k];
        btn.classList.toggle('active', mods[k]);
        input.focus();
        return;
      }
      if (screenStarted && termRenderMode() === 'screen') {
        const seq = {
          ESC: '\x1b', TAB: '\t', UP: '\x1b[A', DOWN: '\x1b[B', LEFT: '\x1b[D', RIGHT: '\x1b[C',
          HOME: '\x1b[H', END: '\x1b[F', PGUP: '\x1b[5~', PGDN: '\x1b[6~',
        }[k];
        if (seq) { void sendScreen(seq); input.focus(); return; }
      }
      // 特殊键直接发送到输入框
      const keyMap = {
        UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
        HOME: 'Home', END: 'End', PGUP: 'PageUp', PGDN: 'PageDown',
      };
      if (keyMap[k]) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: keyMap[k], bubbles: true }));
      } else if (k === 'ESC') {
        input.value = '';
        input.focus();
      } else if (k === 'TAB') {
        // 简单补全：插入空格或触发输入
        const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
        input.dispatchEvent(ev);
      }
      input.focus();
    });
  });

  function resetMods() {
    mods.CTRL = mods.ALT = mods.SHIFT = false;
    document.querySelectorAll('.term-keys .tk.toggle').forEach(b => b.classList.remove('active'));
  }

  input.addEventListener('keydown', async (e) => {
    const cur = sessions[activeIdx];
    if (!cur) return;

    // 屏幕模式但 shell 没起来：回车时现场拉起，成功后再补发这一行
    if (termRenderMode() === 'screen' && !screenStarted && e.key === 'Enter') {
      e.preventDefault();
      const pending = input.value;
      input.value = '';
      if (!pending) return;
      screenHint('shell 未启动，正在启动…');
      await startScreenShell();
      if (screenStarted) await sendScreen(pending + '\r');
      else { input.value = pending; screenHint('shell 启动失败：切到「列表模式」可继续用'); }
      return;
    }

    // 屏幕模式：pty 自己回显与行编辑，这里只负责把按键/整行送进 shell
    if (screenStarted && termRenderMode() === 'screen') {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value;
        input.value = '';
        if (val && cur.history) cur.history.push(val);
        if (val) {
          cur.busy = true;
          updateStopBar();
          lastScreenAt = Date.now();
          idleWatch();
        }
        await sendScreen(val + '\r');
        return;
      }
      const seq = { ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowLeft: '\x1b[D', ArrowRight: '\x1b[C',
                    Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
                    Escape: '\x1b', Tab: '\t' }[e.key];
      if (seq) { e.preventDefault(); await sendScreen(seq); return; }
    }

    // 方向键历史
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cur.history.length === 0) return;
      if (histIdx < 0) histIdx = cur.history.length - 1;
      else if (histIdx > 0) histIdx--;
      input.value = cur.history[histIdx] || '';
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < 0) return;
      histIdx++;
      if (histIdx >= cur.history.length) { histIdx = -1; input.value = ''; }
      else input.value = cur.history[histIdx];
      return;
    }

    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (cur.busy) {
      // 命令运行时输入的内容不再丢弃，直接写进进程 stdin，
      // 这样 apt upgrade / remove 的 y/n 确认可以在输入框里作答
      const val = input.value;
      input.value = '';
      if (!val) return;
      cur.line('$ ' + val, 'term-dim');
      try {
        const sb = await ensureSandbox();
        if (sb && typeof sb.stdin === 'function') await sb.stdin({ text: val });
        else cur.line('当前命令不接受输入', 'term-sys');
      } catch (err) {
        cur.line('输入发送失败: ' + (err && err.message ? err.message : err), 'term-err');
      }
      return;
    }

    // 修饰键组合：CTRL+C 等
    if (mods.CTRL && input.value.toLowerCase() === 'c') {
      cur.line('^C', 'term-err');
      input.value = '';
      resetMods();
      return;
    }
    if (mods.CTRL && input.value.toLowerCase() === 'd') {
      cur.line('^D', 'term-sys');
      input.value = '';
      resetMods();
      return;
    }

    let cmd = input.value;
    if (mods.CTRL) cmd = '\\x03' + cmd; // 标记，实际执行时处理
    cmd = cmd.trim();
    if (!cmd) { resetMods(); return; }
    input.value = '';
    histIdx = -1;
    resetMods();
    cur.busy = true;
    // 不禁用输入框：命令运行中输入框用于回答 y/n
    updateStopBar();
    cur.history.push(cmd);
    try {
      cur.cmd(cmd);
      activeTerm = cur;
      // 手动执行不加 noAutoYes：apt 的 y/n 由用户自己回答，保持真实交互
      await sandboxRun(cur, cmd, { cwd: cur.cwd || '', timeout: 300000, noAutoYes: true, interactive: true });
    } catch (err) {
      cur.line('执行失败：' + err.message, 'term-err');
    } finally {
      cur.busy = false;
      input.disabled = false;
      updateStopBar();
      input.focus();
    }
  });
}
initFloatingTerminal();

// 关闭/刷新页面且仍有命令在执行时提示（WebView 内不弹窗，浏览器端生效）
window.addEventListener('beforeunload', () => {
  // 关闭终端 / 切后台不终止任务：命令继续由原生进程执行，回到页面时结果仍在
  window.__termAnyBusy = false;
});
