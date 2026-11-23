# Mineradio TV

把 [Mineradio](https://github.com/XxHuberrr/Mineradio-paused) 的粒子舞台搬到 Android 电视上，用来播放 U 盘和移动硬盘里的音乐。不联网、不登录、不需要服务器，插上 U 盘就开始播放，全程用遥控器操作。

> **状态：早期版本（0.1.0）。** 界面和播放逻辑已经在电脑浏览器里测过，APK 可以编译；**还没有在真实电视上完成验证**，粒子效果在电视芯片上的流畅度也还没测。

## 和原版 Mineradio 的关系

Mineradio TV 是 [XxHuberrr/Mineradio-paused](https://github.com/XxHuberrr/Mineradio-paused) 的 fork，舞台本身完全依赖原项目：

- **视觉全部来自原版。** 粒子、镜头、歌词舞台、13 种视觉形态都是 Mineradio 的网页界面（仓库里的 `public/`），这里**一行没改**，直接打包进电视应用。
- **TV 版新增的东西都在 `tv/` 目录**：一个 Android TV 外壳、离线曲库，以及盖在舞台上的遥控器操作层。
- **没有带上的部分**：原版的在线音源和账号登录（`server.js`、各平台的 `*-api.js`）、桌面歌词、壁纸模式、搜索和首页。TV 版只做离线播放。

原版是 Windows 桌面播放器，作者已宣布长期停更并欢迎二次创作。想在电脑上用，请去[原项目](https://github.com/XxHuberrr/Mineradio-paused)或它的官网 [mineradio.cn](https://mineradio.cn/)。Mineradio 的名称、MR 标识和视觉设计属于原作者。

## 功能

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
| 菜单 | 设置：播放顺序、歌词、画面精细度、重新扫描 |
| 返回 | 关闭面板；在舞台上连按两次退出 |

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
adb install -r tv/app/build/outputs/apk/debug/app-debug.apk
```

读取 U 盘里的歌词和封面图片需要「所有文件访问」权限。第一次打开时应用会引导授权；电视的设置里没有这个页面时，用 adb 授权：

```bash
adb shell appops set tv.mineradio.app MANAGE_EXTERNAL_STORAGE allow
```

没有这个权限时，应用退回到只读取音频文件：能播放、能显示内嵌封面，但读不到 `.lrc` 和 `cover.jpg`。

要求 Android 7.0 及以上的 Android TV 或电视盒子。

## 编译

需要 JDK 17 和 Android SDK（平台 35）。

```bash
cd tv
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties
./gradlew :app:assembleDebug
```

## 在电脑上调试

不用电视也能看效果。开发服务器提供和电视应用相同的接口，用电脑上的音乐文件夹当曲库（需要 Node.js 和 ffmpeg）：

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
| `tv/dev/` | 电脑上用的开发服务器 |
| 其余文件 | 原版桌面端的代码，TV 版不使用，为了方便同步上游而保留 |

## 同步上游

```bash
git remote add upstream https://github.com/XxHuberrr/Mineradio-paused.git
git fetch upstream
git merge upstream/main
```

TV 版的代码只在 `tv/` 和本文件里，合并上游一般只有 README 会冲突。

## 隐私

应用不联网：页面的所有请求都由应用自己应答，原版的在线接口一律返回「离线」。应用只读取存储设备上的音乐、歌词和封面文件，播放进度和设置保存在电视本地。

## 许可证

[GPL-3.0-only](./LICENSE)，与原项目相同。修改版同样以 GPL-3.0 发布，本仓库就是对应的完整源码。第三方组件和原项目的致谢见 [NOTICE.md](./NOTICE.md)。

## 致谢

感谢 [XxHuberrr](https://github.com/XxHuberrr) 和 Mineradio 的所有贡献者，TV 版的每一帧画面都来自他们的工作。
