# 第三方组件

## Node.js 24.22.3

Windows 免安装版包含 [Node.js 官方发布的 Windows x64 运行文件](https://nodejs.org/en/blog/release/v24.22.3)。原始许可证和第三方声明随包保存在 `app/Node.js-LICENSE.txt`。

## WeFlow CLI v5.0.1

ChatKeepsake 通过进程调用 Windows x64 版 WeFlow CLI 来读取、导出用户所选会话。点击「安装读取助手」后，程序从 [334456777/WeFlow 的 v5.0.1 发布页](https://github.com/334456777/WeFlow/releases/tag/v5.0.1) 下载原版组件。仓库发布 ChatKeepsake 的源码与示例。

该版本使用 [CC BY-NC-SA 4.0](https://github.com/334456777/WeFlow/blob/v5.0.1/LICENSE)，包含非商业使用限制。ChatKeepsake 的 MIT 许可只覆盖本项目的代码。安装时保留 WeFlow 的许可证文件。

安装时按发布页的 [资产摘要](https://github.com/334456777/WeFlow/releases/expanded_assets/v5.0.1) 校验 ZIP 的 SHA-256。

    8d88ca61c504c8d509fd7b6934e4d2261ba986f6a1e13df68c3732323e1b26fa

## 可选语音识别

首次点击「把语音变成文字」时，工具从 [Python.org](https://www.python.org/downloads/release/python-31410/) 获取 Windows x64 便携运行环境，从 [PyPI](https://pypi.org/project/faster-whisper/1.2.1/) 获取 faster-whisper 1.2.1 及其依赖，并使用 [msvc-runtime](https://pypi.org/project/msvc-runtime/14.51.36231/) 中的应用内 C++ 运行库。从 [Systran 的模型页面](https://huggingface.co/Systran/faster-whisper-small) 获取适用于 CTranslate2 的 Whisper small 模型。下载文件按项目清单校验，语音识别在本机离线运行。
