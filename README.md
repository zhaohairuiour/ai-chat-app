# AI Chat App

安卓端 AI 聊天应用：Capacitor WebView 外壳 + 内嵌 Termux/OpenClaw 沙箱；另含 Node.js 后端与纯前端本地核心。

## 目录结构

| 目录 | 说明 |
|---|---|
| `py_project/` | 网站/后端源码：`server.js`（Express 后端）、`public/`（前端页面与本地核心） |
| `backend-deploy/` | 后端部署副本（`server.js`、`public/`、`DEPLOY.md`） |
| `apk-build/` | Capacitor Android 工程：`android/app/src/main/java`（原生插件）、`assets/`（前端资源与 Termux 模板/公钥）、`tools/`（运行时打包脚本） |
| `ai-chat-backend-v3.32.80-server.js` | 历史后端快照（归档参考） |

## 密钥与配置

仓库内**不含任何明文第三方密钥**。后端 Provider Key 通过环境变量注入，未配置时对应供应商不可用：

| 环境变量 | 供应商 |
|---|---|
| `ZHIPU_KEY` | 智谱开放平台 |
| `POIXE_KEY` | Poixe（OpenAI 兼容） |
| `OPENROUTER_KEY` | OpenRouter |
| `AGNES_KEY` | Agnes AI |
| `AICHAT_AGENT_KEY` | Agent 内部共享令牌 |

前端本地核心（`local-core.js`）中的 Key 常量为空占位，部署时在对应位置填入；后端内网地址已移除，默认走同源。

## 构建

```bash
# 1. 前端资源同步到 Capacitor 工程
cp py_project/public/* apk-build/www/
npx cap sync android

# 2. 编译 Debug APK
cd apk-build/android
./gradlew assembleDebug -x lint
```

产物位于 `apk-build/android/app/build/outputs/apk/debug/`（构建目录不纳入版本库）。

## 发布

APK 按版本号作为对应 GitHub Release 的附件分发；源码在 `main` 分支。全部附件均已移除内置第三方密钥。

| 版本区间 | 附件命名 | 大小 | 去 Key 方式 |
|---|---|---|---|
| `v3.32.59` – `v3.32.73` | `ai-chat-app-v<版本>-nokeys.apk` | ≈33 MB | 就地替换 JS 内密钥与后端地址 |
| `v3.32.80` – `v3.32.98` | 同上 | ≈265 MB | 同上；`v3.32.96` 起另含 DEX 内智谱常量等长替换 |
| `v3.32.99` | 同上 | ≈265 MB | 由本仓库去 Key 源码重新编译（2026-11-20 重编版） |
| `v3.32.102` | 同上 | ≈265 MB | 由本仓库去 Key 源码重新编译（2026-11-22，修复自动执行/重试/串流切会话等 13 项缺陷） |
| `v3.32.100` | 同上 | ≈265 MB | 由本仓库去 Key 源码重新编译（2026-11-21，含终端进度条残留与侧边栏模型面板修复） |

已移除内容：Poixe / OpenRouter / Agnes / 智谱密钥、内网后端地址、Agent 内部令牌。归档包内密钥为空，**无法直接调用在线模型**；重签使用与原发布一致的 Debug 证书，可与同证书版本覆盖安装。

`v3.32.99` 重编版另将本地数据加密密钥（原硬编码 `APP_SECRET_HEX`）改为每台设备首次运行随机生成并持久化；旧内置密钥仅用于兼容解密升级前数据，读取成功后自动以设备密钥重新加密迁移，不会触发篡改禁用。`v3.32.59`–`v3.32.98` 因历史源码未保留，无法整包重编，已通过在原包内替换 `local-core.js`（应用与 v3.32.99 源码同构的加密模块补丁）并重签名的方式实现同等去密钥效果，签名证书与历史发布一致，可覆盖安装。

本地未保留 `v3.32.74`–`v3.32.79` 及 `v3.32.59` 之前的安装包，因此未发布。


## 安全说明

历史安装包曾在客户端内置过供应商密钥。公开分发前请在各供应商平台轮换/作废旧密钥，并通过上述环境变量或本地配置注入新密钥；本仓库不承担任何已泄露凭据的失效责任。
