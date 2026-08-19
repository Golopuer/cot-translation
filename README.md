# cot-translate-local

把 DeepSeek Harness（DSH）主模型的**英文思考过程（思维链）**，用本地小模型
（Qwen3.5-0.8B）实时概括成简洁中文，显示在对话右侧的独立面板里。

- 🔌 **纯本地**：翻译完全在本机完成，不调任何云端 API
- 👀 **纯监听**：旁路监听 session 事件，不碰主模型的思维流本身
- ⚡ **大块分段**：约 200 词英文切一段，避免翻译队列积压
- 🎨 **会话隔离 + 步骤标注**：只显示当前对话，用颜色区分步骤、标注轮次
- 🔘 **一键开关**：面板顶部开关，随时开/关

## 致谢 / Credits

- **作者 / Author**：Anmorris Golopure —— 需求定义、架构与验收
- **AI 协作开发 / AI Co-developer**：DeepSeek-V4-Pro & deepseek-v4-flash（DeepSeek Harness）—— 插件与本地翻译服务的代码实现与实测
- **模型顾问**：DeepSeek 大模型 —— 翻译提示词蓝本与优化建议

## 架构

```
主模型（DeepSeek-V4-Pro）产出英文 reasoning
        │  session/event（纯 emit 监听，不改流）
        ▼
DSH 插件 Host 半：收集 reasoning → 切段 → 只翻英文 → 调本地服务
        │  HTTP POST /v1/translate（127.0.0.1:7860）
        ▼
本地推理服务（本仓库 server/serve.py）：Qwen3.5-0.8B on GPU，概括成中文
        │  host.call 轮询
        ▼
DSH 插件 Client 半：右侧窄面板，彩色步骤标注 + 回到底部
```

## 目录结构

```
cot-translate-local/
├── server/            # 本地翻译服务
│   ├── serve.py       # 推理服务主程序
│   ├── index.html     # 独立翻译 Web UI
│   └── requirements.txt
├── plugin/            # DSH 动态插件
│   ├── host.js        # Host 半（监听 & 调度）
│   └── client.js      # Client 半（右侧面板）
├── docs/              # 文档（技术报告 / 恢复手册）
├── LICENSE            # MIT
├── THIRD_PARTY_NOTICES.md
└── README.md
```

## 安装

### 1. 准备模型权重

从 HuggingFace 下载 Qwen3.5-0.8B（约 1.6GB，Apache-2.0 许可证）：

```bash
# 放到 server/models/ 下，或设置环境变量 QWEN_LOCAL_MODEL_DIR 指向它
git lfs install
git clone https://huggingface.co/Qwen/Qwen3.5-0.8B server/models/Qwen3.5-0.8B
```

> 如需替换为其他 Qwen 系列小模型：把权重放到 `server/models/`，并相应调整 `MODEL_DIR` 与 `TRANSLATE_SYSTEM` 提示词。

### 2. 安装依赖并启动本地服务

```bash
cd server
pip install -r requirements.txt
python serve.py
# 验证：curl http://127.0.0.1:7860/health
```

环境变量（可选）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QWEN_LOCAL_MODEL_DIR` | `server/models/Qwen3.5-0.8B` | 模型目录 |
| `QWEN_LOCAL_HOST` | `127.0.0.1` | 监听地址 |
| `QWEN_LOCAL_PORT` | `7860` | 监听端口 |

> 需要 4GB 左右显存的 GPU（CPU 也能跑，但慢）。实测 Quadro T1000（4GB）
> 加载 bfloat16 权重约 1.4GB 显存，单段推理约 3 秒。

### 3. 在 DSH 中安装插件

本插件是 DSH「动态 Cordis 插件」。在 DSH 对话中，把 `plugin/host.js` 和
`plugin/client.js` 的内容分别提交给 `cordis_define`（Host 半填 `code.host`，
Client 半填 `code.client`），再 `cordis_run` 激活。

> 动态插件是进程内临时的，DSH 重启后需重新激活。详见 `docs/恢复手册.md`。

## 配置与调优

| 参数 | 位置 | 说明 |
|---|---|---|
| 切块跨度（200 词） | `plugin/host.js` | `800/1500` 字符阈值 |
| 节流间隔 | `plugin/host.js` | 默认 300ms |
| 历史存储目录 | `plugin/host.js` `HISTORY_DIR` | 按需修改 |
| 翻译提示词 | `server/serve.py` `TRANSLATE_SYSTEM` | 概括风格 + 否定词防错 |
| 面板宽/高 | `plugin/client.js` CSS | 默认 208px / 72vh |

## 许可证

- 本项目代码：**MIT**（见 LICENSE）
- 模型权重 Qwen3.5-0.8B：**Apache-2.0**（Qwen 团队所有，本项目不重新分发）

详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 已知限制

- 0.8B 小模型在长段、复杂否定、代码混杂场景下偶有漏译/重复，属参数规模固有局限。
- 语言判断为启发式（中英字符占比），极端混排时可能误判。
- 服务端仅提供翻译接口（`/v1/translate`），聊天、记忆、多模态等扩展功能不在本仓库内。
