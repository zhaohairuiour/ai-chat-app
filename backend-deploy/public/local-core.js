/* ============================================================
 * local-core.js — 纯前端本地核心
 * 直连智谱 API（无需后端）+ 三重加密备份 + 签名校验 + 禁用惩罚
 * 数据全部保存在使用用户的设备内
 * ============================================================ */

// ============ 供应商与密钥配置 ============
const ZHIPU_KEY = '';
const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4';
// Poixe 供应商（OpenAI 兼容），直连多端点，全挂时回退智谱
const POIXE_KEY = '';
const POIXE_ENDPOINTS = [
  'https://api.poixe.com/v1',
  'https://api-eu-central-1-dc8.poixe.com/v1',
  'https://api-eu-central-1-dc15.poixe.com/v1',
];
const ZHIPU_FALLBACK_MODEL = 'glm-4-flash-250414';   // poixe 全失败时的兜底（免费）
// OpenRouter（OpenAI 兼容）
const OPENROUTER_KEY = '';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
// Agnes AI（OpenAI 兼容，免费 flash 模型）
const AGNES_KEY = '';
const AGNES_BASE = 'https://api.agnes.ai/v1';
// 后端上报地址（封禁/状态事件；为空则跳过上报，APK 离线可用）
const BACKEND_BASE = '';
// API 代理地址（避免 WebView CORS，所有模型请求走后端转发）
const PROXY_BASE = BACKEND_BASE + '/api/proxy/chat';
// 应用内置密钥材料（AES-GCM 加密 + HMAC 签名 + 特殊编码 XOR 密钥流）
const APP_SECRET_HEX = '9d863a2d9f3c098076bf0d7ebba20c0eebc259dd1849a938e1fb226af466b2190b3f95b48842ca84fccb2837a9cd4c7b1597e00b0009a19629f556e0b554d619';
const XOR_SEED = [0x5a, 0x3c, 0x91, 0xe7, 0x28, 0xb4, 0x6d, 0xf0, 0x13, 0x7a, 0xc5, 0x82, 0x49, 0xde, 0x36, 0xab];

// ============ 工具：hex / bytes ============
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
function bufToBytes(buf) { return new Uint8Array(buf); }

// ============ 特殊编码（自定义 base64 字符表 + XOR + 分组反转） ============
// 用固定 seed 对标准 base64 字符表做确定性 Fisher-Yates 置换，保证 64 个唯一字符
const STD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function shuffledTable() {
  const arr = STD_B64.split('');
  let seed = 0x2545F491;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}
const CUSTOM_B64 = shuffledTable();
const B64_MAP = (() => { const m = {}; [...CUSTOM_B64].forEach((ch, i) => m[ch] = i); return m; })();

function xorBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ XOR_SEED[i % XOR_SEED.length];
  return out;
}
// 自定义 base64 编码（逐 3 字节 → 4 字符，使用乱序表）
function customB64Encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : null, b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
    const n = (b0 << 16) | ((b1 || 0) << 8) | (b2 || 0);
    s += CUSTOM_B64[(n >> 18) & 63] + CUSTOM_B64[(n >> 12) & 63]
      + (b1 === null ? '=' : CUSTOM_B64[(n >> 6) & 63])
      + (b2 === null ? '=' : CUSTOM_B64[n & 63]);
  }
  return s;
}
function customB64Decode(str) {
  const clean = str.replace(/[^A-Za-z0-9+/=]/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_MAP[clean[i]], c1 = B64_MAP[clean[i + 1]],
      c2 = clean[i + 2] === '=' ? null : B64_MAP[clean[i + 2]],
      c3 = clean[i + 3] === '=' ? null : B64_MAP[clean[i + 3]];
    const n = (c0 << 18) | (c1 << 12) | ((c2 || 0) << 6) | (c3 || 0);
    out.push((n >> 16) & 255);
    if (c2 !== null) out.push((n >> 8) & 255);
    if (c3 !== null) out.push(n & 255);
  }
  return new Uint8Array(out);
}
// 分组反转：每 8 字符一组内部反转
function groupReverse(str, block = 8) {
  let s = '';
  for (let i = 0; i < str.length; i += block) s += str.substr(i, block).split('').reverse().join('');
  return s;
}
// 对外：特殊编码 / 解码
function specialEncode(bytes) {
  return groupReverse(customB64Encode(xorBytes(bytes)));
}
function specialDecode(str) {
  return xorBytes(customB64Decode(groupReverse(str)));
}

// ============ Web Crypto 密钥（AES-GCM + HMAC） ============
let _aesKey = null, _hmacKey = null;
async function cryptoKeys() {
  if (_aesKey && _hmacKey) return { aes: _aesKey, hmac: _hmacKey };
  const km = hexToBytes(APP_SECRET_HEX);
  _aesKey = await crypto.subtle.importKey('raw', km.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  _hmacKey = await crypto.subtle.importKey('raw', km.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return { aes: _aesKey, hmac: _hmacKey };
}

// ============ 信封：加密 + 签名 ============
// 明文对象 → 信封字符串（IV 与密文均特殊编码，HMAC 对 IV+密文原始字节签名）
async function sealEnvelope(obj) {
  const { aes, hmac } = await cryptoKeys();
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = bufToBytes(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plain));
  const sigInput = new Uint8Array(iv.length + ct.length);
  sigInput.set(iv, 0); sigInput.set(ct, iv.length);
  const sig = bufToBytes(await crypto.subtle.sign('HMAC', hmac, sigInput));
  return JSON.stringify({
    enc: 'A256GCM-HMAC',
    v: 1,
    ts: Date.now(),
    iv: specialEncode(iv),
    data: specialEncode(ct),
    sig: specialEncode(sig),
  });
}
// 信封字符串 → 验签 + 解密；任一失败抛异常
async function openEnvelope(envStr) {
  const env = JSON.parse(envStr);
  if (!env || env.enc !== 'A256GCM-HMAC' || !env.iv || !env.data || !env.sig) throw new Error('bad envelope');
  const { aes, hmac } = await cryptoKeys();
  const iv = specialDecode(env.iv);
  const ct = specialDecode(env.data);
  const sig = specialDecode(env.sig);
  const sigInput = new Uint8Array(iv.length + ct.length);
  sigInput.set(iv, 0); sigInput.set(ct, iv.length);
  const ok = await crypto.subtle.verify('HMAC', hmac, sig, sigInput);
  if (!ok) throw new Error('signature mismatch');
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, ct);
  } catch (_) { throw new Error('decrypt failed'); }
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ============================================================
 * 三重备份：① APK 独立沙箱(data) ② localStorage ③ IndexedDB
 * ============================================================ */
