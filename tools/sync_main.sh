#!/usr/bin/env bash
# ============================================================
# sync_main.sh —— 把当前 worktree 的提交同步到主工作副本，并恢复 L1 内置包
#
# 为什么需要它：主工作副本 D:/workqwen/DreamEngine-1 是 CEP 扩展 Junction
# 的指向，AE 实际加载的是它。而 install_l1 会往主工作副本的数据目录写
# manifest.json / previews.tsv，这些文件又被 git 跟踪，
# 下次合并就会因为「本地改动会被覆盖」而中止——之前几轮合并就是这样静默失败的。
#
# 正确顺序：先把会被覆盖的运行时文件备份并清掉 → 快进合并 → 重装 L1 包。
#
# 用法：bash tools/sync_main.sh [主工作副本路径] [分支名]
# ============================================================
set -euo pipefail

MAIN="${1:-D:/workqwen/DreamEngine-1}"
BRANCH="${2:-workbuddy/main-d673b851}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_REL="cep/com.dreamengine.panel/data"
BACKUP_DIR="$HOME/Documents/DreamEngineProbe"

cd "$MAIN"

# 1. 备份并清掉会被合并覆盖的运行时文件
if [ -f "$DATA_REL/manifest.json" ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  cp "$DATA_REL/manifest.json" "$BACKUP_DIR/manifest-runtime-$STAMP.json"
  echo "运行时索引已备份 -> $BACKUP_DIR/manifest-runtime-$STAMP.json"
fi
git checkout -- "$DATA_REL/manifest.json" 2>/dev/null || true
rm -f "$DATA_REL/previews.tsv"
rm -f "$DATA_REL"/manifest.json.backup-*

# 2. 快进合并
git merge --ff-only "$BRANCH"

# 3. 先按运行时的最新成果重新打包，再装回去。
#    顺序不能反：直接装旧包会把刚渲出来的预览覆盖成上一轮的结果。
#    （实测踩过：整批重渲 60 条之后一同步，索引被打回旧包，帧文件成了孤儿。）
cd "$HERE"
if [ -f "$MAIN/$DATA_REL/manifest.json" ]; then
  node tools/package_l1.mjs --data "$MAIN/$DATA_REL" --out "dist/L1" || \
    echo "重新打包失败，沿用仓库里的包"
fi
node tools/install_l1.mjs --target "$MAIN/$DATA_REL"

# 4. 报告
cd "$MAIN"
echo "主工作副本：$(git log --oneline -1)"
echo "缩略图：$(ls "$DATA_REL/thumbs" | wc -l) 个"
