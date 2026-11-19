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

APK 按版本号作为对应 GitHub Release 的附件分发；源码在 `main` 分支。

## 安全说明

历史安装包曾在客户端内置过供应商密钥。公开分发前请在各供应商平台轮换/作废旧密钥，并通过上述环境变量或本地配置注入新密钥；本仓库不承担任何已泄露凭据的失效责任。