const VAULT_PATH = 'aichat/vault.dat';
const LS_KEY = 'ai-chat-vault-ls';
const LS_SANDBOX_FALLBACK = 'ai-chat-vault-sandbox'; // 非 Capacitor 浏览器环境模拟沙箱
const IDB_NAME = 'ai-chat-vault', IDB_STORE = 'vault', IDB_REC = 'main';

function capFilesystem() {
  const Cap = window.Capacitor;
  if (Cap && Cap.Plugins && Cap.Plugins.Filesystem) return Cap.Plugins.Filesystem;
  return null;
}

// ---- 通用文件读写（沙箱优先，浏览器环境用 localStorage 模拟） ----
async function readAppFile(path, lsFallbackKey) {
  const FS = capFilesystem();
  if (FS) {
    try {
      const r = await FS.readFile({ path, directory: FS.Directory.Data, encoding: FS.Encoding.UTF8 });
      if (r && r.data) return r.data;
    } catch (_) { /* 文件不存在 → 走 Storage 副本 */ }
    // 沙箱文件读不到时，回退到写入时同步的 Storage 副本（用户要求 data 与 Storage 都存）
    try { return localStorage.getItem(lsFallbackKey + '-ls') || localStorage.getItem(lsFallbackKey); } catch (_) { return null; }
  }
  try { return localStorage.getItem(lsFallbackKey); } catch (_) { return null; }
}
async function writeAppFile(path, str, lsFallbackKey) {
  const FS = capFilesystem();
  try {
    if (FS) {
      await FS.writeFile({ path, data: str, directory: FS.Directory.Data, encoding: FS.Encoding.UTF8, recursive: true });
      // 双写 Storage 一份（用户要求：data 与 Storage 都放）
      try { localStorage.setItem(lsFallbackKey + '-ls', str); } catch (_) {}
    } else {
      localStorage.setItem(lsFallbackKey, str);
    }
    return true;
  } catch (e) { return false; }
}

// ---- 备份①：APK 独立沙箱（Directory.Data，应用私有目录） ----
async function readSandbox() { return readAppFile(VAULT_PATH, LS_SANDBOX_FALLBACK); }
async function writeSandbox(str) { return writeAppFile(VAULT_PATH, str, LS_SANDBOX_FALLBACK); }

/* ---- 第4个文件：初始化标记（data/init.dat + Storage 各一份） ----
 * 作用：区分「全新安装」与「数据被篡改/删除」。
 * 首次启动时创建；只有已存在数据文件却校验失败时才触发禁用。 */
const INIT_MARKER_PATH = 'aichat/init.dat';
const LS_INIT_KEY = 'ai-chat-init-marker';
const LS_INIT_SANDBOX = 'ai-chat-init-sandbox';

async function writeInitMarker() {
  let env;
  try {
    env = await sealEnvelope({ kind: 'aichat-init', ver: 3, app: 'com.aichat.app', ts: Date.now() });
  } catch (_) { env = JSON.stringify({ kind: 'aichat-init', ver: 3, ts: Date.now() }); }
  const a = await writeAppFile(INIT_MARKER_PATH, env, LS_INIT_SANDBOX);   // data + storage(-ls)
  try { localStorage.setItem(LS_INIT_KEY, env); } catch (_) {}             // storage 第二份
  return { sandbox: a, ls: true };
}
// 标记是否存在（宽松：只要文件里有内容就算，避免标记损坏导致误判为新装）
async function hasInitMarker() {
  try {
    const raw = await readAppFile(INIT_MARKER_PATH, LS_INIT_SANDBOX);
    if (raw && raw.length) return true;
  } catch (_) {}
  try {
    const raw = localStorage.getItem(LS_INIT_KEY);
    if (raw && raw.length) return true;
    const raw2 = localStorage.getItem(LS_INIT_SANDBOX + '-ls');
    if (raw2 && raw2.length) return true;
  } catch (_) {}
  return false;
}

// ---- 备份②：localStorage ----
function readLS() { try { return localStorage.getItem(LS_KEY); } catch (_) { return null; } }
function writeLS(str) { try { localStorage.setItem(LS_KEY, str); return true; } catch (_) { return false; } }

// ---- 备份③：IndexedDB（独立 vault 库） ----
let _vaultIDB = null;
function idbVaultOpen() {
  if (_vaultIDB) return Promise.resolve(_vaultIDB);
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(IDB_NAME, 1);
    rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE); };
    rq.onsuccess = () => { _vaultIDB = rq.result; resolve(_vaultIDB); };
    rq.onerror = () => reject(rq.error);
  });
}
async function readIDB() {
  try {
    const db = await idbVaultOpen();
    return await new Promise((resolve, reject) => {
      const g = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_REC);
      g.onsuccess = () => resolve(g.result || null);
      g.onerror = () => reject(g.error);
    });
  } catch (_) { return null; }
}
async function writeIDB(str) {
  try {
    const db = await idbVaultOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(str, IDB_REC);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (_) { return false; }
}

// 写入全部三个备份（任一失败不影响其他）
async function writeAllBackups(envStr) {
  const results = await Promise.allSettled([writeSandbox(envStr), writeLS(envStr), writeIDB(envStr)]);
  return {
    sandbox: results[0].status === 'fulfilled' ? results[0].value : false,
    ls: results[1].status === 'fulfilled' ? results[1].value : false,
    idb: results[2].status === 'fulfilled' ? results[2].value : false,
  };
}

/* ============================================================
 * 本地状态：对话 + 额度 + 禁用（全部存使用用户设备）
 * ============================================================ */
function todayStr() { return new Date().toISOString().slice(0, 10); }
function defaultState() {
  return {
    version: 1,
    conversations: [],          // [{id,title,model,createdAt,messages:[{role,content,audio?}]}]
    quota: { date: todayStr(), multiplier: 1.0 },  // multiplier 惩罚时 0.5
    ban: null,                  // {startTs,banUntilTs,quotaRestoreTs,reason}
  };
}
let localState = defaultState();

async function persistState() {
  const env = await sealEnvelope(localState);
  return writeAllBackups(env);
}
function findConversation(id) { return localState.conversations.find(c => c.id === id); }
function nextConvId() { return localState.conversations.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0) + 1; }

