# Third-Party Notices

本项目（cot-translate-local）本身以 MIT 许可证发布（见 LICENSE）。
本文件列出项目运行所依赖的第三方软件及其许可证，供合规审查。

## 运行时依赖（Python）

| 组件 | 许可证 | 用途 |
|---|---|---|
| PyTorch (`torch`) | BSD-3-Clause | 模型推理框架 |
| HuggingFace Transformers (`transformers`) | Apache-2.0 | 模型加载与 tokenizer |
| 及其传递依赖（numpy、tokenizers、safetensors 等） | 各自许可证 | 数值计算 / 分词 / 权重加载 |

## 模型权重

本项目**不包含**模型权重文件。README 中指引用户从 HuggingFace 下载：

- **Qwen3.5-0.8B**（`Qwen/Qwen3.5-0.8B`），许可证：**Apache-2.0**（Qwen 系列通用协议）

模型权重版权归 Qwen 团队所有，请遵守其原始许可证条款。本项目仅以
`transformers.from_pretrained` 方式加载用户自行下载的权重，不重新分发权重。

## 前端依赖

`server/index.html` 为自包含单文件，无外部 CDN 依赖，仅使用浏览器原生 API。

## 说明

- 上述许可证文本请以各组件官方仓库为准。
- 若你在再分发时打包了模型权重或第三方库，需一并保留其许可证与声明。
