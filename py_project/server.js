/**
 * AI Chat App — Node.js 后端
 * 功能：
 *  - 多用户注册/登录（数据隔离，SQLite 持久化）
 *  - 会话与聊天历史持久化
 *  - 后端代理上游 OpenAI 兼容接口，SSE 流式输出
 *  - 支持模型选择
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');

// ============ 邮件验证码（163 邮箱 SMTP 自动发送） ============
// 163 邮箱授权码（网页版邮箱 → 设置 → POP3/SMTP/IMAP → 开启服务 → 新增授权码）
const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_PASS || ''; // 网易163授权码（非登录密码），仅从环境变量读取
const MAIL_TRANSPORTER = MAIL_USER
  ? nodemailer.createTransport({
      host: 'smtp.163.com',
      port: 465,
      secure: true,               // 163 用 465 SSL；若换 587 需 secure:false + STARTTLS
      auth: { user: MAIL_USER, pass: MAIL_PASS },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
    })
  : null;
const mailCodes = new Map();       // email -> { code, purpose, expiresAt, attempts, lastSentAt }
const CODE_TTL_MS = 5 * 60 * 1000; // 验证码 5 分钟有效
const CODE_RESEND_MS = 60 * 1000;  // 60 秒后才能重发
const CODE_MAX_ATTEMPTS = 5;       // 最多尝试 5 次
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function mailHtml(code, subject) {
  const brand = subject.replace('【AI 助手】', '').replace('验证码', '');
  return `<!DOCTYPE html><html><body style="margin:0;background:#eef3fc;padding:32px 12px;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;">
  <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:18px;box-shadow:0 10px 34px rgba(48,120,246,.14);overflow:hidden;">
    <div style="background:linear-gradient(135deg,#4f8bff,#3078f6);padding:26px 28px;text-align:center;">
      <div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:.4px;">✦ AI 助手</div>
      <div style="font-size:13px;color:rgba(255,255,255,.85);margin-top:6px;">${brand}验证码</div>
    </div>
    <div style="padding:30px 28px;">
      <div style="font-size:14px;color:#334155;line-height:1.8;">你好，</div>
      <div style="font-size:14px;color:#334155;line-height:1.8;margin-bottom:18px;">你正在使用 AI 助手完成邮箱验证，请在 5 分钟内输入下面的验证码：</div>
      <div style="text-align:center;font-size:34px;font-weight:800;letter-spacing:12px;color:#2563eb;background:#f0f6ff;border-radius:12px;padding:16px 0;margin-bottom:18px;">${code}</div>
      <div style="font-size:12.5px;color:#94a3b8;line-height:1.7;">· 验证码仅用于本次验证，请勿转发给任何人<br/>· 如果这不是你本人的操作，请忽略本邮件</div>
    </div>
    <div style="padding:14px 28px;background:#f8fafc;border-top:1px solid #eef2f7;text-align:center;font-size:12px;color:#b0bcc9;">AI 助手 · 自动发送，请勿直接回复</div>
  </div></body></html>`;
}
function sendMailCode(email, purpose) {
  const code = genCode();
  const key = email.toLowerCase();
  mailCodes.set(key, { code, purpose, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, lastSentAt: Date.now() });
  const subject = purpose === 'register' ? '【AI 助手】注册验证码'
    : purpose === 'login' ? '【AI 助手】登录验证码'
    : '【AI 助手】邮箱绑定验证码';
  const text = `你的 AI 助手验证码是 ${code}，5 分钟内有效。请勿泄露给他人。`;
  if (process.env.MAIL_DEV === '1' || !MAIL_TRANSPORTER) {
    console.log(`[MAIL-DEV] 验证码未实际发送。收件人=${email} 验证码=${code}`);
    return Promise.resolve({ dev: true, code });
  }
  return MAIL_TRANSPORTER.sendMail({
    from: `${'AI 助手'} <${MAIL_USER}>`,
    to: email,
    subject,
    text,
    html: mailHtml(code, subject),
  }).then(() => ({ dev: false })).catch(e => { mailCodes.delete(key); throw e; });
}
function verifyMailCode(email, purpose, code) {
  const key = String(email || '').toLowerCase();
  const rec = mailCodes.get(key);
  if (!rec) return { ok: false, error: '验证码不存在或已过期，请重新发送' };
  if (rec.purpose !== purpose) return { ok: false, error: '验证码用途不匹配，请重新发送' };
  if (rec.expiresAt < Date.now()) { mailCodes.delete(key); return { ok: false, error: '验证码已过期，请重新发送' }; }
  const codeStr = String(code || '').trim();
  if (!codeStr) return { ok: false, error: '请输入邮箱验证码' };
  if (codeStr !== rec.code) {
    rec.attempts += 1;
    if (rec.attempts >= CODE_MAX_ATTEMPTS) { mailCodes.delete(key); return { ok: false, error: '验证码错误次数过多，请重新发送' }; }
    return { ok: false, error: `验证码错误，还可尝试 ${CODE_MAX_ATTEMPTS - rec.attempts} 次` };
  }
  mailCodes.delete(key);
  return { ok: true };
}
function mailResetOnChange(email) { mailCodes.delete(String(email || '').toLowerCase()); }

// ============ 配置 ============
// 上游 Provider：按顺序尝试，连不上自动切下一个；poixe 全挂时自动 fallback 到智谱
const POIXE_KEY = process.env.POIXE_KEY || '';
const ZHIPU_KEY = process.env.ZHIPU_KEY || ''; // 智谱开放平台，通过环境变量注入
const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const UPSTREAM_ENDPOINTS = [
  { provider: 'poixe', name: 'poixe-1',   base: 'https://api.poixe.com',                       key: POIXE_KEY, apiPath: '/v1' },
  { provider: 'poixe', name: 'poixe-2',   base: 'https://api-eu-central-1-dc8.poixe.com',      key: POIXE_KEY, apiPath: '/v1' },
  { provider: 'poixe', name: 'poixe-3',   base: 'https://api-eu-central-1-dc15.poixe.com',     key: POIXE_KEY, apiPath: '/v1' },
  { provider: 'zhipu', name: '智谱AI',     base: 'https://open.bigmodel.cn/api/paas/v4',        key: ZHIPU_KEY, apiPath: ''   },
];
// 智谱模型静态清单（官方文档 2026-10 核验）：
//  - free: true  = 无限免费模型；free: false = 低价模型（用账号赠送额度调用）
//  - caps: 能力标记（仅智谱可用）：image=图片理解, video=视频理解, file=文件理解, audio=音频对话, think=深度思考
//  - name: 前端展示名（智谱官网风格）；前端 id 统一为 zhipu:xxx
// 智谱模型全量清单（2026-10 官方模型概览/定价）。price = {in,out} 元/百万 tokens，免费模型无 price
const ZHIPU_MODELS = [
  // ---- 免费模型（无限免费） ----
  { id: 'zhipu:glm-4-flash-250414', apiModel: 'glm-4-flash-250414', free: true, name: 'GLM-4-Flash', caps: [] },
  { id: 'zhipu:glm-4.5-flash',       apiModel: 'glm-4.5-flash',       free: true, name: 'GLM-4.5-Flash', caps: [] },
  { id: 'zhipu:glm-4.7-flash',       apiModel: 'glm-4.7-flash',       free: true, name: 'GLM-4.7-Flash', caps: [] },
  { id: 'zhipu:glm-z1-flash',        apiModel: 'glm-z1-flash',        free: true, name: 'GLM-Z1-Flash', caps: ['think'] },
  { id: 'zhipu:glm-4v-flash',        apiModel: 'glm-4v-flash',        free: true, name: 'GLM-4V-Flash', caps: ['image'] },
  { id: 'zhipu:glm-4.1v-thinking-flash', apiModel: 'glm-4.1v-thinking-flash', free: true, name: 'GLM-4.1V-Thinking-Flash', caps: ['image', 'think'] },
  { id: 'zhipu:glm-4.6v-flash',      apiModel: 'glm-4.6v-flash',      free: true, name: 'GLM-4.6V-Flash', caps: ['image'] },
  { id: 'zhipu:charglm-4',          apiModel: 'charglm-4',          free: true, name: 'CharGLM-4', caps: [] },
  { id: 'zhipu:emohaa',             apiModel: 'emohaa',             free: true, name: 'Emohaa', caps: [] },
  { id: 'zhipu:glm-ocr',            apiModel: 'glm-ocr',            free: true, name: 'GLM-OCR', caps: ['image'] },
  // ---- 付费模型（按价格由低到高，受 50 元累计消费上限管控） ----
  { id: 'zhipu:glm-4-flashx-250414', apiModel: 'glm-4-flashx-250414', free: false, price: { in: 0.1, out: 0.1 }, name: 'GLM-4-FlashX', caps: [] },
  { id: 'zhipu:glm-z1-flashx',       apiModel: 'glm-z1-flashx',       free: false, price: { in: 0.1, out: 0.1 }, name: 'GLM-Z1-FlashX', caps: ['think'] },
  { id: 'zhipu:glm-4.6v-flashx',     apiModel: 'glm-4.6v-flashx',     free: false, price: { in: 0.15, out: 1.5 }, name: 'GLM-4.6V-FlashX', caps: ['image'] },
  { id: 'zhipu:glm-z1-air',          apiModel: 'glm-z1-air',          free: false, price: { in: 0.5, out: 0.5 }, name: 'GLM-Z1-Air', caps: ['think'] },
  { id: 'zhipu:glm-4.7-flashx',      apiModel: 'glm-4.7-flashx',      free: false, price: { in: 0.5, out: 3 }, name: 'GLM-4.7-FlashX', caps: [] },
  { id: 'zhipu:glm-4.5-air',         apiModel: 'glm-4.5-air',         free: false, price: { in: 0.8, out: 2 }, name: 'GLM-4.5-Air', caps: [] },
  { id: 'zhipu:glm-4.5-airx',        apiModel: 'glm-4.5-airx',        free: false, price: { in: 1, out: 2 }, name: 'GLM-4.5-AirX', caps: [] },
  { id: 'zhipu:glm-4-long',          apiModel: 'glm-4-long',          free: false, price: { in: 1, out: 1 }, name: 'GLM-4-Long', caps: [] },
  { id: 'zhipu:glm-4.6v',            apiModel: 'glm-4.6v',            free: false, price: { in: 1, out: 3 }, name: 'GLM-4.6V', caps: ['image'] },
  { id: 'zhipu:glm-5.3-flash',       apiModel: 'glm-5.3-flash',       free: false, price: { in: 0.8, out: 2.8 }, name: 'GLM-5.3-Flash', caps: ['image', 'video', 'file'] },
  { id: 'zhipu:glm-4.1v-thinking-flashx', apiModel: 'glm-4.1v-thinking-flashx', free: false, price: { in: 2, out: 2 }, name: 'GLM-4.1V-Thinking-FlashX', caps: ['image', 'think'] },
  { id: 'zhipu:glm-4.5v',            apiModel: 'glm-4.5v',            free: false, price: { in: 2, out: 6 }, name: 'GLM-4.5V', caps: ['image'] },
  { id: 'zhipu:glm-5.3-flashx',      apiModel: 'glm-5.3-flashx',      free: false, price: { in: 2, out: 7 }, name: 'GLM-5.3-FlashX', caps: ['image', 'video', 'file'] },
  { id: 'zhipu:glm-4.5',             apiModel: 'glm-4.5',             free: false, price: { in: 2, out: 8 }, name: 'GLM-4.5', caps: [] },
  { id: 'zhipu:glm-4.6',             apiModel: 'glm-4.6',             free: false, price: { in: 2.5, out: 10 }, name: 'GLM-4.6', caps: [] },
  { id: 'zhipu:glm-4.7',             apiModel: 'glm-4.7',             free: false, price: { in: 2, out: 8 }, name: 'GLM-4.7', caps: [] },
  { id: 'zhipu:glm-5',               apiModel: 'glm-5',               free: false, price: { in: 4, out: 18 }, name: 'GLM-5', caps: [] },
  { id: 'zhipu:glm-5-turbo',         apiModel: 'glm-5-turbo',         free: false, price: { in: 5, out: 22 }, name: 'GLM-5-Turbo', caps: [] },
  { id: 'zhipu:glm-5v-turbo',        apiModel: 'glm-5v-turbo',        free: false, price: { in: 5, out: 22 }, name: 'GLM-5V-Turbo', caps: ['image'] },
  { id: 'zhipu:glm-5.1',             apiModel: 'glm-5.1',             free: false, price: { in: 6, out: 24 }, name: 'GLM-5.1', caps: [] },
  { id: 'zhipu:glm-5.2',             apiModel: 'glm-5.2',             free: false, price: { in: 8, out: 28 }, name: 'GLM-5.2', caps: [] },
  { id: 'zhipu:glm-5.3',             apiModel: 'glm-5.3',             free: false, price: { in: 8, out: 28 }, name: 'GLM-5.3', caps: ['think'] },
  { id: 'zhipu:glm-z1-airx',         apiModel: 'glm-z1-airx',         free: false, price: { in: 5, out: 5 }, name: 'GLM-Z1-AirX', caps: ['think'] },
  { id: 'zhipu:glm-4-voice',         apiModel: 'glm-4-voice',         free: false, price: { in: 80, out: 80 }, name: 'GLM-4-Voice', caps: ['audio'] },
  // ---- 生成类模型（走专门接口，非 chat） ----
  // 图像生成（images/generations）
  { id: 'zhipu:cogview-3-flash', apiModel: 'cogview-3-flash', free: true, name: 'CogView-3-Flash', kind: 'image_gen', caps: [] },
  { id: 'zhipu:cogview-3',       apiModel: 'cogview-3',       free: false, price: { in: 0.25, out: 0.25 }, name: 'CogView-3', kind: 'image_gen', caps: [] },
  { id: 'zhipu:cogview-4',       apiModel: 'cogview-4-250304', free: false, price: { in: 0.5, out: 0.5 }, name: 'CogView-4', kind: 'image_gen', caps: [] },
  { id: 'zhipu:glm-image',       apiModel: 'glm-4-image',      free: false, price: { in: 0.5, out: 0.5 }, name: 'GLM-Image', kind: 'image_gen', caps: [] },
  // 视频生成（videos/generations，异步轮询）
  { id: 'zhipu:cogvideox-flash', apiModel: 'cogvideox-flash', free: true, name: 'CogVideoX-Flash', kind: 'video_gen', caps: [] },
  { id: 'zhipu:cogvideox-2',     apiModel: 'cogvideox-2',     free: false, price: { in: 0.5, out: 0.5 }, name: 'CogVideoX-2', kind: 'video_gen', caps: [] },
  { id: 'zhipu:cogvideox-3',     apiModel: 'cogvideox-3',     free: false, price: { in: 1, out: 1 }, name: 'CogVideoX-3', kind: 'video_gen', caps: [] },
  // 语音合成（audio/speech）——付费按量计费（智谱按字符计费），标为 paid，避免误当免费模型使用而报余额不足
  { id: 'zhipu:glm-tts',         apiModel: 'glm-tts',         free: false, price: { in: 1, out: 1 }, name: 'GLM-TTS', kind: 'tts', caps: [] },
];
const ZHIPU_FALLBACK_MODEL = 'glm-4-flash-250414'; // poixe 全挂时的兜底模型（无限免费）
const ZHIPU_CAPS_LABEL = { image: '图片', video: '视频', file: '文件', audio: '语音', think: '深度思考' };
// 默认会输出思维链、且可用 thinking:{type:'disabled'} 关闭的模型（未开深度时自动关闭，避免擅自深度思考）
const ZHIPU_DEFAULT_THINK = new Set([
  'glm-z1-flash', 'glm-z1-flashx', 'glm-z1-air', 'glm-z1-airx',
  'glm-4.5-flash', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-airx', 'glm-4.6',
  'glm-5', 'glm-5-turbo', 'glm-5.1', 'glm-5.2'
]);
// 强制思考、官方不支持关闭（传 disabled 会直接报错），只能保持默认并把思考过程展示给用户
const ZHIPU_THINK_FORCED = new Set([
  'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx',
  'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx',
  'glm-4.5v', 'glm-4.1v-thinking-flash', 'glm-4.1v-thinking-flashx'
]);
// 思考内容不走 reasoning_content 字段、而是以 <think>…</think> 混在正文里的模型（Z1 系列）
const ZHIPU_THINK_TAG = new Set(['glm-z1-flash', 'glm-z1-flashx', 'glm-z1-air', 'glm-z1-airx']);
// 流式剥离 <think>…</think>。开深度时 onThink 回调把思考内容推给前端，关闭时直接丢弃。跨帧缓冲。
function makeThinkTagStripper(onThink) {
  let inThink = false;
  let pending = '';
  const emitThink = (t) => { if (t && typeof onThink === 'function') onThink(t); };
  return {
    feed(chunk) {
      let s = pending + String(chunk || '');
      let out = '';
      pending = '';
      while (s.length) {
        if (inThink) {
          const i = s.indexOf('</think>');
          if (i === -1) {
            // 整段都是思考内容，末尾保留 8 字符防止 </think> 被截断
            const cut = Math.max(0, s.length - 8);
            emitThink(s.slice(0, cut));
            pending = s.slice(cut);
            s = '';
          } else {
            emitThink(s.slice(0, i));
            s = s.slice(i + 8);
            inThink = false;
          }
        } else {
          const i = s.indexOf('<think>');
          if (i === -1) {
            if (s.length > 7) { out += s.slice(0, -7); pending = s.slice(-7); }
            else pending = s;
            s = '';
          } else {
            out += s.slice(0, i);
            s = s.slice(i + 7);
            inThink = true;
          }
        }
      }
      return out;
    },
    flush() {
      if (inThink) { emitThink(pending); return ''; }
      return pending;
    }
  };
}
const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 天
const REQUEST_TIMEOUT_MS = 20000;

// ============ 用量限制 ============
// 已解除每日次数限制，且不再向前端展示"今日免费次数 / 单次 token"
const FREE_MAX_TOKENS   = 8192;  // 默认 token 上限（前端可覆盖），避免代码/长文被截断
const PAID_ENABLED      = false; // 付费模型保持置灰

// 免费模型实测可用性（2026-10-01 批量测试结果）
// enabled: true 可用；false 今日不可用（限流/已下线/未知）
const BUILTIN_FREE_MODELS = [
  { id: 'deepseek-chat:free',          enabled: true,  note: '' },
  { id: 'deepseek-reasoner:free',      enabled: true,  note: '' },
  { id: 'gpt-4o-mini:free',            enabled: true,  note: '' },
  { id: 'gpt-3.5-turbo:free',          enabled: true,  note: '' },
  { id: 'gpt-4.1:free',                enabled: true,  note: '' },
  { id: 'gpt-4.1-mini:free',           enabled: true,  note: '' },
  { id: 'gpt-4.1-nano:free',           enabled: true,  note: '' },
  { id: 'gpt-5-nano:free',             enabled: true,  note: '' },
  { id: 'qwen-plus:free',              enabled: true,  note: '' },
  { id: 'qwen-turbo:free',             enabled: true,  note: '' },
  { id: 'qwen-max:free',               enabled: true,  note: '' },
  { id: 'qwen-long:free',              enabled: true,  note: '' },
  { id: 'gemini-2.5-flash:free',       enabled: true,  note: '' },
  { id: 'gemini-2.5-flash-lite:free',  enabled: true,  note: '' },
  { id: 'grok-3-mini:free',            enabled: true,  note: '' },
  // 以下今日测试不可用，置灰
  { id: 'gpt-4o:free',                 enabled: false, note: '今日限流' },
  { id: 'gpt-5:free',                  enabled: false, note: '今日限流' },
  { id: 'gpt-5-mini:free',             enabled: false, note: '过载' },
  { id: 'gemini-2.5-pro:free',         enabled: false, note: '今日免费额度已用完' },
  { id: 'claude-sonnet-4-5:free',      enabled: false, note: '服务错误' },
  { id: 'doubao-1.5-pro-32k-250115:free', enabled: false, note: '模型不存在' },
  { id: 'doubao-1.5-lite-32k-250115:free', enabled: false, note: '模型不存在' },
  { id: 'doubao-seed-1.6-flash-250615:free', enabled: false, note: '模型不存在' },
  { id: 'grok-3:free',                 enabled: false, note: '今日免费额度已用完' },
  { id: 'grok-4:free',                 enabled: false, note: '今日免费额度已用完' },
  { id: 'o1-mini:free',                enabled: false, note: '今日免费额度已用完' },
  { id: 'o3-mini:free',                enabled: false, note: '今日免费额度已用完' },
  { id: 'o4-mini:free',                enabled: false, note: '今日免费额度已用完' },
];

// 全局记录当前可用端点（故障转移后缓存，下次直接用）；按端点 name 记录状态
let activeEndpointIdx = 0;
const endpointStatus = {};

// 判断某个响应是否属于"连接失败/上游故障"——需要切下一个端点
function isFailoverStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

// 带故障转移的 fetch：自动遍历指定 Provider 的端点，poixe 全失败时自动 fallback 到智谱
// pathname 形如 '/models'、'/chat/completions'（不含版本前缀，由各端点 apiPath 补齐）
// opts 同 fetch（无需带 Authorization，会按端点自动注入对应 key）
// 返回 { resp, base, idx, fallback, model } 或抛出最后一次错误
async function fetchUpstream(pathname, opts = {}, { stream = false, provider = 'poixe', fallbackModel = null } = {}) {
  const pool = UPSTREAM_ENDPOINTS.filter(e => e.provider === (provider === 'zhipu' ? 'zhipu' : 'poixe'));
  if (!pool.length) throw new Error('没有可用的上游端点');
  let lastErr = null;

  const tryEndpoint = async (ep, body) => {
    const url = ep.base.replace(/\/+$/, '') + ep.apiPath + pathname;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { ...body, signal: ctrl.signal });
      clearTimeout(timer);
      // 2xx 或需要拿到 body 判断的 4xx（如 401/403/400）直接返回
      if (resp.ok || !isFailoverStatus(resp.status)) {
        endpointStatus[ep.name] = { ok: true, checkedAt: Date.now(), lastError: '' };
        return { resp, ep };
      }
      // 5xx / 429 / 408：标记并试下一个
      endpointStatus[ep.name] = { ok: false, checkedAt: Date.now(), lastError: 'HTTP ' + resp.status };
      lastErr = new Error('HTTP ' + resp.status + ' @ ' + ep.base);
      // 流式响应不能在这里读 body（会破坏流），由调用方决定；非流式先消费错误体
      if (!stream) await resp.text().catch(() => {});
      return null;
    } catch (e) {
      clearTimeout(timer);
      endpointStatus[ep.name] = { ok: false, checkedAt: Date.now(), lastError: String(e.message || e).slice(0, 200) };
      lastErr = e;
      return null;
    }
  };

  const withAuth = (ep) => ({ ...opts, headers: { ...(opts.headers || {}), 'Authorization': 'Bearer ' + ep.key } });

  if (provider === 'zhipu') {
    let r = await tryEndpoint(pool[0], withAuth(pool[0]));
    if (r) return { resp: r.resp, base: r.ep.base, idx: -1, fallback: false };
    // 智谱免费模型偶发 429（"访问量过大"类瞬时限流）：退避重试一次
    if (lastErr && /429/.test(lastErr.message)) {
      await new Promise(res => setTimeout(res, 1500));
      r = await tryEndpoint(pool[0], withAuth(pool[0]));
      if (r) return { resp: r.resp, base: r.ep.base, idx: -1, fallback: false };
    }
    throw lastErr || new Error('智谱端点不可用');
  }

  // poixe 池轮询
  for (let i = 0; i < pool.length; i++) {
    const idx = (activeEndpointIdx + i) % pool.length;
    const ep = pool[idx];
    const r = await tryEndpoint(ep, withAuth(ep));
    if (r) { activeEndpointIdx = idx; return { resp: r.resp, base: r.ep.base, idx, fallback: false }; }
  }

  // poixe 全部不可用 → 自动切换智谱（用 fallbackModel 替换请求体里的模型）
  if (fallbackModel) {
    const zp = UPSTREAM_ENDPOINTS.find(e => e.provider === 'zhipu');
    if (zp) {
      let body = withAuth(zp);
      try {
        const parsed = JSON.parse(body.body);
        parsed.model = fallbackModel;
        body = { ...body, body: JSON.stringify(parsed) };
      } catch (_) {}
      let r = await tryEndpoint(zp, body);
      // 智谱瞬时限流（429）退避重试一次
      if (!r && lastErr && /429/.test(lastErr.message)) {
        await new Promise(res => setTimeout(res, 1500));
        r = await tryEndpoint(zp, body);
      }
      if (r) return { resp: r.resp, base: r.ep.base, idx: -1, fallback: true, model: fallbackModel };
    }
  }
  throw lastErr || new Error('所有上游地址均不可用');
}

// ============ 数据库 ============
// 自动创建 data 目录，避免 "directory does not exist" 报错
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  email         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_daily (
  user_id    INTEGER NOT NULL,
  day        TEXT NOT NULL,
  spent      REAL NOT NULL DEFAULT 0,
  calls      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  model           TEXT,
  created_at      INTEGER NOT NULL,
  audio           TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_conv  ON messages(conversation_id);
`);
// 兼容旧库：为 messages 补 audio 列（GLM-4-Voice 语音上下文）
try { db.run('ALTER TABLE messages ADD COLUMN audio TEXT'); } catch (_) {}

// 兼容旧库：给已存在的 users 表补 email 列
const userCols = db.prepare('PRAGMA table_info(users)').all();
if (!userCols.some(c => c.name === 'email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT');
}
// v3.27.3：注销冷静期字段（deactivate_at 为注销申请到期时间戳，NULL 表示未申请）
if (!userCols.some(c => c.name === 'deactivate_at')) {
  db.exec('ALTER TABLE users ADD COLUMN deactivate_at INTEGER');
}

// 可选预置管理员：仅在显式设置 SEED_USER + SEED_PASSWORD 时创建（不存在则插入，不重置已有密码）
// 默认不创建任何账号，避免源码/部署包内置默认口令。
(function ensureSeedAccount() {
  const username = String(process.env.SEED_USER || '').trim();
  const password = String(process.env.SEED_PASSWORD || '');
  if (!username || password.length < 6) return;
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (row) return;
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (username, password_hash, salt, nickname, email, created_at) VALUES (?,?,?,?,?,?)')
    .run(username, hashPassword(password, salt), salt, username, null, now());
  console.log('[seed] 已创建管理员账号:', username);
})();

// ============ 游客会话（免登录直连）：服务启动即创建/复用 guest 用户与长期会话，
// 前端打开页面无需登录即可直接使用；登录后切换为个人账号 ============
const GUEST_MAX_CONVERSATIONS = 3;       // 游客最多创建 3 个对话
const GUEST_MAX_MESSAGES_PER_CONV = 10;  // 游客每个对话最多 10 条消息（用户+AI 合计）
function isGuestUser(user) { return !!user && String(user.username) === 'guest'; }
function ensureGuest() {
  let guest = db.prepare('SELECT * FROM users WHERE username = ?').get('guest');
  if (!guest) {
    const salt = crypto.randomBytes(16).toString('hex');
    const info = db.prepare('INSERT INTO users (username, password_hash, salt, nickname, email, created_at) VALUES (?,?,?,?,?,?)')
      .run('guest', hashPassword('guest-' + Date.now(), salt), salt, '游客', '', now());
    guest = db.prepare('SELECT * FROM users WHERE username = ?').get('guest');
    console.log('[guest] 游客账号已创建 id=' + guest.id);
  }
  return guest;
}
let guestToken = null;
function getGuestSession() {
  const guest = ensureGuest();
  if (guestToken) {
    // 复用现有会话（清理过期后仍有效则直接返回）
    const alive = db.prepare('SELECT token FROM sessions WHERE token = ? AND user_id = ? AND expires_at > ?')
      .get(guestToken, guest.id, now());
    if (alive) return { token: guestToken, user: { id: guest.id, username: guest.username, nickname: guest.nickname, email: guest.email } };
  }
  guestToken = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(guestToken, guest.id, now() + SESSION_TTL_MS);
  return { token: guestToken, user: { id: guest.id, username: guest.username, nickname: guest.nickname, email: guest.email } };
}

// ============ 每日额度（服务端记账，所有模型含免费模型，每日 ¥1） ============
// 日期由服务端时钟按北京时间（UTC+8）切分，客户端时间不参与，改手机时间无效。
const QUOTA_LIMIT_YUAN = 1;
const QUOTA_COSTS = { chat: 0.05, image_gen: 0.10, video_gen: 1.00, tts: 0.05 };
const QUOTA_TZ_OFFSET = 8 * 3600;
function quotaDay() {
  const d = new Date(Date.now() + QUOTA_TZ_OFFSET * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function quotaState(userId) {
  const day = quotaDay();
  const row = db.prepare('SELECT spent, calls FROM quota_daily WHERE user_id = ? AND day = ?').get(userId, day);
  const spent = row ? Number(row.spent) || 0 : 0;
  const calls = row ? Number(row.calls) || 0 : 0;
  return {
    day, spent: Math.round(spent * 1e6) / 1e6, calls,
    limit: QUOTA_LIMIT_YUAN,
    remaining: Math.max(0, Math.round((QUOTA_LIMIT_YUAN - spent) * 1e6) / 1e6),
    costs: QUOTA_COSTS,
  };
}
function quotaCharge(userId, kind) {
  const fee = QUOTA_COSTS[kind];
  if (!(fee > 0)) return { ok: false, error: '未知的计费类型: ' + kind, quota: quotaState(userId) };
  const day = quotaDay();
  const row = db.prepare('SELECT spent, calls FROM quota_daily WHERE user_id = ? AND day = ?').get(userId, day);
  const spent = row ? Number(row.spent) || 0 : 0;
  if (spent + fee > QUOTA_LIMIT_YUAN + 1e-9) {
    return { ok: false, error: '今日额度不足：本次 ¥' + fee.toFixed(2) + '，剩余 ¥' + Math.max(0, QUOTA_LIMIT_YUAN - spent).toFixed(2), quota: quotaState(userId) };
  }
  const next = Math.round((spent + fee) * 1e6) / 1e6;
  db.prepare(`INSERT INTO quota_daily (user_id, day, spent, calls, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, day) DO UPDATE SET spent = excluded.spent, calls = excluded.calls, updated_at = excluded.updated_at`)
    .run(userId, day, next, (row ? Number(row.calls) || 0 : 0) + 1, now());
  console.log('[quota] user=' + userId + ' ' + kind + ' +¥' + fee + ' → ¥' + next + '/¥' + QUOTA_LIMIT_YUAN + ' (' + day + ')');
  return { ok: true, fee, quota: quotaState(userId) };
}
function quotaRefund(userId, kind) {
  const fee = QUOTA_COSTS[kind];
  if (!(fee > 0)) return quotaState(userId);
  const day = quotaDay();
  const row = db.prepare('SELECT spent, calls FROM quota_daily WHERE user_id = ? AND day = ?').get(userId, day);
  if (!row) return quotaState(userId);
  const spent = Math.max(0, Math.round((Number(row.spent) - fee) * 1e6) / 1e6);
  const calls = Math.max(0, (Number(row.calls) || 0) - 1);
  db.prepare('UPDATE quota_daily SET spent = ?, calls = ?, updated_at = ? WHERE user_id = ? AND day = ?')
    .run(spent, calls, now(), userId, day);
  return quotaState(userId);
}

// ============ 工具函数 ============
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
function now() { return Date.now(); }

// 从 cookie 或 Authorization: Bearer 中解析 session token（APK 跨域无法带 cookie）
function getSessionUser(req) {
  let token = null;
  const auth = req.headers.authorization || '';
  const bm = auth.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (bm) token = bm[1];
  if (!token) {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/(?:^|;\s*)token=([a-f0-9]{64})/);
    if (m) token = m[1];
  }
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id AS id, u.username AS username, u.nickname AS nickname, u.email AS email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now());
  return row || null;
}
function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  // 注销冷静期内：除查看/取消外，禁止对话等写操作
  const path = req.path || '';
  // 冷静期内只拦业务写操作；账号/会话类接口必须放行，否则用户既不能退出登录也不能取消注销
  const ex = ['/api/me', '/api/deactivate', '/api/logout', '/api/login', '/api/register',
              '/api/auth/', '/api/profile', '/api/spend', '/api/verify'];
  const exempt = ex.some(p => path.startsWith(p));
  if (user.deactivate_at && user.deactivate_at > Date.now() && !exempt) {
    return res.status(403).json({ error: '账号注销冷静期内，剩余 ' + Math.ceil((user.deactivate_at - Date.now()) / 86400000) + ' 天', deactivating: true });
  }
  req.user = user;
  next();
}
function ensureOwnConversation(req, res) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!conv) { res.status(404).json({ error: '会话不存在' }); return null; }
  return conv;
}

// ============ Express ============
const app = express();
// CORS：允许 APK（Capacitor WebView）跨域访问 API；回显 Origin 以支持携带凭据
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '40mb' })); // 多模态附件（图片/文件 base64）需要大请求体，默认 100kb 会 413
app.use(express.static(path.join(__dirname, 'public')));

// ---- 通用 API 代理（避免 WebView CORS）----
// 前端 POST /api/proxy/chat { provider: 'zhipu'|'openrouter'|'agnes', body: {...} }
// 后端转发到对应 provider 的 /chat/completions，SSE 透传
const PROXY_TARGETS = {
  zhipu:      { base: 'https://open.bigmodel.cn/api/paas/v4', key: ZHIPU_KEY },
  openrouter: { base: 'https://openrouter.ai/api/v1',         key: process.env.OPENROUTER_KEY || '' },
  agnes:      { base: 'https://api.agnes.ai/v1',              key: process.env.AGNES_KEY || '' },
};
app.post('/api/proxy/chat', requireAuth, async (req, res) => {
  let charged = false;
  try {
    const { provider, body } = req.body || {};
    const t = PROXY_TARGETS[provider];
    if (!t) return res.status(400).json({ error: 'unknown provider: ' + provider });
    const q = quotaCharge(req.user.id, 'chat');
    if (!q.ok) return res.status(402).json({ error: q.error, quota: q.quota });
    charged = true;
    const upstream = await fetch(t.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t.key },
      body: JSON.stringify(body),
    });
    if (upstream.status >= 400) {
      quotaRefund(req.user.id, 'chat');
      charged = false;
    }
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) res.setHeader(k, v);
    });
    // SSE 透传
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (charged) quotaRefund(req.user.id, 'chat');
    if (!res.headersSent) res.status(502).json({ error: 'proxy failed: ' + e.message });
    else try { res.end(); } catch (_) {}
  }
});

// 智谱图片/视频/语音代理：服务端持有 Key、鉴权并记账；客户端不再直连、不再内嵌密钥
// POST /api/proxy/zhipu { path: '/images/generations', method: 'POST', body: {...} }
app.post('/api/proxy/zhipu', requireAuth, async (req, res) => {
  let chargedKind = null;
  try {
    const { path: zpath, method, body } = req.body || {};
    if (typeof zpath !== 'string' || !zpath.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
    const m = (method === 'GET' ? 'GET' : 'POST');
    let kind = null;
    if (zpath.includes('/images/')) kind = 'image_gen';
    else if (zpath.includes('/videos/')) kind = 'video_gen';
    else if (zpath.includes('/audio/')) kind = 'tts';
    if (kind) {
      const q = quotaCharge(req.user.id, kind);
      if (!q.ok) return res.status(402).json({ error: q.error, quota: q.quota });
      chargedKind = kind;
    }
    const upstream = await fetch(ZHIPU_BASE + zpath, {
      method: m,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ZHIPU_KEY },
      ...(m === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    });
    if (upstream.status >= 400) {
      if (chargedKind) quotaRefund(req.user.id, chargedKind);
      chargedKind = null;
    }
    const ct = upstream.headers.get('content-type') || '';
    res.status(upstream.status);
    if (ct.includes('application/json') || ct.includes('text/')) {
      const text = await upstream.text();
      res.setHeader('Content-Type', ct || 'application/json');
      return res.send(text);
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    return res.send(buf);
  } catch (e) {
    if (chargedKind) quotaRefund(req.user.id, chargedKind);
    if (!res.headersSent) res.status(502).json({ error: 'zhipu proxy failed: ' + e.message });
    else try { res.end(); } catch (_) {}
  }
});

// ---- 认证 ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 发送邮箱验证码（注册/登录用途），频率限制 60s，5 分钟有效
app.post('/api/send-code', (req, res) => {
  const { email, purpose } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
  const p = (purpose === 'register' || purpose === 'login') ? purpose : 'login';
  const rec = mailCodes.get(mail);
  if (rec && Date.now() - rec.lastSentAt < CODE_RESEND_MS) {
    const wait = Math.ceil((CODE_RESEND_MS - (Date.now() - rec.lastSentAt)) / 1000);
    return res.status(429).json({ error: `发送太频繁，请 ${wait} 秒后再试` });
  }
  if (p === 'register') {
    const ex = db.prepare('SELECT id FROM users WHERE email = ?').get(mail);
    if (ex) return res.status(409).json({ error: '该邮箱已被注册，请直接登录' });
  } else {
    const ex = db.prepare('SELECT id FROM users WHERE email = ?').get(mail);
    if (!ex) return res.status(404).json({ error: '该邮箱尚未注册，请先注册' });
  }
  sendMailCode(mail, p)
    .then(r => res.json(r))
    .catch(e => res.status(500).json({ error: '邮件发送失败：' + e.message }));
});

app.post('/api/register', (req, res) => {
  const { username, password, nickname, email, code } = req.body || {};
  if (!username || !password || String(username).length < 3 || String(password).length < 6) {
    return res.status(400).json({ error: '用户名至少 3 位，密码至少 6 位' });
  }
  // 邮箱可选：不填邮箱则仅用用户名+密码注册（部署方无需配置 SMTP 也能开户）；
  // 填了邮箱则必须通过邮箱验证码，且邮箱全局唯一。
  const emailVal = String(email || '').trim().toLowerCase();
  if (emailVal) {
    if (!EMAIL_RE.test(emailVal)) return res.status(400).json({ error: '邮箱格式不正确' });
    const v = verifyMailCode(emailVal, 'register', code);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(emailVal);
    if (emailExists) return res.status(409).json({ error: '该邮箱已被绑定' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(String(password), salt);
  try {
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, salt, nickname, email, created_at) VALUES (?,?,?,?,?,?)'
    ).run(String(username).trim(), hash, salt, String(nickname || username).trim(), emailVal || null, now());
    const userId = info.lastInsertRowid;
    const token = newToken();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
      .run(token, userId, now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS/1000}; SameSite=Lax`);
    return res.json({ id: userId, username, nickname: nickname || username, email: emailVal, token });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '用户名已存在' });
    return res.status(500).json({ error: '注册失败: ' + e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password, email, code } = req.body || {};
  // 邮箱验证码快捷登录：只校验邮箱 + 验证码，无需密码
  if (email && code) {
    const mail = String(email).trim().toLowerCase();
    if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
    const v = verifyMailCode(mail, 'login', code);
    if (!v.ok) return res.status(401).json({ error: v.error });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(mail);
    if (!user) return res.status(401).json({ error: '该邮箱尚未注册' });
    const token = newToken();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
      .run(token, user.id, now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS/1000}; SameSite=Lax`);
    return res.json({ id: user.id, username: user.username, nickname: user.nickname, email: user.email, token });
  }
  // 用户名/邮箱 + 密码登录
  const ident = String(username || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(ident, ident);
  if (!user) return res.status(401).json({ error: '用户名/邮箱或密码错误' });
  const hash = hashPassword(String(password || ''), user.salt);
  if (hash !== user.password_hash) return res.status(401).json({ error: '用户名/邮箱或密码错误' });
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, user.id, now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS/1000}; SameSite=Lax`);
  res.json({ id: user.id, username: user.username, nickname: user.nickname, email: user.email, token });
});

app.post('/api/logout', (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)token=([a-f0-9]{64})/);
  if (m) db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
  res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  // 注销冷静期：已到期则自动删除账号
  if (user.deactivate_at && user.deactivate_at <= Date.now()) {
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return res.status(401).json({ error: '账号已注销' });
  }
  res.json({
    id: user.id, username: user.username, nickname: user.nickname, email: user.email,
    deactivating: !!user.deactivate_at,
    deactivateAt: user.deactivate_at || null,
    quota: quotaState(user.id),
  });
});

// 注销账号：POST 申请（20 天冷静期），DELETE 取消
app.post('/api/deactivate', requireAuth, (req, res) => {
  const at = Date.now() + 20 * 86400000;
  db.prepare('UPDATE users SET deactivate_at = ? WHERE id = ?').run(at, req.user.id);
  res.json({ ok: true, deactivateAt: at });
});
app.delete('/api/deactivate', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET deactivate_at = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// 免登录直连：获取/复用游客会话并写入 cookie（打开即用，无需等待登录）
// token 同时返回在 JSON，供 APK 跨域场景保存并自动登录
app.get('/api/guest', (req, res) => {
  const g = getGuestSession();
  res.setHeader('Set-Cookie', `token=${g.token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS/1000}; SameSite=Lax`);
  res.json({ id: g.user.id, username: g.user.username, nickname: g.user.nickname, email: g.user.email, guest: true, token: g.token });
});

app.get('/api/quota', requireAuth, (req, res) => {
  res.json(quotaState(req.user.id));
});
app.post('/api/quota/charge', requireAuth, (req, res) => {
  const kind = String((req.body && req.body.kind) || '');
  const r = quotaCharge(req.user.id, kind);
  if (!r.ok) return res.status(402).json({ error: r.error, quota: r.quota });
  res.json({ ok: true, fee: r.fee, quota: r.quota });
});

app.post('/api/profile', requireAuth, (req, res) => {
  const { nickname } = req.body || {};
  if (!nickname || !String(nickname).trim()) return res.status(400).json({ error: '昵称不能为空' });
  db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(String(nickname).trim(), req.user.id);
  res.json({ ok: true, nickname: String(nickname).trim() });
});

// ---- 邮箱绑定 ----
// 绑定/修改邮箱需要输入登录密码确认身份，邮箱全网唯一
app.post('/api/bind-email', requireAuth, (req, res) => {
  const { email, password } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!password || !String(password).length) return res.status(400).json({ error: '请输入密码确认身份' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: '用户不存在，请重新登录' });
  const hash = hashPassword(String(password), user.salt);
  if (hash !== user.password_hash) return res.status(401).json({ error: '密码错误，无法完成绑定' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(mail, user.id);
  if (exists) return res.status(409).json({ error: '该邮箱已被其他账号绑定' });
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(mail, user.id);
  res.json({ ok: true, email: mail });
});

// ---- 会话 ----
app.get('/api/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT id, title, model, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(req.user.id);
  res.json(rows);
});

app.post('/api/conversations', requireAuth, (req, res) => {
  // 游客限制：最多 3 个对话
  if (isGuestUser(req.user)) {
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM conversations WHERE user_id = ?')
      .get(req.user.id).c;
    if (cnt >= GUEST_MAX_CONVERSATIONS) {
      return res.status(403).json({ error: `游客模式最多创建 ${GUEST_MAX_CONVERSATIONS} 个对话，登录后解锁全部功能` });
    }
  }
  const title = (req.body && req.body.title) ? String(req.body.title).slice(0, 80) : '新会话';
  const model = (req.body && req.body.model) ? String(req.body.model) : '';
  const info = db.prepare(
    'INSERT INTO conversations (user_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)'
  ).run(req.user.id, title, model, now(), now());
  res.json({ id: info.lastInsertRowid, title, model });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = ensureOwnConversation(req, res); if (!conv) return;
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
  res.json({ ok: true });
});

app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const conv = ensureOwnConversation(req, res); if (!conv) return;
  const rows = db.prepare(
    'SELECT id, role, content, model, created_at, audio FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(conv.id);
  res.json({ conversation: conv, messages: rows });
});

// ---- 编辑消息（前端"点击用户消息即可修改"） ----
app.put('/api/messages/:id', requireAuth, (req, res) => {
  const msg = db.prepare(`
    SELECT m.id, m.role, m.conversation_id FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND c.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  const content = String((req.body && req.body.content) || '').trim();
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, msg.id);
  res.json({ ok: true, id: msg.id, content });
});

// ---- 模型列表（代理上游 + 自动分类免费/付费） ----
// 分类规则：命中 FREE_PATTERNS 视为免费/轻量档；命中 PAID_PATTERNS 视为付费/高级档；
// 都不命中默认归为付费档。规则可按需增删。
const FREE_PATTERNS = [
  /-lite/i, /-mini/i, /-nano/i, /-turbo/i, /-flash(?!-?pro)/i, /-flash-lite/i,
  /\b0\.6b\b/i, /\b1\.7b\b/i, /\b4b\b/i, /\b8b\b/i, /\b32b\b/i, /\b7b\b/i,
  /-fast(?!-beta)/i, /highspeed/i, /free/i, /-8x7b/i, /-30b-a3b/i
];
const PAID_PATTERNS = [
  /-pro(?!-lite)/i, /-ultra/i, /-max/i, /-op\b/i, /-opus/i, /-o1\b/i, /-o3\b/i, /-o4/i,
  /gpt-4o(?!-mini)/i, /gpt-5(?!-mini|-nano|-codex-mini|-luna)/i, /gpt-5\.5/i, /gpt-5\.4-pro/i,
  /thinking/i, /-codex(?!-mini)/i, /\b235b\b/i, /\b480b\b/i, /-character/i
];
function classifyModel(id) {
  // 智谱模型统一放行（免费无限 / 低价按量，均在 ZHIPU_MODELS 白名单内管控）
  if (String(id).startsWith('zhipu:')) return 'free';
  if (PAID_PATTERNS.some(re => re.test(id))) return 'paid';
  if (FREE_PATTERNS.some(re => re.test(id))) return 'free';
  return 'paid';
}

// 解析模型所属 Provider 与智谱真实模型名（前端 id 带 'zhipu:' 前缀路由到智谱）
function resolveModelProvider(modelId) {
  const z = ZHIPU_MODELS.find(m => m.id === modelId);
  if (z) return { provider: 'zhipu', apiModel: z.apiModel, fallbackModel: ZHIPU_FALLBACK_MODEL };
  return { provider: 'poixe', apiModel: modelId || '', fallbackModel: ZHIPU_FALLBACK_MODEL };
}

app.get('/api/models', requireAuth, async (req, res) => {
  try {
    const { resp, base } = await fetchUpstream('/models', {}); // key 自动注入
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!resp.ok) return res.status(resp.status).json({ error: '上游错误', detail: data, endpoint: base });
    const all = Array.isArray(data.data) ? data.data.map(m => m.id) : [];
    // 不可用模型（enabled:false）不再下发，前端只显示可用模型
    const builtinAvail = BUILTIN_FREE_MODELS.filter(m => m.enabled);
    const builtinIds = new Set(BUILTIN_FREE_MODELS.map(m => m.id));
    const upstreamExtra = all.filter(id => classifyModel(id) === 'free' && !id.endsWith(':free') && !builtinIds.has(id))
      .map(id => ({ id, enabled: true }));
    // 智谱模型：只下发 id/名称/能力（供应商与价格不在列表展示，付费由后端管控）
    const zhipuModels = ZHIPU_MODELS.map(m => {
      const o = { id: m.id, name: m.name, caps: m.caps || [], kind: m.kind || 'chat', enabled: true };
      if (m.id === 'zhipu:glm-tts') { o.enabled = false; o.note = '付费语音合成，需先充值'; } // 需单独语音资源包，当前余额不足
      return o;
    });
    const free = [...builtinAvail, ...zhipuModels, ...upstreamExtra];
    const paid = []; // 付费 poixe 模型未开通，不下发
    res.json({ free, paid, total: all.length + zhipuModels.length, endpoint: base, paidEnabled: false, spendLimit: SPEND_LIMIT_YUAN });
  } catch (e) {
    // 上游取模型失败时给出常用兜底列表，保证 UI 可用（含智谱模型；不可用模型不下发）
    res.json({
      free: [...BUILTIN_FREE_MODELS.filter(m => m.enabled), ...ZHIPU_MODELS.map(m => {
        const o = { id: m.id, name: m.name, caps: m.caps || [], kind: m.kind || 'chat', enabled: true };
        if (m.id === 'zhipu:glm-tts') { o.enabled = false; o.note = '付费语音合成，需先充值'; }
        return o;
      })],
      paid: [],
      fallback: true, paidEnabled: false, spendLimit: SPEND_LIMIT_YUAN
    });
  }
});

// 付费模型累计消费查询
app.get('/api/spend', requireAuth, (req, res) => {
  res.json({ spent: Math.round(getSpent() * 10000) / 10000, limit: SPEND_LIMIT_YUAN, remaining: Math.max(0, Math.round((SPEND_LIMIT_YUAN - getSpent()) * 10000) / 10000) });
});

// 端点健康状态
app.get('/api/endpoints', requireAuth, (req, res) => {
  const poixe = UPSTREAM_ENDPOINTS.filter(e => e.provider === 'poixe');
  res.json({
    active: poixe[activeEndpointIdx] ? poixe[activeEndpointIdx].base : '',
    list: UPSTREAM_ENDPOINTS.map(ep => ({
      provider: ep.provider,
      name: ep.name,
      url: ep.base,
      ...(endpointStatus[ep.name] || { ok: null, checkedAt: 0, lastError: '' })
    }))
  });
});

// 心跳（不需要登录，前端定期检测后端是否存活）
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ts: Date.now() });
});

// ============ 项目式编程：原生 ZIP 打包（零外部依赖，zlib deflate + 手写 CRC32） ============
const zlib = require('zlib');
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32Buf(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const u16 = (n) => Buffer.from([n & 0xFF, (n >> 8) & 0xFF]);
const u32 = (n) => Buffer.from([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]);
// files: [{ path: '相对路径', content: '文本内容' }]
function buildZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(String(f.path).replace(/\\/g, '/'), 'utf8');
    const contentBuf = Buffer.from(String(f.content == null ? '' : f.content), 'utf8');
    const comp = zlib.deflateRawSync(contentBuf, { level: 9 });
    const crc = crc32Buf(contentBuf);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8),
      u16(0), u16(0x21), u32(crc),
      u32(comp.length), u32(contentBuf.length),
      u16(nameBuf.length), u16(0),
      nameBuf, comp
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8),
      u16(0), u16(0x21), u32(crc),
      u32(comp.length), u32(contentBuf.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(offset),
      nameBuf
    ]));
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(centralBuf.length), u32(offset), u16(0)
  ]);
  return Buffer.concat([...locals, centralBuf, eocd]);
}
// 项目打包接口：前端把项目文件列表发来，后端返回 zip
app.post('/api/zip', requireAuth, (req, res) => {
  const { name, files } = req.body || {};
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: '缺少项目文件' });
  const clean = files
    .filter(f => f && typeof f.path === 'string' && f.path.trim())
    .map(f => ({ path: f.path.replace(/^[./\\]+/, '').replace(/\\/g, '/'), content: f.content }))
    .filter(f => !f.path.includes('..'));
  if (!clean.length) return res.status(400).json({ error: '没有可打包的文件' });
  const zipName = String(name || 'project').replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'project';
  try {
    const zip = buildZip(clean);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}.zip`);
    res.send(zip);
  } catch (e) {
    console.log('[zip] 打包失败:', e.message);
    res.status(500).json({ error: '打包失败: ' + e.message });
  }
});

// ============ 生成类模型统一接口（图像 / 视频 / TTS），SSE 推送进度与结果 ============
const ZHIPU_DIRECT_BASE = 'https://open.bigmodel.cn/api/paas/v4';
app.post('/api/generate', requireAuth, async (req, res) => {
  const { model, prompt, voice, size } = req.body || {};
  const meta = ZHIPU_MODELS.find(m => m.id === model);
  if (!meta || !meta.kind || meta.kind === 'chat') return res.status(400).json({ error: '该模型不支持生成' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // 后台继续生成：关闭页面后生成照常完成并保存到 data
  let clientClosed = false;
  res.on('close', () => { clientClosed = true; });
  const send = (event, data) => {
    if (clientClosed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };
  const headers = { 'Authorization': 'Bearer ' + ZHIPU_KEY, 'Content-Type': 'application/json' };
  const friendlyLimit = (code, msg) =>
    /1113|余额不足|无可用资源|请充值/.test(String(code) + String(msg))
      ? '该模型需付费，当前账户余额/资源包不足，请充值或换一个免费模型'
      : (/1305|429|限流|访问量过大/.test(String(code) + String(msg))
        ? '该模型当前免费额度限流，请稍后再试或换一个模型'
        : (msg || '生成失败'));
  try {
    if (meta.kind === 'image_gen') {
      const r = await fetch(ZHIPU_DIRECT_BASE + '/images/generations', {
        method: 'POST', headers,
        body: JSON.stringify({ model: meta.apiModel, prompt, size: size || '1024x1024' })
      });
      const j = await r.json();
      if (!r.ok) { send('error', { message: friendlyLimit(j.error?.code, j.error?.message) }); return res.end(); }
      send('result', { type: 'image', url: j.data?.[0]?.url });
      send('done', {});
      return res.end();
    }
    if (meta.kind === 'tts') {
      const r = await fetch(ZHIPU_DIRECT_BASE + '/audio/speech', {
        method: 'POST', headers,
        body: JSON.stringify({ model: meta.apiModel, input: prompt, voice: voice || 'tongtong' })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        send('error', { message: friendlyLimit(j.error?.code, j.error?.message) });
        return res.end();
      }
      const buf = Buffer.from(await r.arrayBuffer());
      send('result', { type: 'audio', data: buf.toString('base64'), format: 'wav' });
      send('done', {});
      return res.end();
    }
    if (meta.kind === 'video_gen') {
      const cr = await fetch(ZHIPU_DIRECT_BASE + '/videos/generations', {
        method: 'POST', headers,
        body: JSON.stringify({ model: meta.apiModel, prompt })
      });
      const cj = await cr.json();
      if (!cr.ok) { send('error', { message: friendlyLimit(cj.error?.code, cj.error?.message) }); return res.end(); }
      const taskId = cj.id;
      send('progress', { status: 'PROCESSING', message: '视频生成中，通常需要 1-3 分钟…' });
      const t0 = Date.now();
      while (Date.now() - t0 < 300000) {
        await new Promise(r => setTimeout(r, 6000));
        const pr = await fetch(ZHIPU_DIRECT_BASE + '/async-result/' + taskId, { headers });
        const pj = await pr.json();
        if (pj.task_status === 'SUCCESS') {
          send('result', { type: 'video', url: pj.video_result?.[0]?.url });
          send('done', {});
          return res.end();
        }
        if (pj.task_status === 'FAIL') {
          send('error', { message: '视频生成失败：' + (pj.task_status_msg || '请稍后重试') });
          return res.end();
        }
        send('progress', { status: pj.task_status });
      }
      send('error', { message: '视频生成超时，请稍后重试' });
      return res.end();
    }
  } catch (e) {
    send('error', { message: '生成失败：' + e.message });
    return res.end();
  }
});

// ---- 聊天（SSE 流式） ----
// ============ 网页搜索（多引擎：必应/360/搜狗/百度/DDG 公共聚合） ============
function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
async function fetchWithTimeout(url, headers = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============ 防封禁层：UA 池轮换 + 浏览器伪装头 + 随机抖动 + 指数退避 + 熔断冷却 ============
// 搜索引擎固定用桌面 UA（移动 UA 会拿到移动版 HTML，桌面解析器会失效丢链接）
const DESKTOP_UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15'
];
const MOBILE_UA = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
];
const UA_POOL = DESKTOP_UA;
function pickUA() { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 引擎熔断：连续被封（403/429/验证码）后短暂冷却 2 秒（发布环境快速重试）
const ENGINE_COOLDOWN_MS = 2000;
const engineCooldown = new Map();
function isCooling(name) { const t = engineCooldown.get(name); return t && Date.now() < t; }
function tripBreaker(name, coolMs) {
  const until = Date.now() + coolMs;
  engineCooldown.set(name, until);
  console.log('[search] 引擎冷却:', name, Math.round(coolMs / 1000) + 's');
}
async function politeFetch(url, opts = {}) {
  const { name = 'web', headers = {}, timeoutMs = 8000, retries = 2 } = opts;
  if (isCooling(name)) throw new Error('引擎冷却中: ' + name);
  let origin;
  try { origin = new URL(url).origin + '/'; } catch (_) { origin = 'https://www.google.com/'; }
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 首请求随机抖动 60~240ms；重试短暂等待 200ms + 抖动（冷却仅 2 秒，不做长退避）
    if (attempt === 0) await sleep(60 + Math.random() * 180);
    else await sleep(200 + Math.random() * 200);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': pickUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Referer': origin,
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
          ...headers
        },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (r.status === 429 || r.status === 403 || r.status === 503 || r.status === 418) {
        lastErr = new Error('HTTP ' + r.status);
        tripBreaker(name, ENGINE_COOLDOWN_MS);
        if (attempt < retries) continue;
      }
      return r;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e.name === 'AbortError' && attempt < retries) continue;
    }
  }
  throw lastErr || new Error('请求失败');
}

// 解析百度结果（带随机 BAIDUID 尽量避开验证码；验证码页返回空）
function parseBaiduResults(html, limit = 6) {
  if (!html || html.includes('wappass.baidu.com') || html.includes('百度安全验证')) return [];
  const results = [];
  const h3s = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)];
  for (const m of h3s) {
    const a = m[1].match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const title = decodeHtmlEntities(a[2].replace(/<[^>]+>/g, '')).trim();
    if (!title || results.some(r => r.title === title)) continue;
    let url = a[1].trim();
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = 'https://www.baidu.com' + url;
    const after = html.slice(m.index, m.index + 3000);
    let snippet = '';
    const ab = after.match(/class="[^"]*(?:c-abstract|content-right_)[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/);
    if (ab) snippet = decodeHtmlEntities(ab[1].replace(/<[^>]+>/g, '')).trim();
    results.push({ title, snippet, url });
    if (results.length >= limit) break;
  }
  return results;
}
async function baiduSearch(q, limit = 6) {
  const bid = crypto.randomBytes(16).toString('hex').toUpperCase();
  const r = await politeFetch('https://www.baidu.com/s?wd=' + encodeURIComponent(q) + '&rn=10', {
    name: '百度',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Cookie': 'BAIDUID=' + bid + ':FG=1'
    }
  });
  const html = await r.text().catch(() => '');
  if (html.includes('wappass.baidu.com') || html.includes('百度安全验证') || /验证码|captcha/i.test(html)) tripBreaker('百度', ENGINE_COOLDOWN_MS);
  return parseBaiduResults(html, limit);
}
// 解析必应结果
function parseBingResults(html, limit = 6) {
  const results = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1).slice(0, limit);
  for (const b of blocks) {
    const titleM = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) {
      const fallback = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      if (!fallback) continue;
      var titleOnly = fallback;
    }
    const title = decodeHtmlEntities((titleM ? titleM[2] : titleOnly[1]).replace(/<[^>]+>/g, '')).trim();
    if (!title || results.some(r => r.title === title)) continue;
    let url = titleM ? titleM[1].trim() : '';
    if (url.startsWith('//')) url = 'https:' + url;
    const bodyM = b.match(/<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const snippet = bodyM ? decodeHtmlEntities(bodyM[1].replace(/<[^>]+>/g, '')).trim() : '';
    results.push({ title, snippet, url });
  }
  return results;
}
async function bingSearch(q, limit = 6) {
  const r = await politeFetch('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&mkt=zh-CN', {
    name: '必应'
  });
  const html = await r.text().catch(() => '');
  if (/验证码|captcha|b_results.*没有找到与此相关的结果/i.test(html.slice(0, 4000)) && /captcha/i.test(html)) tripBreaker('必应', ENGINE_COOLDOWN_MS);
  return parseBingResults(html, limit);
}
// 解析搜狗结果
function parseSogouResults(html, limit = 6) {
  if (!html || /antispider|安全验证|请输入验证码/.test(html)) return [];
  const results = [];
  const blocks = html.split(/<div class="vrwrap"/).slice(1).slice(0, limit);
  for (const b of blocks) {
    const titleM = b.match(/<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    let url = titleM[1].trim();
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = 'https://www.sogou.com' + url;
    const title = decodeHtmlEntities(titleM[2].replace(/<[^>]+>/g, '')).trim();
    if (!title || results.some(r => r.title === title)) continue;
    const snM = b.match(/class="[^"]*(?:str_info|text-layout|space-txt)[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/);
    const snippet = snM ? decodeHtmlEntities(snM[1].replace(/<[^>]+>/g, '')).trim() : '';
    results.push({ title, snippet, url });
    if (results.length >= limit) break;
  }
  return results;
}
async function sogouSearch(q, limit = 6) {
  const r = await politeFetch('https://www.sogou.com/web?query=' + encodeURIComponent(q), {
    name: '搜狗'
  });
  const html = await r.text().catch(() => '');
  return parseSogouResults(html, limit);
}
// 解析 360 搜索结果
function parseSo360Results(html, limit = 6) {
  if (!html || /验证码|captcha/i.test(html)) return [];
  const results = [];
  const blocks = html.split(/<li class="res-list"/).slice(1).slice(0, limit);
  for (const b of blocks) {
    const titleM = b.match(/<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    let url = titleM[1].trim();
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = 'https://www.so.com' + url;
    const title = decodeHtmlEntities(titleM[2].replace(/<[^>]+>/g, '')).trim();
    if (!title || results.some(r => r.title === title)) continue;
    const snM = b.match(/class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const snippet = snM ? decodeHtmlEntities(snM[1].replace(/<[^>]+>/g, '')).trim() : '';
    results.push({ title, snippet, url });
    if (results.length >= limit) break;
  }
  return results;
}
async function so360Search(q, limit = 6) {
  const r = await politeFetch('https://www.so.com/s?q=' + encodeURIComponent(q), {
    name: '360'
  });
  const html = await r.text().catch(() => '');
  return parseSo360Results(html, limit);
}
// 解析 DuckDuckGo 结果（HTML 版）
function parseDuckDuckGoResults(html, limit = 6) {
  const results = [];
  const blocks = html.split(/class="result__body"/).slice(1).slice(0, limit);
  for (const b of blocks) {
    const titleM = b.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    let url = titleM[1].trim();
    // DDG 跳转链接解码真实地址：//duckduckgo.com/l/?uddg=<encoded>
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch (_) {} }
    if (url.startsWith('//')) url = 'https:' + url;
    const title = decodeHtmlEntities(titleM[2].replace(/<[^>]+>/g, '')).trim();
    if (!title || results.some(r => r.title === title)) continue;
    const snM = b.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snM ? decodeHtmlEntities(snM[1].replace(/<[^>]+>/g, '')).trim() : '';
    results.push({ title, snippet, url });
    if (results.length >= limit) break;
  }
  return results;
}
async function duckduckgoSearch(q, limit = 6) {
  const r = await politeFetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    name: 'DuckDuckGo'
  });
  const html = await r.text().catch(() => '');
  return parseDuckDuckGoResults(html, limit);
}
// 统一入口：必应+360+搜狗+百度+DDG 多路并行聚合（公共搜索引擎，适配 AI 场景），全空时顺序回退
async function searchWeb(q, limit = 6) {
  const engines = [
    { name: '必应', fn: () => bingSearch(q, limit) },        // 实测最可靠（10 条，摘要完整）
    { name: '360', fn: () => so360Search(q, limit) },       // 实测可用（7 条）
    { name: '搜狗', fn: () => sogouSearch(q, limit) },
    { name: '百度', fn: () => baiduSearch(q, limit) },
    { name: 'DuckDuckGo', fn: () => duckduckgoSearch(q, limit) }
  ];
  // 主力三引擎并行（跳过冷却中的引擎：必应 + 360 + 搜狗）
  const main = await Promise.all(engines.slice(0, 3).map(async (e) => {
    try {
      if (isCooling(e.name)) return { name: e.name, results: [] };
      const results = await e.fn();
      return { name: e.name, results: results.map(x => ({ ...x, _engine: e.name })) };
    } catch (_) { return { name: e.name, results: [] }; }
  }));
  let merged = [];
  const usedEngines = [];
  for (const r of main) {
    if (r.results && r.results.length) { usedEngines.push(r.name); merged.push(...r.results); }
  }
  // 主力全空 → 顺序尝试其余引擎（跳过冷却中的引擎）
  if (!merged.length) {
    for (const e of engines.slice(3)) {
      if (isCooling(e.name)) continue;
      try {
        const results = await e.fn();
        if (results.length) { merged = results.map(x => ({ ...x, _engine: e.name })); usedEngines.push(e.name); break; }
      } catch (_) {}
    }
  }
  // 标题归一化去重
  const seen = new Set();
  const dedup = [];
  for (const r of merged) {
    const key = String(r.title || '').replace(/\s/g, '').slice(0, 20);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(r);
  }
  // 按引擎可靠性排序（必应→360→搜狗→百度→DDG），同引擎内摘要更丰富者优先，保证结果质量
  const engineRank = {};
  engines.forEach((e, i) => { engineRank[e.name] = i; });
  const ordered = dedup.map((r, i) => ({ r, i }))
    .sort((a, b) =>
      (engineRank[a.r._engine] - engineRank[b.r._engine]) ||
      (String(b.r.snippet || '').length - String(a.r.snippet || '').length) ||
      (a.i - b.i))
    .map(x => x.r)
    .slice(0, limit);
  return { results: ordered, engine: usedEngines.join('+') || '' };
}

// ============ 自动搜索决策 + 对话记忆 ============
// 主对话系统提示：有搜索结果时基于结果作答；用户要表格/对照表时整理成 Markdown 表格
const CHAT_SYSTEM_PROMPT = `你是 AI 助手，用中文简洁、有条理地回答用户问题。
- 当上下文提供了【搜索结果】时，优先基于搜索结果回答，并概括信息来源（如"根据搜索结果"）。
- 当用户要求"表格/对照表/对比表/整理成表"时，把信息整理成清晰的 Markdown 表格，尽量覆盖用户关心的维度（价格、配置、优缺点等），不要只回复"找不到对照表"，零散报价也可以整理成表。
- 回答中使用自然的中文。`;

// 项目式编程系统提示：要求 AI 输出完整、可运行的多文件项目，每个文件用代码块+文件名标注
const PROJECT_SYSTEM_PROMPT = `你是资深全栈工程师，任务是根据用户需求构建一个完整、可直接运行的项目。
严格按以下格式输出：
1. 先用一两句话说明技术方案，然后用 Markdown 代码块给出项目文件树（标注语言为 text），例如：
   \`\`\`text
   my-app/
   ├── index.html
   ├── style.css
   └── app.js
   \`\`\`
2. 为项目中的每一个文件生成独立的 Markdown 代码块，围栏第一行必须标注 "语言:相对路径"，例如：
   \`\`\`html:index.html
   \`\`\`css:style.css
   \`\`\`js:app.js
   \`\`\`md:README.md
要求：
- 代码必须完整、可直接运行，禁止省略，禁止出现 "// 其余代码省略"、"// 此处略" 等占位。
- 必须包含 README.md，说明项目功能、如何运行/打开。
- 路径使用相对路径；需要子目录时用 src/、assets/ 等，路径中用正斜杠 /。
- 前端页面项目要把 HTML/CSS/JS 拆分为独立文件，并保证相互引用路径正确。
- 完整覆盖用户提出的所有功能点，不要遗漏。`;

// 自动搜索决策提示词：让模型基于完整对话历史输出是否联网 + 搜索关键词
const SEARCH_DECISION_PROMPT = `你是联网搜索决策器。根据对话历史判断：要正确回答用户最新的消息，是否需要联网搜索获取外部信息。
只输出一个 JSON 对象，不要输出任何其他文字、解释或代码块标记，格式如下：
{"need_search":true或false,"search_query":"搜索关键词（need_search 为 false 时留空字符串）"}

判断规则：
1. 涉及价格、报价、行情、费用、多少钱、实时数据、最新资讯、新闻、政策、产品参数对比、需要外部事实才能回答 → need_search=true
2. 用户明确要求整理成"表格/对照表/对比表"时，search_query 中必须包含"表格"或"对照表"字样
3. 纯创作、写文案、润色、翻译、解释常识、头脑风暴、讲故事、寒暄 → need_search=false
4. 凡是关于"你（AI助手）自身"的问题一律 need_search=false，例如：你是谁、你是干什么的、你可以/能/会做什么、你有什么功能、介绍一下你自己、你和XX有什么区别、你怎么用。
5. 用户直接发出搜索指令时一律 need_search=true，例如"搜索一下/搜一下/查一下/帮我搜/联网查/百度一下+主题"；search_query 提取指令后面的主题；若用户只说"搜索一下新闻/最近的新闻"，query 写成"今日新闻热点"。
6. 搜索关键词必须具体、可执行、面向"拿到内容而非入口"：从对话历史理解代词所指，并补充限定词。
   - 用户只说"新闻/资讯"时，必须带上时间和方向，如"今日新闻热点"、"最新科技新闻"、"深圳今日新闻"——禁止只写"新闻"两个字。
   - 用户之前提到某主题（如服务器价格），后来说"整理成对照表"，搜索词应为"服务器价格对照表"。
   - 查询具体事件/产品/人物时，直接用事件名+年份/地点等限定词。`;

// 关于 AI 助手自身的问题，硬规则不搜索（优先级最高）
const SELF_QUERY_RE = /(你是谁|你是(什么|啥|干嘛|干什麼|干什么)|你(可以|能|会|能够)(做|干|帮|写|提供|支持)?(什么|啥|哪些|什么事|啥事情)|你有什么(功能|能力|本事)|介绍(一下)?你自己|自我介绍|你的功能|你能帮我(做|干)什么|怎么用你|如何使用你)/;
// 用户明确发出搜索指令 → 强制搜索（模型漏判时由程序纠正）
const FORCE_SEARCH_RE = /(搜索一下|搜一下|搜下|搜一搜|搜索|搜一?搜|帮我搜|查一下|查下|查查|查询一下|联网(搜索|搜|查|找|看看)|上网(搜|搜索|查|找)|百度一下|谷歌一下|检索一下|找找(看)?|搜搜)/;
// 从用户原话提取搜索主题（去掉指令前缀）
function extractSearchTopic(text) {
  let q = String(text || '').trim()
    .replace(/^(帮我|请|麻烦|你能|你可以|能不能|可否|可以)?\s*/g, '')
    .replace(/^(上网|联网)?\s*(搜索一下|搜一下|搜下|搜一搜|搜索|搜搜|搜|查一下|查下|查查|查询一下|查询|查|百度一下|谷歌一下|检索一下|检索|找一下|找找看|找找|找|看看)\s*(一下|下)?\s*/g, '')
    .replace(/[?？!！。.，,\s]+$/g, '')
    .trim();
  return q.slice(0, 80);
}
// 搜索词质量修正：空词/泛词补全为可拿到内容的具体词
function refineSearchQuery(q, rawText) {
  let query = String(q || '').trim();
  if (!query) query = extractSearchTopic(rawText);
  const d = new Date();
  const dateStr = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  // 纯泛词（新闻/资讯/热点/头条，可能带"最近/最新/今天/有什么"）→ 直接生成带当日日期的具体词
  if (!query || /^(最近的?|最新的?|今天的?|今日|近期|现在|目前)?\s*(有什么|有啥|的|一些|点)?\s*(新闻|资讯|热点|头条|消息|大事|时事)\s*(吗|么|呢|啊)?\s*$/.test(query)) {
    return dateStr + ' 今日新闻头条 最新消息';
  }
  // 含"新闻/资讯"但无时间限定 → 补当日日期，提升具体内容命中率
  if (/(新闻|资讯|热点|头条)/.test(query) && !/(今日|今天|最新|最近|本周|昨天|\d{4}年|\d{1,2}月\d{1,2}日)/.test(query)) {
    query = dateStr + ' ' + query + ' 最新消息';
  }
  return query.slice(0, 80);
}
// 模型决策 JSON 解析失败时的启发式兜底
const SEARCH_HINT_RE = /(价格|报价|行情|费用|多少钱|最新|新闻|资讯|搜索|搜|查一下|查下|对比|对照|表格|查查|推荐哪个|哪家好)/;
function fallbackSearchDecision(text) {
  const raw = String(text || '');
  if (SELF_QUERY_RE.test(raw)) return { need_search: false, search_query: '' };  // 自身介绍类不搜索
  const forced = FORCE_SEARCH_RE.test(raw);
  const need = forced || SEARCH_HINT_RE.test(raw);
  if (!need) return { need_search: false, search_query: '' };
  return { need_search: true, search_query: refineSearchQuery(extractSearchTopic(raw), raw) };
}
// 程序二次校验：模型判断后再纠错（漏判搜索指令→纠正；搜索词空/泛→补全）
function reconcileDecision(decision, raw) {
  const text = String(raw || '');
  let need = !!(decision && decision.need_search);
  let query = decision ? String(decision.search_query || '').trim() : '';
  if (FORCE_SEARCH_RE.test(text)) {
    need = true;   // 明确搜索指令，模型说 false 也纠正为 true
    // 用户已明确给出搜索主题时，以原话主题为准（模型改写容易丢词偏离意图）
    const topic = extractSearchTopic(text);
    if (topic) query = topic;
  }
  if (need) query = refineSearchQuery(query, text);
  return { need_search: need, search_query: need ? query : '' };
}

