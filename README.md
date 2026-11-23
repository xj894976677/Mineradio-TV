# Mineradio TV

把 [Mineradio](https://github.com/XxHuberrr/Mineradio-paused) 的粒子舞台搬到 Android 电视上。可以播放 U 盘和移动硬盘里的音乐，也可以扫码登录网易云音乐听在线歌曲。所有东西都在一个安装包里，不需要另外的电脑或服务器，全程用遥控器操作。

> **状态：早期版本（0.3.0）。** 界面和播放逻辑已经在电脑浏览器里测过，APK 可以编译；**还没有在真实电视上完成验证**，粒子效果在电视芯片上的流畅度也还没测。

## 和原版 Mineradio 的关系

Mineradio TV 是 [XxHuberrr/Mineradio-paused](https://github.com/XxHuberrr/Mineradio-paused) 的 fork，舞台本身完全依赖原项目：

- **视觉全部来自原版。** 粒子、镜头、歌词舞台、13 种视觉形态都是 Mineradio 的网页界面（仓库里的 `public/`），这里**一行没改**，直接打包进电视应用。
- **TV 版新增的东西都在 `tv/` 目录**：一个 Android TV 外壳、离线曲库，以及盖在舞台上的遥控器操作层。
- **在线音乐用的是原版的后端**（`server.js` 和网易云、QQ、酷狗的接口模块），同样没有修改，和 Node.js 运行库一起打包进安装包，在电视本机运行，只监听 `127.0.0.1`。
- **没有带上的部分**：汽水音乐（它的模块依赖 Electron，并且包含受保护音频的解密代码，TV 版不带）、桌面歌词、壁纸模式、原版的首页和搜索界面。

原版是 Windows 桌面播放器，作者已宣布长期停更并欢迎二次创作。想在电脑上用，请去[原项目](https://github.com/XxHuberrr/Mineradio-paused)或它的官网 [mineradio.cn](https://mineradio.cn/)。Mineradio 的名称、MR 标识和视觉设计属于原作者。

## 功能

- **网易云音乐**：电视上显示二维码，用手机 App 扫码登录；登录后有每日推荐、你的歌单和推荐歌单，不登录也能听榜单。
- **QQ 音乐**：打开 QQ 官方的扫码登录页，用手机 QQ 扫码；登录后可以听你的 QQ 音乐歌单。
- 登录信息只保存在电视上。
- **插上就播**：自动扫描 U 盘、移动硬盘和电视本机里的音乐，插拔 U 盘会自动刷新。
- **接着上次播**：记住上次播放的歌曲和进度，下次打开从那里继续。
- **标准的离线曲库**：从文件标签读取标题、歌手、专辑、时长和内嵌封面；按全部歌曲、文件夹、专辑、艺人浏览。
- **歌词**：和歌曲同名的 `.lrc` 文件会显示在歌词舞台上（支持 UTF-8、UTF-16、GBK）。
- **封面**：优先用文件内嵌的封面；没有的话用同名图片，或文件夹里的 `cover.jpg` / `folder.jpg`。
- **13 种视觉形态**，播放时按上下键随时切换。
- **支持的格式**：MP3、FLAC、M4A、AAC、WAV、OGG、Opus（取决于电视系统 WebView 的解码能力）。

## 遥控器

| 按键 | 作用 |
| --- | --- |
| ◀ ▶ | 上一首 / 下一首；长按快退 / 快进 |
| ▲ ▼ | 切换视觉形态 |
| OK | 播放 / 暂停；长按打开曲库 |
| 菜单 | 设置：播放顺序、歌词、画面精细度、账号、重新扫描 |
| 返回 | 回到上一级；在舞台上连按两次退出 |

遥控器没有菜单键时，曲库的最后一行是「设置…」。

## 视觉形态

按上下键依次切换：emily 专辑封面、月蚀圣环、雨幕霓虹、折光蝶群、深海绽放、安魂、音域回响 Sonic-Topography、音域回响 Wallpaper Engine、星河、唱片、星球、滚筒、虚空。

这些都是原版 Mineradio 的预设，作者信息见 [NOTICE.md](./NOTICE.md)。

## 怎么整理音乐

```
U 盘/
├── 周杰伦 - 叶惠美/
│   ├── cover.jpg          ← 这个文件夹里没有内嵌封面的歌用它
│   ├── 01 以父之名.flac
│   ├── 01 以父之名.lrc     ← 同名 .lrc 是歌词
│   └── 02 懦夫.flac
└── 随便听听/
    └── 某首歌.mp3
```

U 盘建议格式化成 exFAT 或 FAT32。文件夹最多扫描 10 层，名为 `Android`、`Ringtones`、`Notifications`、`Alarms` 的系统文件夹会跳过。

## 安装

目前没有发布安装包，需要自己编译（见下），然后用 adb 安装：

```bash
adb install -r tv/app/build/outputs/apk/release/app-release.apk
```

读取 U 盘里的歌词和封面图片需要「所有文件访问」权限。第一次打开时应用会引导授权；电视的设置里没有这个页面时，用 adb 授权：

```bash
adb shell appops set tv.mineradio.app MANAGE_EXTERNAL_STORAGE allow
```

没有这个权限时，应用退回到只读取音频文件：能播放、能显示内嵌封面，但读不到 `.lrc` 和 `cover.jpg`。

要求 Android 7.0 及以上的 Android TV 或电视盒子。

## 编译

需要 JDK 17、Android SDK（平台 35）和 Node.js。

```bash
npm install --omit=dev          # 后端的依赖，会打包进 APK
cd tv
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties
./gradlew :app:assembleRelease   # 约 26 MB，用调试密钥签名
```

在线音乐还需要两个不在仓库里的运行库，放进 `tv/app/src/main/jniLibs/arm64-v8a/`：

- `libnode.so`：来自 [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile/releases) v18.20.4 的 `nodejs-mobile-v18.20.4-android.zip`（`bin/arm64-v8a/`）；
- `libc++_shared.so`：来自 Android NDK（`toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/`）。

仓库里已有的 `libnodebridge.so` 是 `tv/native/node_bridge.c` 编译出来的，重新编译见 `tv/native/build.sh`。缺少这两个运行库时应用照常编译，只是没有在线音乐。

## 在电脑上调试

不用电视也能看效果。开发服务器提供和电视应用相同的接口，同样会启动后端，用电脑上的音乐文件夹当曲库（需要 Node.js 和 ffmpeg，先在仓库根目录 `npm install --omit=dev`）：

```bash
node tv/dev/dev-server.js ~/Music
```

然后打开 <http://127.0.0.1:8790>。键盘方向键对应遥控器方向键，回车是 OK，Esc 是返回，Tab 是菜单。

## 目录

| 路径 | 内容 |
| --- | --- |
| `public/` | Mineradio 原版网页界面，未修改 |
| `tv/app/` | Android TV 应用：全屏 WebView、请求路由（`TvRouter.kt`）、离线曲库（`MusicLibrary.kt`） |
| `tv/app/src/main/assets/tv/` | TV 操作层：按键、曲库和设置面板、正在播放卡片、开场标题 |
| `tv/backend/` | `start.js` 启动原版后端，把不带的模块换成「不可用」；`pack.js` 挑出后端用得到的文件打包；`bundle-ui.js` 把界面模块合成一个脚本 |
| `tv/native/` | 启动 Node 的那一个原生函数 |
| `tv/dev/` | 电脑上用的开发服务器 |
| `server.js`、`*-api.js`、`cuefield/` 等 | 原版后端，未修改，打包进应用 |
| 其余文件（`desktop/`、`qishui-*` 等） | 原版桌面端的代码，TV 版不使用，为了方便同步上游而保留 |

## 同步上游

```bash
git remote add upstream https://github.com/XxHuberrr/Mineradio-paused.git
git fetch upstream
git merge upstream/main
```

TV 版的代码只在 `tv/` 和本文件里，合并上游一般只有 README 会冲突。

## 在线音乐的限制

- 界面上接了**网易云音乐**（扫码登录、每日推荐、我的歌单、推荐歌单、榜单）和 **QQ 音乐**（扫码登录、我的歌单）。酷狗在原版里是粘贴 Cookie 登录，电视上没有合适的输入方式，还没接。搜索也还没做。
- QQ 音乐的扫码登录只在电视应用里有，电脑上的开发服务器试不了；这一步写好后还没有在电视上验证过。
- 走的是非官方接口，平台改动后可能失效；能听哪些歌、什么音质取决于你自己的账号。请遵守各平台的服务协议。
- 在线音乐需要 64 位 ARM 的电视（Node 运行库只打包了 arm64）。其他设备上在线部分不可用，本地播放不受影响。

## 隐私

没有任何第三方服务器：页面和后端都运行在电视本机。联网只发生在你使用在线音乐时，连接的是音乐平台自己的服务器。账号登录信息、播放进度和设置都只保存在电视本地。

## 许可证

[GPL-3.0-only](./LICENSE)，与原项目相同。修改版同样以 GPL-3.0 发布，本仓库就是对应的完整源码。第三方组件和原项目的致谢见 [NOTICE.md](./NOTICE.md)。

## 致谢

感谢 [XxHuberrr](https://github.com/XxHuberrr) 和 Mineradio 的所有贡献者，TV 版的每一帧画面都来自他们的工作。
