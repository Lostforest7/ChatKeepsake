# 开发指南

在 Windows x64 上安装 Node.js 24 LTS，在项目目录运行下面的命令。依赖锁定在 `package-lock.json`，测试使用虚构聊天和模拟的助手输出。

```powershell
npm ci --ignore-scripts
npm test
npm start
```

页面打开后，可以点 **看看保存后的样子** 验证阅读页。要用一套独立的数据做界面测试，可以在启动前把 `CHATKEEPSAKE_DATA_DIR` 指向临时目录。

```powershell
$env:CHATKEEPSAKE_DATA_DIR = Join-Path $env:TEMP 'ChatKeepsake-dev'
npm start
```

## 从哪里改

| 想改什么 | 从这里开始 |
| --- | --- |
| 主页面、按钮文案和交互 | [public/index.html](public/index.html)、[public/app.js](public/app.js)、[public/style.css](public/style.css) |
| 启动浏览器和复用已开的窗口 | [launcher.js](launcher.js) |
| 页面调用的本机接口和任务进度 | [server.js](server.js) |
| 查找微信数据目录、调用读取助手 | [discover-wechat.js](discover-wechat.js)、[weflow.js](weflow.js) |
| 保存记录、设置保存位置、生成 Excel | [archive.js](archive.js)、[save-location.js](save-location.js)、[export-excel.js](export-excel.js) |
| 读取转账与红包、生成收支总账 | [chat-payments.js](chat-payments.js)、[payment-ledger.js](payment-ledger.js) |
| 离线阅读页的样式和搜索 | [viewer/reader.css](viewer/reader.css)、[viewer/search.js](viewer/search.js)、[make-viewer.js](make-viewer.js) |
| 语音组件下载和离线转写 | [voice-runtime.js](voice-runtime.js)、[voice-assets.json](voice-assets.json)、[transcribe.py](transcribe.py) |
| 下载校验和续传 | [download-assets.js](download-assets.js) |
| 测试和示例 | [test/](test/)、[demo/](demo/) |

点击「保存选中的聊天」后，`public/app.js` 请求 `server.js`。后者把工作交给 `archive.js`，由它调用 WeFlow 并在临时目录生成导出。保存成功后，聊天才会出现在导出列表。批量导出的聊天各有一个子文件夹，可选的总账保存在批次根目录。阅读页的样式和搜索脚本嵌在 HTML 中。

## 打包 Windows 免安装版

提交要发布的改动后，在项目目录用 PowerShell 7 运行。

```powershell
pwsh -NoProfile -File .\scripts\package-windows.ps1
```

脚本从当前 Git 提交打包，校验官方 Windows x64 Node.js，并按锁文件安装依赖。已有 Node.js 官方 ZIP 时，可用 `-NodeArchive` 指定文件。

当前 GitHub 免安装版使用 `-UseCommandLauncher` 打包，入口为 `启动 ChatKeepsake.cmd`。

```powershell
pwsh -NoProfile -File .\scripts\package-windows.ps1 -UseCommandLauncher
```

EXE 启动器由 Windows 自带的 .NET Framework 编译器构建。它内嵌程序文件的 SHA-256 清单，每次启动时核对。

默认生成 `dist/ChatKeepsake-Windows-x64-unsigned.zip`，供本地测试。正式发布时，用 `-SignLauncher` 传入签名步骤。脚本会把启动器路径交给该步骤，验证通过后生成 `dist/ChatKeepsake-Windows-x64.zip`。下面的示例需要安装 Windows SDK 的 SignTool，并在签名环境中配置可用的可信代码签名证书。

```powershell
.\scripts\package-windows.ps1 -SignLauncher {
  param($Launcher)
  & signtool.exe sign /a /fd SHA256 /tr https://timestamp.digicert.com /td SHA256 $Launcher
  if ($LASTEXITCODE -ne 0) { throw 'Code signing failed.' }
}
```

将签名后的 ZIP 上传到 GitHub Releases，保留文件名供首页链接使用。签名服务只需要接收构建出的启动器。

## 提交改动

- 跟随现有格式。JavaScript 使用 CommonJS、两空格缩进，Python 使用四空格缩进。
- 修改导出或阅读页时，使用虚构消息验证正常结果和缺少媒体的情况。修改语音下载时，运行 `test/voice-download.test.js` 中的续传和校验测试。
- 提交前运行 `npm test`。GitHub Actions 也会在 Windows 上跑同一套测试。
- 报告问题时，附上 Windows、Node.js 和微信版本，以及用虚构内容复现的步骤。截图和日志应去掉微信账号、聊天内容、文件路径和启动地址。