// 让模型判断是否需要联网搜索（基于完整对话历史）
async function decideSearch(model, history, userMessage) {
  // 硬规则：关于 AI 助手自身的问题（你是谁/你能做什么/功能介绍）一律不搜索
  if (SELF_QUERY_RE.test(String(userMessage || ''))) {
    return { need_search: false, search_query: '' };
  }
  const decisionMessages = [
    { role: 'system', content: SEARCH_DECISION_PROMPT },
    ...history.slice(-10).map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
    { role: 'user', content: String(userMessage).slice(0, 500) }
  ];
  const { provider, apiModel, fallbackModel } = resolveModelProvider(model);
  // 智谱辅助任务（搜索决策/标题）固定用稳定免费模型，避免推理模型输出 reasoning 占满 token
  const decideApiModel = provider === 'zhipu' ? ZHIPU_FALLBACK_MODEL : (apiModel || 'gpt-3.5-turbo');
  const task = (async () => {
    const r = await fetchUpstream('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: decideApiModel, messages: decisionMessages, max_tokens: 80, stream: false })
    }, { stream: false, provider, fallbackModel });
    if (!r.resp.ok) return null;
    const j = await r.resp.json();
    const text = (j.choices?.[0]?.message?.content || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (parsed && typeof parsed.need_search === 'boolean') {
      return {
        need_search: parsed.need_search,
        search_query: String(parsed.search_query || '').trim().slice(0, 80)
      };
    }
    return null;
  })();
  try {
    const result = await Promise.race([task, new Promise(r => setTimeout(() => r(null), 6000))]);
    // 模型判断后程序二次校验：漏判搜索指令→纠正；搜索词空/泛→补全
    return reconcileDecision(result || fallbackSearchDecision(userMessage), userMessage);
  } catch (_) {
    return fallbackSearchDecision(userMessage);
  }
}