// 确保对话存在（复用 id，否则新建），返回对话记录
function ensureConversation(id, model, title) {
  if (id) { const c = findConversation(id); if (c) return c; }
  const c = { id: nextConvId(), title: title || '新对话', model: model || '', createdAt: Date.now(), messages: [] };
  localState.conversations.push(c);
  return c;
}
function appendConvMessage(convId, msg) {
  const c = findConversation(convId);
  if (c) c.messages.push(msg);
  return c;
}
function setConvTitle(convId, title) {
  const c = findConversation(convId);
  if (c) c.title = title;
}
function deleteConversation(id) {
  localState.conversations = localState.conversations.filter(c => c.id !== id);
}
// 构造发送给智谱的历史消息（从本地对话记录，限制条数/字符）
function buildLocalHistory(convId, maxMsgs = 40, maxChars = 50000) {
  const c = findConversation(convId);
  if (!c) return [];
  const rows = c.messages.slice(-maxMsgs);
  const out = [];
  let chars = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    chars += content.length;
    if (chars > maxChars) break;
    out.unshift({ role: m.role, content: m.content });
  }
  return out;
}

// 禁用状态派生
function banActive() {
  const b = localState.ban;
  return !!(b && Date.now() < b.banUntilTs);
}
function banRemainingDays() {
  const b = localState.ban;
  if (!b) return 0;
  const ms = b.banUntilTs - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
}
function quotaCutActive() {
  const b = localState.ban;
  return !!(b && Date.now() < b.quotaRestoreTs);
}
function quotaRemainingDays() {
  const b = localState.ban;
  if (!b) return 0;
  const ms = b.quotaRestoreTs - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
}

/* ============================================================
 * 直连智谱 API（无需后端）
 * ============================================================ */
const ZHIPU_HEADERS = { 'Authorization': 'Bearer ' + ZHIPU_KEY, 'Content-Type': 'application/json' };

// 网络层 fetch 重试：仅对 TypeError（Failed to fetch，连接/解析失败）重试一次
async function fetchWithRetry(url, opts = {}, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

async function zhipuPost(path, body, signal) {
  const res = await fetchWithRetry(ZHIPU_BASE + path, {
    method: 'POST', headers: ZHIPU_HEADERS, body: JSON.stringify(body), signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const code = j.error?.code, msg = j.error?.message;
    let friendly = msg || ('请求失败 ' + res.status);
    if (/1113|余额不足|无可用资源|请充值/.test(String(code) + String(msg))) friendly = '该模型需付费，当前账户余额/资源包不足，请充值或换一个免费模型';
    else if (/1305|429|限流|访问量过大/.test(String(code) + String(msg))) friendly = '该模型当前免费额度限流，请稍后再试或换一个模型';
    const err = new Error(friendly); err.code = code; throw err;
  }
  return res;
}

// 聊天 SSE：回调 onDelta/onThink/onVoice/onUsage，返回完整正文
async function zhipuChatStream({ model, messages, max_tokens, thinking, onDelta, onThink, onVoice, onUsage, signal }) {
  const reqBody = { model, messages, stream: true, max_tokens: max_tokens || 8192 };
  if (thinking) reqBody.thinking = { type: 'enabled' };
  // 走后端代理避免 CORS
  const res = await fetchWithRetry(PROXY_BASE, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'zhipu', body: reqBody }), signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const code = j.error?.code, msg = j.error?.message;
    let friendly = msg || ('请求失败 ' + res.status);
    if (/1113|余额不足|无可用资源|请充值/.test(String(code) + String(msg))) friendly = '该模型需付费，当前账户余额/资源包不足，请充值或换一个免费模型';
    else if (/1305|429|限流|访问量过大/.test(String(code) + String(msg))) friendly = '该模型当前免费额度限流，请稍后再试或换一个模型';
    throw new Error(friendly);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json.usage && onUsage) onUsage(json.usage);
        const d = json.choices?.[0]?.delta || {};
        const thinkText = d.reasoning_content || d.reasoning;
        if (thinkText && onThink) onThink(thinkText);
        if (d.content) { full += d.content; if (onDelta) onDelta(d.content); }
        if (d.audio && d.audio.data && onVoice) onVoice(d.audio);
      } catch (_) {}
    }
  }
  return full;
}

