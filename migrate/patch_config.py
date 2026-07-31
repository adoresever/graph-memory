#!/usr/bin/env python3
"""把旧 graph-memory 插件的 llm/embedding 配置复制到 graph-memory-pro。
自动备份，不打印密钥明文。"""
import json, shutil, datetime, os, sys

path = os.path.expanduser("~/.openclaw/openclaw.json")
bak = f"{path}.pre-llm-patch.{datetime.datetime.now():%Y%m%d_%H%M%S}"
shutil.copy(path, bak)
print(f"backup: {bak}")

c = json.load(open(path))
entries = c.get("plugins", {}).get("entries", {})
old_cfg = entries.get("graph-memory", {}).get("config", {})
new_cfg = entries.get("graph-memory-pro", {}).get("config", {})

if not new_cfg:
    print("ERROR: graph-memory-pro config not found"); sys.exit(1)
if not old_cfg:
    print("ERROR: old graph-memory config not found (already removed?)"); sys.exit(1)

def redact(d):
    return {k: ("***" if ("key" in k.lower() or "password" in k.lower()) else v) for k, v in d.items()}

copied = []
if "llm" in old_cfg:
    new_cfg["llm"] = old_cfg["llm"]
    copied.append("llm")
    print(f"copied llm: {redact(old_cfg['llm'])}")
if "embedding" in old_cfg:
    new_cfg["embedding"] = old_cfg["embedding"]
    copied.append("embedding")
    print(f"copied embedding: {redact(old_cfg['embedding'])}")

if not copied:
    print("WARNING: old config has no llm/embedding — nothing copied"); sys.exit(1)

# 写回（保持格式）
json.dump(c, open(path, "w"), indent=2, ensure_ascii=False)
print(f"\nDONE — copied {copied} to graph-memory-pro config")
print("verify: python3 -c \"import json;print(list(json.load(open('" + path + "'))['plugins']['entries']['graph-memory-pro']['config'].keys()))\"")