// 历史消息内容转纯文本：多模态 content 数组（JSON 字符串）还原为文本 + 附件标注
function contentToText(content) {
  const s = String(content || '');
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return arr.map(p => {
        if (!p || typeof p !== 'object') return '';
        if (p.type === 'text') return String(p.text || '');
        if (p.type === 'image_url') return '【图片】';
        if (p.type === 'video_url') return '【视频】';
        if (p.type === 'file') return '【文件】';
        if (p.type === 'input_audio') return '【音频】';
        return '';
      }).filter(Boolean).join('\n');
    }
  } catch (_) {}
  return s;
}

// 历史消息滑动窗口：最多 40 条、总字符约 5 万，超限从最早的开始裁
function buildHistory(rows, maxMsgs = 40, maxChars = 50000) {
  let msgs = (rows || []).map(m => ({ role: m.role, content: contentToText(m.content), audio: m.audio || null }));
  if (msgs.length > maxMsgs) msgs = msgs.slice(-maxMsgs);
  let total = 0, cut = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    total += msgs[i].content.length;
    if (total > maxChars) { cut = i + 1; break; }
  }
  if (cut > 0) msgs = msgs.slice(cut);
  return msgs;
}

// ============ 项目式编程：分步迭代生成 ============
// 把"一次性生成全部文件"改为：AI 先输出分步计划，后端逐步让 AI 生成每一步的文件并写入 data/projects/<对话id>/，
// 每一步的上下文携带"已完成文件清单 + 上一步 READ_FILE 读取结果"，实现 AI 可读取已生成文件、保持代码一致。
const PROJECTS_DIR = path.join(dataDir, 'projects');