// 图片生成
async function zhipuImage(model, prompt, size) {
  const res = await zhipuPost('/images/generations', { model, prompt, size: size || '1024x1024' });
  const j = await res.json();
  return j.data?.[0]?.url;
}
// 语音合成（返回 arrayBuffer，前端转 blob 播放/下载）
async function zhipuTTS(model, input, voice) {
  const res = await zhipuPost('/audio/speech', { model, input, voice: voice || 'tongtong' });
  return await res.arrayBuffer();
}
// 视频生成（异步任务：提交后返回任务 id，需轮询）
async function zhipuVideoCreate(model, prompt) {
  const res = await zhipuPost('/videos/generations', { model, prompt });
  return await res.json();
}
async function zhipuVideoResult(id) {
  const res = await fetch(ZHIPU_BASE + '/async-result/' + id, { headers: ZHIPU_HEADERS });
  return await res.json();
}
// 非流式一次性调用（项目编排用）
async function zhipuOnce(messages, model, max_tokens) {
  const res = await zhipuPost('/chat/completions', { model, messages, stream: false, max_tokens: max_tokens || 8000 });
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

/* ============================================================
 * Poixe 供应商（OpenAI 兼容）+ 统一入口（失败自动回退智谱）
 * ============================================================ */
function resolveLocalModel(modelId) {
  const id = String(modelId || '');
  if (id.startsWith('zhipu:')) return { provider: 'zhipu', apiModel: id.slice(6) };
  if (id.startsWith('poixe:')) return { provider: 'poixe', apiModel: id.slice(6) };
  if (id.startsWith('or:') || id.startsWith('openrouter:')) return { provider: 'openrouter', apiModel: id.replace(/^(or|openrouter):/, '') };
  if (id.startsWith('agnes:')) return { provider: 'agnes', apiModel: id.slice(6) };
  return { provider: 'poixe', apiModel: id };
}

// 通用 OpenAI 兼容流式请求；返回完整正文
async function openaiCompatStream({ base, key, model, messages, max_tokens, thinking, onDelta, onThink, signal }) {
  const body = { model, messages, stream: true, max_tokens: max_tokens || 8192 };
  if (thinking) {
    if (base.indexOf('openrouter') >= 0) {
      body.reasoning = { effort: 'high' };
      body.include_reasoning = true;
    } else {
      body.thinking = { type: 'enabled' };
    }
  } else if (base.indexOf('openrouter') >= 0) {
    body.reasoning = { effort: 'none', enabled: false };
    body.include_reasoning = false;
  }
  // 判断 provider 走后端代理
  let provider = 'openrouter';
  if (base.indexOf('agnes') >= 0) provider = 'agnes';
  else if (base.indexOf('openrouter') >= 0) provider = 'openrouter';
  const res = await fetchWithRetry(PROXY_BASE, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, body }), signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const code = j.error?.code, msg = j.error?.message || j.message || ('请求失败 ' + res.status);
    let friendly = String(msg);
    if (/insufficient|余额|balance|recharge|1113|无可用资源|请充值/i.test(String(code) + ' ' + friendly))
      friendly = '模型账户余额不足，请充值或切换到免费模型';
    else if (/429|限流|rate.?limit|访问量过大/i.test(String(code) + ' ' + friendly))
      friendly = '模型当前访问量过大，请稍后再试或切换模型';
    throw new Error(friendly);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const d = json.choices?.[0]?.delta || {};
        const thinkText = d.reasoning_content || d.reasoning;
        if (thinkText && onThink) onThink(thinkText);
        if (d.content) { full += d.content; if (onDelta) onDelta(d.content); }
      } catch (_) {}
    }
  }
  return full;
}

// 统一聊天入口：多级 fallback，任何 provider 限流/失败都自动切换
async function localChatStream({ modelId, messages, max_tokens, thinking, onDelta, onThink, onVoice, signal }) {
  const { provider, apiModel } = resolveLocalModel(modelId);
  const fallbackChain = [];

  // 第一选择
  if (provider === 'zhipu') {
    fallbackChain.push({ type: 'zhipu', model: apiModel });
    // 智谱挂了 → OpenRouter 免费模型 → 智谱 flash 兜底
    fallbackChain.push({ type: 'openrouter', model: 'google/gemma-4-31b-it:free' });
    fallbackChain.push({ type: 'zhipu', model: ZHIPU_FALLBACK_MODEL });
  } else if (provider === 'openrouter') {
    fallbackChain.push({ type: 'openrouter', model: apiModel });
    // OpenRouter 挂了 → Agnes 免费 → 智谱免费
    fallbackChain.push({ type: 'agnes', model: 'agnes-3.0-flash' });
    fallbackChain.push({ type: 'zhipu', model: ZHIPU_FALLBACK_MODEL });
  } else if (provider === 'agnes') {
    fallbackChain.push({ type: 'agnes', model: apiModel });
    fallbackChain.push({ type: 'agnes', model: 'agnes-2.5-flash' });
    fallbackChain.push({ type: 'zhipu', model: ZHIPU_FALLBACK_MODEL });
  } else {
    // poixe 多端点
    for (const base of POIXE_ENDPOINTS) {
      fallbackChain.push({ type: 'poixe', base, model: apiModel });
    }
    fallbackChain.push({ type: 'openrouter', model: 'google/gemma-4-31b-it:free' });
    fallbackChain.push({ type: 'zhipu', model: ZHIPU_FALLBACK_MODEL });
  }

  let lastErr = null;
  for (const f of fallbackChain) {
    try {
      if (f.type === 'zhipu') {
        return await zhipuChatStream({ model: f.model, messages, max_tokens, thinking, onDelta, onThink, onVoice, signal });
      }
      if (f.type === 'openrouter') {
        return await openaiCompatStream({ base: OPENROUTER_BASE, key: OPENROUTER_KEY, model: f.model, messages, max_tokens, thinking, onDelta, onThink, signal });
      }
      if (f.type === 'agnes') {
        return await openaiCompatStream({ base: AGNES_BASE, key: AGNES_KEY, model: f.model, messages, max_tokens, thinking, onDelta, onThink, signal });
      }
      return await openaiCompatStream({ base: f.base, key: POIXE_KEY, model: f.model, messages, max_tokens, thinking, onDelta, onThink, signal });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('所有模型均不可用：' + (lastErr ? lastErr.message : '未知错误'));
}

// 统一非流式入口（项目编排用）
async function localOnce({ modelId, messages, max_tokens }) {
  const { provider, apiModel } = resolveLocalModel(modelId);
  if (provider === 'zhipu') return zhipuOnce(messages, apiModel, max_tokens);
  if (provider === 'openrouter') {
    const res = await fetchWithRetry(OPENROUTER_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: apiModel, messages, stream: false, max_tokens: max_tokens || 8000 }),
    });
    if (!res.ok) throw new Error('openrouter ' + res.status);
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  }
  for (const base of POIXE_ENDPOINTS) {
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + POIXE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: apiModel, messages, stream: false, max_tokens: max_tokens || 8000 }),
      });
      if (!res.ok) throw new Error('poixe ' + res.status);
      const j = await res.json();
      const c = j.choices?.[0]?.message?.content;
      if (c) return c;
      throw new Error('empty content');
    } catch (_) {}
  }
  return zhipuOnce(messages, ZHIPU_FALLBACK_MODEL, max_tokens);
}

