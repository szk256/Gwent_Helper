# 对局 HUD 原型

识别屏幕右侧自动放大展示的对方出牌，在置顶小窗里列出“对方本局已出的牌”，按小局分组，解牌（锁定 / 摧毁 / 放逐 / 重置 / 4 点以上伤害）标红。

只截屏幕上公开显示的画面：不改游戏、不读内存、不抓网络包。

## 安装（一次）

```bash
python -m pip install --user opencv-python mss numpy Pillow
node hud/export_cards.js
python hud/build_db.py
```

`build_db.py` 从 gwent.one 下载卡图（约 130 MB，存 `hud/cache/`，不提交），建 SIFT 特征库 `cache/db.npz`。网络走 `HTTPS_PROXY`。卡牌数据更新（补丁、新牌）后重跑这两步。

## 使用

```bash
python hud/hud.py
```

- 游戏用**无边框窗口**或窗口模式（独占全屏可能截不到）。多显示器时加 `--monitor N`（默认选分辨率最大的那个）。
- HUD 窗口默认从截屏里排除（不会挡住识别区域，录屏也录不到它）；想让录屏录到就加 `--no-hide`。
- 按钮：下一小局 / 扫墓场（先在游戏里打开敌方墓场，识别当前一屏）/ 撤销 / 复制 / 暂停。
- 点一行看效果和候选；右键可改成其他候选或删除。
- 每局的展示截图和识别结果存在 `hud/cache/log/<时间>/`，`python hud/eval.py log` 可重新识别，用来调参数、统计准确率。

## 不会识别的

由其他牌生成 / 召唤出来的单位（游戏不在右侧展示），交给对局簿推算引擎。

## 文件

- `export_cards.js`：`src/data.js`（套最新补丁）→ `cache/cards.json`
- `build_db.py`：下载卡图、建特征库
- `detect.py`：展示区位置（按画面比例）、是否出现（说明框羊皮纸颜色）、墓场网格找牌
- `matcher.py`：SIFT + FLANN 投票识别；`removal_kind` 按卡面文字判断解牌
- `hud.py`：置顶小窗（tkinter）+ 后台截屏线程
- `eval.py`：截图测试、模拟测试、重新识别日志