const PROJECT_PLAN_PROMPT = `你是资深全栈工程师。用户给你一个项目需求，你需要先把它拆解成若干可独立完成的步骤，再逐步实现。
现在【第一步】只输出分步计划，不要写任何代码。计划格式严格如下：

PLAN_START
STEP 1: 步骤标题 | 文件: 文件1相对路径, 文件2相对路径
STEP 2: 步骤标题 | 文件: 文件3相对路径
...
PLAN_END

要求：
- 每步 1~4 个文件，步骤之间有清晰依赖顺序（先基础配置/核心逻辑，再页面/样式/联调）。
- 完整覆盖用户提出的所有功能点，不遗漏；小项目 2~3 步，大项目不超过 8 步。
- 文件路径用相对路径、正斜杠；前端项目把 HTML/CSS/JS 拆成独立文件。
- 【重要】每步的"文件:"清单必须写全该步要生成的文件路径，用英文逗号分隔，这是后续逐步生成的控制依据。`;

const PROJECT_STEP_PROMPT = `你是资深全栈工程师，正在分步实现一个项目。现在只完成【当前这一步】涉及的文件。
规则：
1. 只输出本步文件，用 Markdown 代码块，围栏第一行标注 "语言:相对路径"，例如：
   \`\`\`html:index.html
   ...完整代码...
   \`\`\`
   \`\`\`js:app.js
   ...完整代码...
   \`\`\`
2. 代码必须完整、可直接运行，禁止省略，禁止出现 "// 其余代码省略"、"// 此处略" 等占位。
3. 【重要】每次只允许输出当前这一步的文件，禁止提前输出后续步骤的文件，禁止一次性生成整个项目——其余文件在后续步骤中逐步生成。
4. 若需要读取已经生成的文件内容来保持代码一致（例如引用它的导出、接口、样式类名），在回复中单独写一行：
   READ_FILE: 相对路径
   可以写多行（每行一个路径），程序会把文件内容在下一步提供给你。
5. 仅当这是最后一步、整个项目已经全部完成时，才在回复末尾单独输出一行：PROJECT_DONE；非最后一步即使本步完成也不要输出该标记。`;