// 项目编排专用：失败自动重试 2 次
async function localOnceRetry(args, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await localOnce(args);
      if (r && r.trim().length > 20) return r;
      lastErr = new Error('返回内容过短');
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  throw lastErr;
}

/* ============================================================
 * 启动校验：先 data 沙箱，再 Storage（LS、IDB），签名校验
 * 任一有效 → 全部生效并同步所有备份；全无效 → 禁用惩罚
 * ============================================================ */
const BAN_DAYS = 30;
const QUOTA_RESTORE_DAYS = 60;
const QUOTA_CUT_MULTIPLIER = 0.5;

// 处理禁用/额度的到期自动恢复
function reconcileBan() {
  const b = localState.ban;
  if (!b) return;
  const now = Date.now();
  if (now >= b.quotaRestoreTs) {
    // 60 天到：额度完全恢复，清除禁用记录
    localState.ban = null;
    localState.quota.multiplier = 1.0;
  }
  // 30～60 天之间：禁用已解除（对话可用），额度仍为 50%
}

// 旧版 v3.25 的误判迁移：首次安装无数据也被判定篡改 → 自动解除这次误禁用
function migrateLegacyFalseBan() {
  const b = localState.ban;
  if (!b) return false;
  // 新版禁用一定带 'existing-data-invalid'；其余（旧文案或缺失）都属 v3.25 及更早的误判写法
  const legacyReason = String(b.reason || '') !== 'existing-data-invalid';
  const emptyConv = !localState.conversations || localState.conversations.length === 0;
  if (legacyReason && emptyConv) {
    localState.ban = null;
    if (!localState.quota) localState.quota = { date: todayStr(), multiplier: 1.0 };
    localState.quota.multiplier = 1.0;
    localState.migrated326 = true;
    return true;
  }
  return false;
}

// v3.27：静默加载本地数据（不验签、不 ban、不禁用；读不到就用默认空状态）
async function silentLoad() {
  for (const read of [readSandbox, readLS, readIDB]) {
    try {
      const raw = await read();
      if (!raw) continue;
      const obj = await openEnvelope(raw).catch(() => null);
      if (obj && obj.version === 1 && Array.isArray(obj.conversations)) {
        localState = obj;
        return;
      }
    } catch (_) {}
  }
  localState = defaultState();
}

async function verifyAndRestore() {
  // 校验顺序：① data 沙箱 → ② localStorage → ③ IndexedDB
  const sources = [
    { name: 'sandbox', read: readSandbox },
    { name: 'ls', read: readLS },
    { name: 'idb', read: readIDB },
  ];
  let restored = null, from = null;
  const present = [];   // 实际存在（非空）的数据文件
  for (const s of sources) {
    let raw = null;
    try { raw = await s.read(); } catch (_) { raw = null; }
    if (!raw) continue;
    present.push(s.name);
    try {
      const obj = await openEnvelope(raw);
      if (obj && obj.version === 1 && Array.isArray(obj.conversations)) {
        restored = obj; from = s.name; break;   // 第一份有效即采用
      }
    } catch (_) { }                             // 签名/解密失败 → 视为无效，继续下一份
  }

  if (restored) {
    localState = restored;
    const migrated = migrateLegacyFalseBan();    // 自动解除旧版误判禁用
    reconcileBan();
    await persistState();                       // 同步到所有备份（三份重新密封一致）
    await writeInitMarker();                     // 确保第4个标记文件存在
    return { ok: true, source: from, migrated };
  }

  // 关键修复：先检查「是否已经存在数据文件」
  // 一份都没有 = 全新安装（或用户主动清空）→ 初始化，不判定为篡改、不禁用
  if (present.length === 0) {
    localState = defaultState();
    await writeInitMarker();                    // 首次打开即创建第4个文件（data + Storage）
    await persistState();                       // 写入三份备份
    return { ok: true, fresh: true };
  }

  // 已存在数据文件、但全部没通过签名校验 → 判定篡改，执行禁用惩罚
  // 注意：reason 用新标识，避免与旧版误判特征混淆
  await applyBan('existing-data-invalid');
  return { ok: false, reason: 'existing-data-invalid', files: present };
}

// 全部备份无效 → 禁用 30 天 + 额度扣 50%（60 天恢复），三备份
async function applyBan(reason) {
  const now = Date.now();
  localState = defaultState();                  // 原对话与额度内容全部不生效
  localState.ban = {
    startTs: now,
    banUntilTs: now + BAN_DAYS * 86400000,
    quotaRestoreTs: now + QUOTA_RESTORE_DAYS * 86400000,
    reason: reason || '本地备份签名校验全部失败',
  };
  localState.quota.multiplier = QUOTA_CUT_MULTIPLIER;
  await persistState();
  return localState.ban;
}

// 手动破坏/重置（调试用）：清除三份备份
async function wipeAllBackups() {
  try {
    const FS = capFilesystem();
    if (FS) { try { await FS.deleteFile({ path: VAULT_PATH, directory: FS.Directory.Data }); } catch (_) {} }
    else localStorage.removeItem(LS_SANDBOX_FALLBACK);
    localStorage.removeItem(LS_KEY);
    const db = await idbVaultOpen();
    await new Promise((res) => { const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).clear(); tx.oncomplete = res; });
  } catch (_) {}
}

/* ============================================================
 * 开发者工具（控制台可调用）
 *   localDevUnlock('AICHAT-DEV-2026')  → 解除禁用并恢复额度
 *   getRawState()                      → 读取当前明文状态
 * ============================================================ */
const DEV_UNLOCK_CODE = 'AICHAT-DEV-2026';
async function devUnlock(code) {
  if (String(code || '') !== DEV_UNLOCK_CODE) return { ok: false, msg: '口令错误' };
  localState.ban = null;
  if (!localState.quota) localState.quota = { date: todayStr(), multiplier: 1.0 };
  localState.quota.multiplier = 1.0;          // 额度恢复全额
  await persistState();
  return { ok: true, msg: '已解除禁用，额度已恢复，请刷新页面' };
}
async function getRawState() { return JSON.parse(JSON.stringify(localState)); }
try {
  window.localDevUnlock = devUnlock;
  window.localCoreGetState = getRawState;
  window.localCore = { getRawState, devUnlock, verifyAndRestore, persistState, wipeAllBackups, banActive, banRemainingDays };
} catch (_) {}

// 后端上报（封禁/状态/异常事件；BACKEND_BASE 为空则静默跳过）
async function reportEvent(type, payload) {
  if (!BACKEND_BASE) return;
  try {
    await fetch(BACKEND_BASE.replace(/\/$/, '') + '/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload: payload || {}, ts: Date.now(), app: 'com.aichat.app', v: '3.27' }),
    });
  } catch (_) {}
}
try { window.reportEvent = reportEvent; } catch (_) {}

/* ============================================================
 * 内置模型清单（与网站 /api/models 下发的智谱部分一致）
 * ============================================================ */
const LOCAL_MODELS = [
  { id: 'zhipu:glm-4-flash-250414', name: 'GLM-4-Flash', caps: [], kind: 'chat', enabled: true },
  { id: 'zhipu:glm-4.5-flash', name: 'GLM-4.5-Flash', caps: [], kind: 'chat', enabled: true },
  { id: 'zhipu:glm-4.7-flash', name: 'GLM-4.7-Flash', caps: [], kind: 'chat', enabled: true },
  { id: 'zhipu:glm-z1-flash', name: 'GLM-Z1-Flash', caps: ['think'], kind: 'chat', enabled: true },
  { id: 'zhipu:glm-4v-flash', name: 'GLM-4V-Flash', caps: ['image'], kind: 'chat', enabled: true },
  { id: 'zhipu:glm-4.1v-thinking-flash', name: 'GLM-4.1V-Thinking-Flash', caps: ['image', 'think'], kind: 'chat', enabled: true },
  { id: 'zhipu:glm-4.6v-flash', name: 'GLM-4.6V-Flash', caps: ['image'], kind: 'chat', enabled: true },
  { id: 'zhipu:charglm-4', name: 'CharGLM-4', caps: [], kind: 'chat', enabled: true },
  { id: 'zhipu:emohaa', name: 'Emohaa', caps: [], kind: 'chat', enabled: true },
  { id: 'zhipu:glm-ocr', name: 'GLM-OCR', caps: ['image'], kind: 'chat', enabled: true },
  // 免费生成类
  { id: 'zhipu:cogview-3-flash', name: 'CogView-3-Flash', caps: [], kind: 'image_gen', enabled: true },
  { id: 'zhipu:cogvideox-flash', name: 'CogVideoX-Flash', caps: [], kind: 'video_gen', enabled: true },
  // 付费语音：保持置灰（与网站一致）
  { id: 'zhipu:glm-tts', name: 'GLM-TTS', caps: [], kind: 'tts', enabled: false, note: '付费语音合成，需先充值' },
  // ---- Poixe 供应商（OpenAI 兼容，直连；失败自动回退智谱）----
  { id: 'poixe:deepseek-chat', name: 'DeepSeek-Chat', caps: [], kind: 'chat', enabled: true, provider: 'poixe' },
  { id: 'poixe:deepseek-reasoner', name: 'DeepSeek-Reasoner', caps: ['think'], kind: 'chat', enabled: true, provider: 'poixe' },
  { id: 'poixe:gpt-4o-mini', name: 'GPT-4o-mini', caps: [], kind: 'chat', enabled: true, provider: 'poixe' },
  { id: 'poixe:gpt-4.1', name: 'GPT-4.1', caps: [], kind: 'chat', enabled: true, provider: 'poixe' },
  { id: 'poixe:gpt-4.1-mini', name: 'GPT-4.1-mini', caps: [], kind: 'chat', enabled: true, provider: 'poixe' },
  { id: 'poixe:qwen-plus', name: 'Qwen-Plus', caps: [], kind: 'chat', enabled: true, provider: 'poixe' },
  { id: 'poixe:qwen-turbo', name: 'Qwen-Turbo', caps: [], kind: 'chat', enabled: true, provider: 'poixe' },
  { id: 'poixe:qwen-max', name: 'Qwen-Max', caps: [], kind: 'chat', enabled: true, provider: 'poixe' },
  { id: 'poixe:gemini-2.5-flash', name: 'Gemini-2.5-Flash', caps: [], kind: 'chat', enabled: true, provider: 'poixe' },
  { id: 'poixe:grok-3-mini', name: 'Grok-3-mini', caps: [], kind: 'chat', enabled: true, provider: 'poixe' },
  // ---- OpenRouter（直连，OpenAI 兼容；使用 :free 免费模型）----
  { id: 'or:nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron-3-Ultra 550B', caps: ['think'], kind: 'chat', enabled: true, provider: 'openrouter' },
  { id: 'or:nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron-3.5-VL', caps: ['think'], kind: 'chat', enabled: true, provider: 'openrouter' },
  { id: 'or:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron-Nano-Reasoning', caps: ['think'], kind: 'chat', enabled: true, provider: 'openrouter' },
  { id: 'or:google/gemma-4-31b-it:free', name: 'Gemma-4-31B', caps: [], kind: 'chat', enabled: true, provider: 'openrouter' },
  { id: 'or:google/gemma-4-26b-a4b-it:free', name: 'Gemma-4-26B', caps: [], kind: 'chat', enabled: true, provider: 'openrouter' },
  { id: 'or:cohere/north-mini-code:free', name: 'North-Mini-Code', caps: [], kind: 'chat', enabled: true, provider: 'openrouter' },
  { id: 'or:nvidia/nemotron-3.5-lightning:free', name: 'Nemotron-3.5-Lightning', caps: [], kind: 'chat', enabled: true, provider: 'openrouter' },
  { id: 'or:recursive/flint-v1.0:free', name: 'Flint-v1.0', caps: [], kind: 'chat', enabled: true, provider: 'openrouter' },
  // ---- Agnes AI（免费 flash 模型，OpenAI 兼容）----
  { id: 'agnes:agnes-3.0-flash', name: 'Agnes-3.0-Flash', caps: ['think'], kind: 'chat', enabled: true, provider: 'agnes' },
  { id: 'agnes:agnes-2.5-flash', name: 'Agnes-2.5-Flash', caps: [], kind: 'chat', enabled: true, provider: 'agnes' },
];
function localModelList() {
  return { free: LOCAL_MODELS.filter(m => m.enabled), paid: [], paidEnabled: false, total: LOCAL_MODELS.length };
}