function sanitizeRel(p) {
  return String(p || '').replace(/^[./\\]+/, '').replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '');
}
function parseFileBlocks(text) {
  const out = [];
  const re = /```([\w.+-]+):([\w./-]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) { const p = sanitizeRel(m[2]); if (p) out.push({ path: p, content: m[3].replace(/\n+$/, '') }); }
  return out;
}
function parseSteps(text) {
  const out = [];
  const re = /STEP\s*(\d+)\s*[:：]\s*([^\n|]+)(?:\|?\s*文件\s*[:：]?\s*(.*))?/gi;
  let m;
  while ((m = re.exec(text))) {
    out.push({ title: m[2].trim().slice(0, 40), files: (m[3] || '').split(/[,，、]/).map(s => sanitizeRel(s)).filter(Boolean) });
  }
  return out;
}

async function handleProjectChat(req, res, conv, rawText, effectiveModel) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // 后台继续生成：客户端关闭后迭代照常跑完并保存到 data
  let clientClosed = false;
  res.on('close', () => { clientClosed = true; });
  const send = (event, data) => {
    if (clientClosed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };

  // 项目迭代统一走智谱（代码生成最稳）；用户选了非智谱模型时自动用免费 glm-4-flash 执行
  const prov = effectiveModel ? resolveModelProvider(effectiveModel).provider : 'zhipu';
  const apiModel = prov === 'zhipu' ? String(effectiveModel).replace(/^zhipu:/, '') : 'glm-4-flash';
  const zhipuOnce = async (messages) => {
    const body = { model: apiModel, messages, stream: false, max_tokens: 8000 };
    const resp = await fetch(ZHIPU_DIRECT_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + ZHIPU_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('上游 ' + resp.status + ': ' + t.slice(0, 200));
    }
    const j = await resp.json().catch(() => null);
    return (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  };

  const convId = conv.id;
  // 项目文件不落盘：全部经 SSE 推给前端，由使用用户的浏览器设备（IndexedDB）保存；服务器仅内存中转
  const written = [];
  try {
    // 0) start 事件：告知前端对话 id（版本管理/会话切换需要）
    send('start', { conversation_id: convId, title: conv.title, user_message_id: 0 });
    // 1) 规划：AI 输出分步计划
    send('plan_start', {});
    const planText = await zhipuOnce([
      { role: 'system', content: PROJECT_PLAN_PROMPT },
      { role: 'user', content: rawText }
    ]);
    let steps = parseSteps(planText);
    if (!steps.length) steps = [{ title: '整体实现', files: [] }];
    send('plan', { total: steps.length, steps: steps.map(s => s.title) });
    send('delta', { text: '\n📋 分步计划（' + steps.length + ' 步）已生成，开始逐步实现：\n' });

    // 2) 逐步执行：每步一轮上游调用；支持 READ_FILE 读取已生成文件
    let readCarry = '';
    for (let i = 0; i < steps.length && !clientClosed; i++) {
      send('step_start', { index: i + 1, total: steps.length, title: steps[i].title });
      const existing = written.map(f => f.path).join(', ') || '（暂无）';
      const stepUser = [
        '项目需求：' + rawText,
        '当前进度：第 ' + (i + 1) + '/' + steps.length + ' 步「' + steps[i].title + '」',
        '已完成文件：' + existing,
        readCarry ? '你上次请求读取的文件内容：\n' + readCarry : '',
        steps[i].files.length ? '本步应生成文件：' + steps[i].files.join(', ') : '',
        '请只输出本步文件（代码块标注 语言:路径），如需读取已生成文件请写 READ_FILE: 路径。',
        (i === steps.length - 1) ? '这是最后一步，完成后在末尾输出 PROJECT_DONE' : ''
      ].filter(Boolean).join('\n');
      const out = await zhipuOnce([
        { role: 'system', content: PROJECT_STEP_PROMPT },
        { role: 'user', content: stepUser }
      ]);
      // READ_FILE：读取已生成文件内容，注入下一步上下文（AI 读取文件的权限）
      const reads = [...out.matchAll(/READ_FILE:\s*([^\n]+)/gi)].map(m => sanitizeRel(m[1])).filter(Boolean);
      if (reads.length) {
        const parts = [];
        for (const r of reads) { const f = written.find(w => w.path === r); if (f) parts.push('=== ' + r + ' ===\n' + f.content); }
        readCarry = parts.join('\n\n');
      } else { readCarry = ''; }
      // 解析代码块 → 只写本步计划内文件（AI 若提前输出后续步骤文件则忽略，强制真正分步）
      let blocks = parseFileBlocks(out);
      if (steps[i].files && steps[i].files.length) {
        const allowed = new Set(steps[i].files);
        blocks = blocks.filter(b => allowed.has(b.path));
      }
      for (const b of blocks) {
        written.push(b);
        send('file', { path: b.path, index: i + 1, total: steps.length });
      }
      send('step_done', { index: i + 1 });
      // 只有最后一步的 PROJECT_DONE 才视为项目完成；非最后一步出现该标记时忽略并继续
      if (/PROJECT_DONE/.test(out) && i === steps.length - 1) break;
    }
    // 3) 完成：推送全部文件（按路径去重，保留最后一次内容；前端直接渲染项目卡片）
    const finalFiles = Object.values(written.reduce((acc, f) => { acc[f.path] = f; return acc; }, {}));
    send('project_done', { files: finalFiles, steps: steps.length });
  } catch (e) {
    send('error', { status: 500, message: '项目生成失败：' + e.message });
    return res.end();
  }

  // 入库：用户需求 + 汇总回复；标题用需求前 12 字（不再异步调标题模型，加快收尾）
  try {
    const chatModel = effectiveModel || 'zhipu:glm-4-flash';
    db.prepare('INSERT INTO messages (conversation_id, role, content, model, created_at) VALUES (?,?,?,?,?)')
      .run(convId, 'user', rawText, chatModel, now());
    const finalFiles = Object.values(written.reduce((acc, f) => { acc[f.path] = f; return acc; }, {}));
    const summary = '项目已分步生成完成，共 ' + finalFiles.length + ' 个文件：\n' +
      finalFiles.map(f => '- ' + f.path).join('\n') +
      '\n\n可点击「下载 ZIP」获取完整代码。';
    db.prepare('INSERT INTO messages (conversation_id, role, content, model, created_at) VALUES (?,?,?,?,?)')
      .run(convId, 'assistant', summary, chatModel, now());
    const title = rawText.replace(/\s+/g, ' ').trim().slice(0, 12) || '项目';
    db.prepare('UPDATE conversations SET title=?, model=?, updated_at=? WHERE id=?').run(title, chatModel, now(), convId);
  } catch (_) {}
  res.end();
}


// ============ OpenClaw 兼容层（OpenAI 协议） ============
// APK 内置的 OpenClaw 把 models.providers.aichat.baseUrl 指向这里：
// 模型调用走后端（复用智谱 key 与免费额度），工具调用在设备 Termux 内执行。
const AGENT_SHARED_KEY = process.env.AICHAT_AGENT_KEY || '';

function agentAuthOk(req) {
  const h = req.headers.authorization || '';
  const tok = h.replace(/^Bearer\s+/i, '').trim();
  if (!tok) return false;
  if (tok === AGENT_SHARED_KEY) return true;
  return !!getSessionUser(req);
}

app.get('/v1/models', (req, res) => {
  if (!agentAuthOk(req)) return res.status(401).json({ error: { message: 'invalid api key', type: 'invalid_request_error' } });
  const data = ZHIPU_MODELS.map(m => ({ id: 'aichat-' + m.id, object: 'model', owned_by: 'aichat' }));
  res.json({ object: 'list', data });
});

app.post('/v1/chat/completions', async (req, res) => {
  if (!agentAuthOk(req)) return res.status(401).json({ error: { message: 'invalid api key', type: 'invalid_request_error' } });
  const body = JSON.parse(JSON.stringify(req.body || {}));
  const rawModel = String(body.model || '').replace(/^aichat-/, '');
  const z = ZHIPU_MODELS.find(m => m.id === rawModel)
    || ZHIPU_MODELS.find(m => m.apiModel === rawModel)
    || { apiModel: ZHIPU_FALLBACK_MODEL };
  body.model = z.apiModel;
  delete body.user;
  // OpenClaw 只发 OpenAI 字段，智谱 v4 与 OpenAI 协议兼容，tools/tool_choice/stream 原样透传
  try {
    const upstream = await fetch(ZHIPU_DIRECT_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + ZHIPU_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!body.stream) {
      const txt = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', 'application/json');
      return res.send(txt);
    }
    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: { message: '上游模型请求失败: ' + e.message } });
    else res.end();
  }
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const { conversation_id, message, model, max_tokens, node, web_mode, thinking, project } = req.body || {};
  // message 支持两种：字符串（纯文本）或数组（多模态 content，仅智谱模型支持）
  const isContentArray = Array.isArray(message);
  const rawText = isContentArray
    ? (message.filter(p => p && p.type === 'text').map(p => String(p.text || '')).join('\n') || ' ')
    : String(message || '');
  if (!rawText.trim()) return res.status(400).json({ error: '消息不能为空' });

  // 联网/搜索模式：auto(自动) / on(强制联网) / off(关闭) / deep(深度搜索=强制联网+深度思考)
  const mode = ['auto', 'on', 'off', 'deep'].includes(web_mode) ? web_mode : 'auto';

  const effectiveModel = model || '';
  const tier = effectiveModel ? classifyModel(effectiveModel) : 'free';
  if (tier === 'paid' && !PAID_ENABLED) {
    return res.status(403).json({ error: '付费模型暂不可用，请选择免费模型' });
  }

  // 多模态内容仅智谱模型支持：必须在 SSE 头 flush 之前拒绝，否则会 ERR_HTTP_HEADERS_SENT
  if (isContentArray) {
    const earlyProvider = effectiveModel ? resolveModelProvider(effectiveModel).provider : 'poixe';
    if (earlyProvider !== 'zhipu') {
      return res.status(400).json({ error: '图片/视频/文件/语音等多媒体内容仅智谱模型支持，请先切换到智谱模型' });
    }
  }

  let conv;
  if (conversation_id) {
    conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(conversation_id, req.user.id);
    if (!conv) return res.status(404).json({ error: '会话不存在' });
  } else {
    // 游客限制：最多 3 个对话（新建对话前检查）
    if (isGuestUser(req.user)) {
      const cnt = db.prepare('SELECT COUNT(*) AS c FROM conversations WHERE user_id = ?')
        .get(req.user.id).c;
      if (cnt >= GUEST_MAX_CONVERSATIONS) {
        return res.status(403).json({ error: `游客模式最多创建 ${GUEST_MAX_CONVERSATIONS} 个对话，登录后解锁全部功能` });
      }
    }
    // 初始标题先用"新的对话"，AI 回复完后异步总结替换
    const info = db.prepare(
      'INSERT INTO conversations (user_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)'
    ).run(req.user.id, '新的对话', effectiveModel || '', now(), now());
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
  }

  // 游客限制：每个对话最多 10 条消息
  if (isGuestUser(req.user)) {
    const mc = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?')
      .get(conv.id).c;
    if (mc >= GUEST_MAX_MESSAGES_PER_CONV) {
      return res.status(403).json({ error: `游客模式每个对话最多 ${GUEST_MAX_MESSAGES_PER_CONV} 条消息，登录后解锁全部功能` });
    }
  }

  // 项目式编程：分步迭代生成（AI 分割任务 → 逐步生成 → 可读取已生成文件 → 结果自动保存 data/projects）
  if (project) return handleProjectChat(req, res, conv, rawText, effectiveModel);

  // SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // 后台继续生成：客户端关闭/切换对话/关闭标签页后，生成任务照常跑完并保存到 data。
  // 检测 res 关闭后 send 静默，生成循环与写库不受影响；下次打开页面可拉取到完整结果。
  let clientClosed = false;
  res.on('close', () => { clientClosed = true; });
  const send = (event, data) => {
    if (clientClosed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };

  // ---- 对话记忆：先保存用户消息，再读完整历史（重试场景特殊处理）----
  const isRetry = !!(req.body && req.body.retry);
  const chatModel = effectiveModel || conv.model || 'gpt-3.5-turbo';
  // 模型 Provider 与智谱能力解析（多模态/深度思考仅智谱模型可用）
  const { provider, apiModel, fallbackModel } = resolveModelProvider(chatModel);
  const zhipuMeta = provider === 'zhipu' ? (ZHIPU_MODELS.find(m => m.id === chatModel) || null) : null;
  const supportsThinking = !!zhipuMeta && zhipuMeta.caps.includes('think');
  // 每日额度（¥1）：免费与付费模型统一计量，超额一律拒绝（端上也有同样的本地计量）
  const meteredZhipu = !!zhipuMeta && (zhipuMeta.free || (zhipuMeta.price && !zhipuMeta.free));
  if (meteredZhipu && getSpent() >= SPEND_LIMIT_YUAN) {
    send('error', {
      status: 402,
      message: '今日额度已达 ¥' + SPEND_LIMIT_YUAN + ' 上限（今日已用 ¥' + getSpent().toFixed(2) + '，含免费模型），明日 0 点自动重置'
    });
    return res.end();
  }
  const useThinking = supportsThinking && (thinking === true || mode === 'deep');
  let historyRows;
  let userMessageId = null;
  if (isRetry) {
    // 重试：删除上次用户消息之后的旧助手回复，避免历史里出现两条相同回复；不重复保存用户消息
    const lastUser = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND role = ? ORDER BY id DESC LIMIT 1').get(conv.id, 'user');
    if (lastUser) {
      userMessageId = lastUser.id;
      db.prepare('DELETE FROM messages WHERE conversation_id = ? AND role = ? AND id > ?').run(conv.id, 'assistant', lastUser.id);
      historyRows = db.prepare('SELECT role, content, audio FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id ASC').all(conv.id, lastUser.id);
    } else {
      historyRows = [];
    }
  } else {
    // 正常发送：用户消息立即入库（记忆修复的关键，之前只存助手消息导致上下文丢失）
    // 多模态数组以 JSON 字符串入库，回放时前端可还原
    const storeContent = isContentArray ? JSON.stringify(message) : rawText;
    const msgInfo = db.prepare('INSERT INTO messages (conversation_id, role, content, model, created_at) VALUES (?,?,?,?,?)')
      .run(conv.id, 'user', storeContent, chatModel, now());
    userMessageId = msgInfo.lastInsertRowid;
    historyRows = db.prepare('SELECT role, content, audio FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(conv.id);
  }
  const history = buildHistory(historyRows);

  // start 事件携带用户消息 id，前端用它支持"点击用户消息即可修改"
  send('start', { conversation_id: conv.id, title: conv.title, user_message_id: userMessageId });

  // ---- 联网/深度搜索：根据模式决定是否触发、如何触发 ----
  // mode === 'off'  → 完全跳过搜索
  // mode === 'on'  → 强制联网：用消息原文做关键词，不再让 AI 决策
  // mode === 'deep'→ 深度搜索：强制联网 + 深度思考
  // mode === 'auto'→ 交给 decideSearch 让 AI 判断
  let webContext = '';
  let shouldSearch = false;
  let forcedQuery = '';
  if (mode === 'off') {
    shouldSearch = false;
  } else if (mode === 'on' || mode === 'deep') {
    shouldSearch = true;
    forcedQuery = rawText.slice(0, 80);
    if (mode === 'deep') {
      send('notice', { message: '深度搜索已开启：深度思考 + 强制联网' });
    }
  } else {
    const decision = await decideSearch(chatModel, history, rawText);
    shouldSearch = !!(decision && decision.need_search);
    forcedQuery = (decision && decision.search_query) ? decision.search_query : rawText.slice(0, 80);
  }

  if (shouldSearch) {
    let searchQ = forcedQuery.slice(0, 80);
    send('search_start', { query: searchQ, mode });
    try {
      let { results, engine } = await searchWeb(searchQ);
      // 入口/栏目页判定：无摘要，或标题是"首页/官网/栏目/频道/排行榜/汇总/速览/早新闻"等且摘要无具体事件信息
      const ENTRY_TITLE_RE = /(首页|主页|入口|官网|官方网站|频道|栏目|排行榜?|排行|汇总|速览|早新闻|晚报|周报|index|portal)/i;
      const CONCRETE_RE = /(发布|宣布|发生|显示|达到|同比|环比|增长|下降|突破|获批|签署|开工|竣工|查获|刑拘|逮捕|事故|地震|台风|降息|加息|发射|上市|召回|\d{1,2}月\d{1,2}日|%)/;
      const isEntry = (r) => {
        const t = String(r.title || ''), s = String(r.snippet || '');
        if (!s || s.length < 12) return true;
        if (ENTRY_TITLE_RE.test(t) && !CONCRETE_RE.test(s)) return true;
        return false;
      };
      // 70% 以上结果是入口/栏目页时，用带日期与"具体事件"的增强词自动重试一次
      if (results.length && results.filter(isEntry).length >= Math.ceil(results.length * 0.7)) {
        const today = new Date();
        const dateStr = today.getFullYear() + '年' + (today.getMonth() + 1) + '月' + today.getDate() + '日';
        const enhanced = (dateStr + ' ' + searchQ + ' 具体事件 最新进展').replace(/\d{4}年\d{1,2}月\d{1,2}日\s+(?=\d{4}年)/, '').slice(0, 80);
        const retry = await searchWeb(enhanced);
        if (retry.results.length && retry.results.filter(isEntry).length < Math.ceil(retry.results.length * 0.7)) {
          results = retry.results; engine = retry.engine; send('search_retry', { query: enhanced, engine });
        }
      }
      if (results.length) {
        webContext = '【' + engine + '搜索结果】\n' + results.map((r, i) => `${i + 1}. ${r.title}${r.snippet ? ' —— ' + r.snippet : ''}${r.url ? '\n   链接：' + r.url : ''}`).join('\n') + '\n\n请根据以上搜索结果回答用户问题（可在回答中注明来源）：\n';
        const sources = results.map(r => ({ title: r.title, url: r.url || '' })).filter(s => s.title);
        send('search_done', { count: results.length, engine, sources });
      } else {
        send('search_done', { count: 0, message: '未找到相关结果' });
      }
    } catch (e) {
      send('search_done', { count: 0, message: '搜索失败：' + e.message });
    }
  }

  // 主对话上下文：完整历史 + 当前消息（带搜索结果；多模态时保留 content 数组）
  // GLM-4-Voice 要求 user content 必须是 list（即使纯文本），否则上游报参数错误
  const isVoiceModel = provider === 'zhipu' && apiModel === 'glm-4-voice';
  const userContent = isContentArray
    ? [...message, { type: 'text', text: (webContext || '') + rawText }]
    : (isVoiceModel
        ? [{ type: 'text', text: (webContext || '') + rawText }]
        : webContext + rawText);
  const messages = [
    { role: 'system', content: project ? PROJECT_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userContent }
  ];
  // GLM-4-Voice：history 中已有的 user 消息也要转成 list；assistant 消息回传上一轮语音（audio.id）作为上下文，
  // 否则上游报 1214「assistant对话中audio.id不能为空」——这正是"第二轮语音无法使用"的根因
  if (isVoiceModel) {
    for (const m of messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        m.content = [{ type: 'text', text: m.content }];
      } else if (m.role === 'assistant' && m.audio && Array.isArray(m.audio) && m.audio.length) {
        const text = typeof m.content === 'string' ? m.content : '';
        m.content = [{ type: 'text', text },
          ...m.audio.map(a => ({ type: 'audio', audio: { id: a.id, format: a.format || 'wav', data: a.data } }))];
      }
    }
  }

  let full = '';
  const voiceAudios = []; // GLM-4-Voice 本轮语音片段（{id,data,format}），用于上下文回传与入库
  let upstreamStatus = 200;
  let lastUsage = null; // 付费模型计费用量（在 try 外声明，供循环结束后的计费逻辑使用）
  let usedBase = '';
  let switchedToZhipu = false;
  try {
    // 用户指定节点
    if (node && UPSTREAM_ENDPOINTS[node]) {
      activeEndpointIdx = Number(node);
    }
    const userMaxTokens = Number(max_tokens) || FREE_MAX_TOKENS;
    // GLM-4-Voice 的 max_tokens 合法范围为 [1,4095]，超出会报参数错误
    const finalMaxTokens = isVoiceModel ? Math.min(userMaxTokens, 4095) : userMaxTokens;
    // 自动续写：达到 max_tokens 被截断时，后端自动发起续写并拼接到同一 SSE，用户看到一次性完整输出
    // voice 模型不自动续写（短对话，避免干扰）；普通模型最多续写 4 轮，防止无限循环
    const AUTO_CONTINUE_MAX = isVoiceModel ? 0 : 4;
    let workingMessages = messages;
    let truncated = false;
    for (let round = 0; round <= AUTO_CONTINUE_MAX; round++) {
      const reqBody = {
        model: apiModel || chatModel,
        messages: workingMessages,
        stream: true,
        max_tokens: finalMaxTokens,
        stream_options: { include_usage: true }
      };
      // 思考开关：用户点了"深度"才显式开启；用户没开时，对可关闭思考的智谱模型显式 disabled，
      // 避免模型擅自输出思维链（GLM-5.3 / 4.7 等强制思考模型无法关闭，只能照常展示）
      let thinkStripper = null;
      if (provider === 'zhipu') {
        const zpName = String(apiModel || '');
        if (useThinking) {
          reqBody.thinking = { type: 'enabled' };
          // Z1 系列思考走 <think> 标签，需要把标签内容转成 think 事件并从正文剥离
          if (ZHIPU_THINK_TAG.has(zpName)) {
            thinkStripper = makeThinkTagStripper((t) => send('think', { text: t }));
          }
        } else if (ZHIPU_DEFAULT_THINK.has(zpName)) {
          reqBody.thinking = { type: 'disabled' };
          // 关闭后 Z1 仍会把思维链包成 <think> 混进正文，直接剥离丢弃
          if (ZHIPU_THINK_TAG.has(zpName)) thinkStripper = makeThinkTagStripper(null);
        }
      }
      const { resp: upstream, base, fallback } = await fetchUpstream('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      }, { stream: true, provider, fallbackModel });
      if (round === 0) {
        switchedToZhipu = !!fallback;
        if (switchedToZhipu) {
          send('notice', { message: '主节点不可用，已自动切换至智谱 AI（' + fallbackModel + '）' });
        }
      }
      upstreamStatus = upstream.status;
      usedBase = base;
      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '');
        let friendly = errText.slice(0, 500) || '上游请求失败';
        if (/insufficient_balance|recharge|余额|充值|insufficient/i.test(errText)) {
          friendly = '服务暂时不可用，请稍后重试或换一个免费模型';
        } else if (/参数(非法|有误|错误)/.test(errText)) {
          // 纯参数错误（如 1210），不能误判成 token 上限
          friendly = '请求参数有误，请重试或换一个模型';
        } else if (/token|context length|maximum|exceeds|too (long|large)|超出.*(上限|长度)|超过.*限制|输入.*过长|上下文.*超/i.test(errText)) {
          friendly = '您输入的内容超过当前免费模型的 token 上限，请精简消息或缩短对话后重试';
        }
        send('error', { status: upstream.status, message: friendly, endpoint: base });
        return res.end();
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      truncated = false;  // 是否因达到 max_tokens 而被截断
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            if (json.usage) lastUsage = json.usage; // 计费用量（include_usage 末帧返回）
            const choice = json.choices?.[0] || {};
            if (choice.finish_reason === 'length') truncated = true;
            const d = choice.delta || {};
            // 深度思考模型：reasoning_content 单独推送；用户未开深度时不展示思维链
            if (d.reasoning_content && useThinking) {
              send('think', { text: d.reasoning_content });
            }
            if (d.content) {
              const text = thinkStripper ? thinkStripper.feed(d.content) : d.content;
              if (text) {
                full += text;
                send('delta', { text });
              }
            }
            // GLM-4-Voice：返回语音（WAV base64），推给前端播放；同时收集 id+data 供上下文回传与入库
            if (d.audio && d.audio.data) {
              send('voice', { data: d.audio.data });
              if (isVoiceModel) voiceAudios.push({ id: d.audio.id || ('v' + (voiceAudios.length + 1)), data: d.audio.data, format: 'wav' });
            }
          } catch (_) {}
        }
      }
      // 流结束：取出剥离器缓冲中剩余的正文（若仍处于 <think> 内则丢弃）
      if (thinkStripper) {
        const tail = thinkStripper.flush();
        if (tail) { full += tail; send('delta', { text: tail }); }
      }
      // 未截断 → 已完整生成，退出循环
      if (!truncated) break;
      // 截断且仍有续写额度 → 追加 assistant 已生成内容 + 续写指令，进入下一轮（静默，内容持续增长）
      if (round < AUTO_CONTINUE_MAX) {
        workingMessages = [
          ...workingMessages,
          { role: 'assistant', content: full },
          { role: 'user', content: '继续，直接从上次中断处接着输出，不要重复已有内容，不要解释或加标题。' }
        ];
      }
    }
    // 达到续写上限仍被截断：才提示用户可手动回复"继续"
    if (truncated) {
      send('notice', { message: '回复已达到长度上限，内容可能不完整。回复“继续”即可接着输出。', append: true });
    }
  } catch (e) {
    send('error', { status: upstreamStatus || 500, message: String(e.message || e), endpoint: usedBase || '全部端点不可用' });
    return res.end();
  }

  // 免费与付费智谱模型统一计量：免费模型按象征单价累加，并设每次最低 ¥0.05，保证额度可见、可拦截
  let spendInfo = null;
  const FREE_MODEL_PRICE = { in: 1, out: 2 };   // 元/百万 token（免费模型象征性计价）
  const FREE_MODEL_MIN_FEE = 0.05;              // 免费模型每次最低计费（约 20 次/日）
  try {
    const isFreeZhipu = !!zhipuMeta && !!zhipuMeta.free;
    const billMeta = zhipuMeta ? (isFreeZhipu ? { price: FREE_MODEL_PRICE } : zhipuMeta) : null;
    if (billMeta && (lastUsage || isFreeZhipu)) {
      const raw = estimateCost(billMeta, lastUsage);
      const cost = isFreeZhipu ? Math.max(raw, FREE_MODEL_MIN_FEE) : raw;
      if (cost > 0) {
        addSpent(cost);
        const r6 = (n) => Math.round(n * 1e6) / 1e6;
        const r4 = (n) => Math.round(n * 1e4) / 1e4;
        spendInfo = { cost: r6(cost), spent: r4(getSpent()), limit: SPEND_LIMIT_YUAN, remaining: r4(SPEND_LIMIT_YUAN - getSpent()) };
      }
    }
  } catch (e) {
    console.log('[spend] 计费异常（不影响回复）:', e.message);
  }

  // 入库助手消息（GLM-4-Voice 同时保存音频，供下次请求作为上下文回传）
  if (full) {
    const audioJson = voiceAudios.length ? JSON.stringify(voiceAudios) : null;
    db.prepare('INSERT INTO messages (conversation_id, role, content, model, created_at, audio) VALUES (?,?,?,?,?,?)')
      .run(conv.id, 'assistant', full, model || conv.model, now(), audioJson);
  }

  // 生成对话标题：AI 总结用户问题，10字以内。
  // 保持 SSE 连接打开直到标题生成完成或 8 秒超时，确保 title 事件真正送达前端（写进已关闭的流会被丢弃）
  const titleTask = (async () => {
    try {
      const { provider, apiModel, fallbackModel } = resolveModelProvider(chatModel);
      const titleApiModel = provider === 'zhipu' ? ZHIPU_FALLBACK_MODEL : (apiModel || chatModel);
      const r = await fetchUpstream('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: titleApiModel,
          messages: [
            { role: 'system', content: '你是对话标题生成器。根据用户的第一条消息，生成一个10个字以内的中文对话标题，只输出标题本身，不要加引号、标点或解释。' },
            { role: 'user', content: rawText.slice(0, 200) }
          ],
          max_tokens: 100,
          stream: false
        })
      }, { stream: false, provider, fallbackModel });
      if (r.resp.ok) {
        const j = await r.resp.json();
        let t = j.choices?.[0]?.message?.content?.trim() || '';
        t = t.replace(/^["「『《\s]+|["」』》\s。.，,]+$/g, '').slice(0, 10);
        if (t) {
          db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(t, conv.id);
          send('title', { conversation_id: conv.id, title: t });
        }
      }
    } catch (_) {}
  })();

  send('done', { conversation_id: conv.id, content: full, spend: spendInfo });
  await Promise.race([titleTask, new Promise(r => setTimeout(r, 8000))]);
  res.end();
});

// 节点列表（前端节点选择器仅显示 poixe 主节点；智谱作为自动故障转移后端）
app.get('/api/nodes', requireAuth, (req, res) => {
  const poixe = UPSTREAM_ENDPOINTS.filter(e => e.provider === 'poixe');
  res.json({
    active: activeEndpointIdx,
    list: poixe.map((ep, i) => ({
      id: i,
      name: '节点' + (i + 1) + '：' + ep.base.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      url: ep.base
    }))
  });
});

// 联网搜索代理（多引擎）
app.post('/api/search', requireAuth, async (req, res) => {
  const q = String(req.body && req.body.q || '').trim();
  if (!q) return res.status(400).json({ error: 'query 不能为空' });
  try {
    const { results, engine } = await searchWeb(q.slice(0, 80));
    res.json({ results, engine });
  } catch (e) {
    res.status(502).json({ error: '搜索失败：' + e.message });
  }
});

// 进程级兜底：任何请求内未捕获的异常都不能让整个服务退出
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.stack || e); });

app.listen(PORT, () => {
  console.log(`AI Chat 已启动: http://localhost:${PORT}`);
});