/* ============================================================
 * 系统提示 + 项目解析（移植自 server.js）
 * ============================================================ */
const CHAT_SYSTEM_PROMPT = `你是 AI 助手，用中文简洁、有条理地回答用户问题。
- 当用户要求"表格/对照表/对比表/整理成表"时，把信息整理成清晰的 Markdown 表格，尽量覆盖用户关心的维度。
- 回答中使用自然的中文。

【沙箱终端】
你内置了一个 Termux Linux 沙箱（aarch64，支持 apt/pkg 包管理器）。用户要求安装软件、运行命令、创建/删除文件、写代码并执行时，不要教用户怎么操作，直接输出命令，系统会自动执行并把结果返回给你。

两种标记，语义完全不同，不要混用：
1) 执行标记：/--auto-bash--/ 与 /--ending-bash--/，各占一行、前后不能加任何文字，中间写要真正运行的命令。系统会自动执行并把 stdout/stderr 回给你。
/--auto-bash--/
这里写要执行的命令（一行或多行）
/--ending-bash--/
2) 展示标记：<bash> 与 </bash>，只用来给用户看代码，系统不会执行。
<bash>
这里写只展示、不执行的命令
</bash>

不要使用三反引号 bash 代码块，不要用 ~~ 或 -- 自行发明删除线式标记。

【什么时候不要用命令】
查询、百科、资讯、实时数据类问题（最近的世界纪录、新闻、赛事结果、价格、天气、人物近况、产品参数等）直接用联网搜索或你已有的知识回答，禁止为了搜集信息去写 curl、wget、apt、python 抓取之类的命令。命令只用于「用户明确要求在设备上执行的操作」。

沙箱环境信息：
- HOME 目录: ~ （即 /data/data/com.aichat.app/files/home）
- 工作目录: ~/sandbox （即 /data/data/com.aichat.app/files/sandbox）
- 项目目录: ~/sandbox/projects/<对话ID>/
- 包管理器: apt 或 pkg（已配置清华镜像源，两者等价）
- 你可以读取沙箱里的文件列表和内容：先执行 ls、cat、pwd 等命令，系统会把输出返回给你，你再根据实际文件继续操作。

重要规则：
1. 执行任何文件操作（特别是 rm、mv、cp）前，必须先执行 pwd && ls -la 确认当前位置和文件列表，再根据真实路径操作。不要假设目录存在。
2. 删除操作要明确写出完整路径，例如 rm -rf ~/sandbox/projects/xxx，不要用相对路径 rm -rf bin。
3. 安装 Python 用 pkg install -y python 或 apt install -y python；安装后用 python --version 确认。
4. 每次只给一组命令，等系统执行完返回结果后再给下一组。
5. 不要输出三反引号 bash 或 sh 代码块标记。要执行用 /--auto-bash--/ … /--ending-bash--/，只展示用 <bash> … </bash>。
6. 需要用户手动操作电脑（Windows/Mac）的教程才输出文字说明；在手机沙箱里能完成的事，直接写命令执行。`;

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
2. 代码必须完整、可直接运行，禁止省略，禁止出现 "// 其余代码省略" 等占位。
3. 【重要】每次只允许输出当前这一步的文件，禁止提前输出后续步骤的文件，禁止一次性生成整个项目。
4. 若需要读取已经生成的文件内容来保持代码一致，在回复中单独写一行：
   READ_FILE: 相对路径
   可以写多行（每行一个路径），程序会把文件内容在下一步提供给你。
5. 【可选执行，由你自行判断】只有项目确实需要运行验证时才输出无路径标注的 shell 代码块，例如：
   \`\`\`shell
   mkdir -p src && cd src
   \`\`\`
   沙箱可用时命令会真实执行，**执行结果（退出码 / stdout / stderr）会自动回传给你**，你需要在后续步骤中据此修复问题；
   沙箱不可用时这些块会被忽略，所以代码本身必须静态可运行。纯静态项目（单页 HTML/CSS、纯函数库）不要输出 shell 块。
6. 仅当这是最后一步、整个项目已经全部完成时，才在回复末尾单独输出一行：PROJECT_DONE；非最后一步即使本步完成也不要输出该标记。`;

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
// v3.28：解析无路径标注的 shell 代码块（shell/sh/bash），用于沙箱执行
function parseShellBlocks(text) {
  const out = [];
  const re = /```(?:shell|sh|bash)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) { if (m[1].trim()) out.push(m[1].replace(/\n+$/, '')); }
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

// 本地项目编排（直连供应商，通过 emit 注入 plan/step/file/project_done 事件）
// sandbox（可选）：{ term, projectDir, run, write } —— 提供时命令在本地沙箱真实执行
async function localProjectChat({ rawText, modelId, emit, signal, sandbox = null }) {
  // v3.29.2：项目式编程统一用 OpenRouter 代码模型，大 token，重试 2 次
  const CODE_MODEL = 'or:cohere/north-mini-code:free';
  const planText = await localOnceRetry({
    modelId: CODE_MODEL,
    messages: [
      { role: 'system', content: PROJECT_PLAN_PROMPT },
      { role: 'user', content: rawText },
    ],
    max_tokens: 16000,
  });
  let steps = parseSteps(planText);
  if (!steps.length) steps = [{ title: '整体实现', files: [] }];
  emit('plan_start', {});
  emit('plan', { total: steps.length, steps: steps.map(s => s.title) });
  emit('delta', { text: '\n📋 分步计划（' + steps.length + ' 步）已生成，开始逐步实现：\n' });

  const written = [];
  let readCarry = '';
  // 沙箱执行结果（自动回传给 AI 自检修复）
  let exeReport = '';
  let failures = [];
  for (let i = 0; i < steps.length; i++) {
    emit('step_start', { index: i + 1, total: steps.length, title: steps[i].title });
    const existing = written.map(f => f.path).join(', ') || '（暂无）';
    const stepUser = [
      '项目需求：' + rawText,
      '当前进度：第 ' + (i + 1) + '/' + steps.length + ' 步「' + steps[i].title + '」',
      '已完成文件：' + existing,
      readCarry ? '你上次请求读取的文件内容：\n' + readCarry : '',
      exeReport ? '上一步命令执行结果（请据此修复问题）：\n' + exeReport : '',
      steps[i].files.length ? '本步应生成文件：' + steps[i].files.join(', ') : '',
      '请只输出本步文件（代码块标注 语言:路径），如需读取已生成文件请写 READ_FILE: 路径。',
      (i === steps.length - 1) ? '这是最后一步，完成后在末尾输出 PROJECT_DONE' : ''
    ].filter(Boolean).join('\n');
    const out = await localOnceRetry({
      modelId: CODE_MODEL,
      messages: [
        { role: 'system', content: PROJECT_STEP_PROMPT },
        { role: 'user', content: stepUser },
      ],
      max_tokens: 16000,
    });
    const reads = [...out.matchAll(/READ_FILE:\s*([^\n]+)/gi)].map(m => sanitizeRel(m[1])).filter(Boolean);
    if (reads.length) {
      const parts = [];
      for (const r of reads) { const f = written.find(w => w.path === r); if (f) parts.push('=== ' + r + ' ===\n' + f.content); }
      readCarry = parts.join('\n\n');
    } else { readCarry = ''; }

    // shell 块：沙箱存在时真实执行，结果收集后自动回传给下一步
    exeReport = '';
    if (sandbox) {
      const shells = parseShellBlocks(out);
      const lines = [];
      for (const c of shells) {
        let r;
        try { r = await sandbox.run(c, sandbox.projectDir); } catch (e) { r = { code: -1, stderr: e.message }; }
        const code = (r && r.code) != null ? r.code : 0;
        const tail = ((r && (r.stderr || r.stdout)) || '').trim().split('\n').slice(-12).join('\n');
        lines.push('$ ' + c.split('\n')[0] + '\n退出码: ' + code + (tail ? '\n' + tail : ''));
        if (code !== 0) failures.push({ cmd: c, code, out: tail });
      }
      if (lines.length) exeReport = lines.join('\n\n');
    }

    let blocks = parseFileBlocks(out);
    if (steps[i].files && steps[i].files.length) {
      const allowed = new Set(steps[i].files);
      blocks = blocks.filter(b => allowed.has(b.path));
    }
    for (const b of blocks) {
      written.push(b);
      if (sandbox) {
        try {
          await sandbox.write(b.path, b.content, sandbox.projectDir);
        } catch (e) {
          if (sandbox.term) sandbox.term.line('写入失败: ' + e.message, 'term-err');
        }
      }
      emit('file', { path: b.path, index: i + 1, total: steps.length });
    }
    emit('step_done', { index: i + 1 });
    if (/PROJECT_DONE/.test(out) && i === steps.length - 1) break;
  }

  // 自动自检修复：命令失败时把结果回传给 AI，让它重新改代码，最多 2 轮
  if (sandbox && failures.length) {
    for (let round = 0; round < 2 && failures.length; round++) {
      emit('step_start', { index: steps.length, total: steps.length, title: '自检修复 (' + (round + 1) + ')' });
      const failText = failures.map(f => '命令: ' + f.cmd.split('\n')[0] + '\n退出码: ' + f.code + (f.out ? '\n' + f.out : '')).join('\n\n');
      const filesNow = written.map(f => '- ' + f.path).join('\n');
      const fixUser = [
        '项目需求：' + rawText,
        '以下命令在沙箱执行失败，请修复相关代码并重新输出需要改动的文件（完整文件内容，代码块标注 语言:路径）。',
        failText,
        '当前已有文件：\n' + filesNow,
        '只输出需要修改的文件，不要输出未改动的文件。',
      ].join('\n\n');
      let out;
      try {
        out = await localOnceRetry({
          modelId: CODE_MODEL,
          messages: [
            { role: 'system', content: PROJECT_STEP_PROMPT },
            { role: 'user', content: fixUser },
          ],
          max_tokens: 16000,
        });
      } catch (e) { break; }
      const blocks = parseFileBlocks(out);
      if (!blocks.length) break;
      for (const b of blocks) {
        written.push(b);
        try { await sandbox.write(b.path, b.content, sandbox.projectDir); } catch (_) {}
        emit('file', { path: b.path, index: steps.length, total: steps.length });
      }
      // 重跑失败命令
      const remain = [];
      for (const f of failures) {
        let r;
        try { r = await sandbox.run(f.cmd, sandbox.projectDir); } catch (e) { r = { code: -1, stderr: e.message }; }
        const code = (r && r.code) != null ? r.code : 0;
        if (code !== 0) remain.push({ cmd: f.cmd, code, out: ((r && (r.stderr || r.stdout)) || '').trim().split('\n').slice(-12).join('\n') });
      }
      failures = remain;
      emit('step_done', { index: steps.length });
    }
  }
  const finalFiles = Object.values(written.reduce((acc, f) => { acc[f.path] = f; return acc; }, {}));
  emit('project_done', { files: finalFiles, steps: steps.length });
  return finalFiles;
}





