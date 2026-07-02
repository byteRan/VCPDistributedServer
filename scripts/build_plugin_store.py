#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Build VCP official plugin store index and per-plugin zip packages.

Usage:
    python scripts/build_plugin_store.py

Optional:
    python scripts/build_plugin_store.py --repo lioensky/VCPDistributedServer --branch main
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List


SAFE_PLUGIN_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

DEFAULT_EXCLUDE_DIRS = {
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "env",
    "dist",
    "build",
    "target",
}

DEFAULT_EXCLUDE_FILE_NAMES = {
    ".DS_Store",
    "Thumbs.db",
    "config.env",
    ".env",
    ".env.local",
    ".env.production",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
}

DEFAULT_EXCLUDE_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".log",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".tmp",
    ".bak",
    ".zip",
    ".tar",
    ".tgz",
    ".gz",
}

CATEGORY_BY_PLUGIN_TYPE = {
    "static": "data-provider",
    "service": "service",
    "hybridservice": "service",
    "synchronous": "tool",
    "asynchronous": "tool",
}


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")

    return data


def write_json(path: Path, data: Dict[str, Any]) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def is_safe_plugin_name(name: str) -> bool:
    return bool(name and SAFE_PLUGIN_NAME_RE.fullmatch(name) and not name.startswith("."))


def normalize_category(manifest: Dict[str, Any]) -> str:
    raw = str(manifest.get("category") or "").strip()
    if raw:
        return raw

    plugin_type = str(manifest.get("pluginType") or manifest.get("type") or "").strip().lower()
    if plugin_type in CATEGORY_BY_PLUGIN_TYPE:
        return CATEGORY_BY_PLUGIN_TYPE[plugin_type]

    name = str(manifest.get("name") or "").lower()
    display_name = str(manifest.get("displayName") or "").lower()
    description = str(manifest.get("description") or "").lower()
    searchable_text = f"{name} {display_name} {description}"

    if any(k in searchable_text for k in ["image", "gen", "draw", "flux", "doubao", "zimage", "comfy", "novelai", "webui", "图像", "绘图"]):
        return "image-generation"
    if any(k in searchable_text for k in ["video", "suno", "music", "midi", "音频", "音乐", "视频"]):
        return "media-generation"
    if any(k in searchable_text for k in ["search", "fetch", "crawl", "wiki", "serp", "arxiv", "paper", "搜索", "检索", "查询"]):
        return "information-retrieval"
    if any(k in searchable_text for k in ["shell", "executor", "file", "backup", "operator", "cos", "redis", "database", "文件", "数据库", "备份"]):
        return "system-integration"
    if any(k in searchable_text for k in ["agent", "message", "assistant", "dream", "task", "助手", "任务"]):
        return "agent-collab"
    if any(k in searchable_text for k in ["forum", "bilibili", "zhihu", "xiaohongshu", "social", "知乎", "小红书"]):
        return "social"
    if any(k in searchable_text for k in ["chrome", "bridge", "capture", "screenshot", "browser", "浏览器", "截图"]):
        return "browser"

    return "tool"


def should_exclude(path: Path, plugin_dir: Path) -> bool:
    rel_parts = path.relative_to(plugin_dir).parts

    for part in rel_parts:
        if part in DEFAULT_EXCLUDE_DIRS:
            return True

    name = path.name
    if name in DEFAULT_EXCLUDE_FILE_NAMES:
        return True

    lower_name = name.lower()
    if any(lower_name.endswith(suffix) for suffix in DEFAULT_EXCLUDE_SUFFIXES):
        return True

    return False


def iter_plugin_files(plugin_dir: Path) -> Iterable[Path]:
    for path in plugin_dir.rglob("*"):
        if path.is_dir():
            continue
        if path.name == "plugin-manifest.json.block":
            continue
        if should_exclude(path, plugin_dir):
            continue
        yield path


def build_plugin_zip(plugin_dir: Path, plugin_name: str, manifest_path: Path) -> Path:
    zip_path = plugin_dir / f"{plugin_name}.zip"
    if zip_path.exists():
        zip_path.unlink()

    parent_dir_name = plugin_dir.name

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for file_path in iter_plugin_files(plugin_dir):
            arcname = Path(parent_dir_name) / file_path.relative_to(plugin_dir)
            zf.write(file_path, arcname.as_posix())

        if manifest_path.name == "plugin-manifest.json.block":
            arcname = Path(parent_dir_name) / "plugin-manifest.json"
            zf.write(manifest_path, arcname.as_posix())

    return zip_path


def to_raw_download_url(repo: str, branch: str, zip_path: Path, root: Path) -> str:
    rel = zip_path.relative_to(root).as_posix()
    return f"https://raw.githubusercontent.com/{repo}/{branch}/{rel}"


def make_plugin_entry(
    manifest: Dict[str, Any],
    plugin_name: str,
    zip_url: str,
) -> Dict[str, Any]:
    display_name = str(manifest.get("displayName") or plugin_name).strip()
    description = str(manifest.get("description") or "").strip()
    version = str(manifest.get("version") or "").strip()
    author = str(manifest.get("author") or "VCP Team").strip()
    icon = str(manifest.get("icon") or "extension").strip()

    entry: Dict[str, Any] = {
        "name": plugin_name,
        "displayName": display_name,
        "description": description,
        "version": version,
        "author": author,
        "icon": icon,
        "category": normalize_category(manifest),
        "downloadUrl": zip_url,
    }

    for optional_key in ["homepage", "repository", "license", "minVcpVersion"]:
        value = manifest.get(optional_key)
        if isinstance(value, str) and value.strip():
            entry[optional_key] = value.strip()

    return entry


def build_store(root: Path, repo: str, branch: str, include_blocked: bool) -> Dict[str, Any]:
    plugin_root = root / "Plugin"
    if not plugin_root.is_dir():
        raise FileNotFoundError(f"Plugin directory not found: {plugin_root}")

    entries: List[Dict[str, Any]] = []
    skipped: List[str] = []

    for plugin_dir in sorted(plugin_root.iterdir(), key=lambda p: p.name.lower()):
        if not plugin_dir.is_dir():
            continue

        manifest_path = plugin_dir / "plugin-manifest.json"
        blocked_manifest_path = plugin_dir / "plugin-manifest.json.block"

        if not manifest_path.exists():
            if blocked_manifest_path.exists() and include_blocked:
                manifest_path = blocked_manifest_path
            else:
                skipped.append(f"{plugin_dir.name}: no plugin-manifest.json or included plugin-manifest.json.block")
                continue

        try:
            manifest = read_json(manifest_path)
            raw_name = str(manifest.get("name") or "").strip()

            if not is_safe_plugin_name(raw_name):
                skipped.append(f"{plugin_dir.name}: unsafe or empty manifest name: {raw_name!r}")
                continue

            zip_path = build_plugin_zip(plugin_dir, raw_name, manifest_path)
            zip_url = to_raw_download_url(repo, branch, zip_path, root)
            entries.append(make_plugin_entry(manifest, raw_name, zip_url))
            manifest_mode = "blocked-as-enabled" if manifest_path.name == "plugin-manifest.json.block" else "enabled"
            print(f"[OK] {raw_name} ({manifest_mode}) -> {zip_path.relative_to(root).as_posix()}")
        except Exception as exc:
            skipped.append(f"{plugin_dir.name}: {exc}")

    entries.sort(key=lambda item: str(item.get("displayName") or item.get("name") or "").lower())

    payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "name": "VCP 官方插件商店",
            "repository": f"https://github.com/{repo}",
            "branch": branch,
        },
        "plugins": entries,
    }

    write_json(root / "plugins.json", payload)

    print("")
    print(f"Generated plugins.json with {len(entries)} plugin(s).")
    if skipped:
        print("")
        print("Skipped:")
        for item in skipped:
            print(f"  - {item}")

    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build VCP plugin store registry and zip packages.")
    parser.add_argument("--repo", default="lioensky/VCPDistributedServer", help="GitHub repo in owner/name format.")
    parser.add_argument("--branch", default="main", help="GitHub branch for raw download URLs.")
    parser.add_argument("--root", default="", help="Repository root. Defaults to script parent parent.")
    parser.add_argument(
        "--exclude-blocked",
        action="store_true",
        help="Do not package plugin-manifest.json.block plugins. By default they are included and converted to plugin-manifest.json inside zip.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve() if args.root else repo_root_from_script()

    if not re.fullmatch(r"[^/\s]+/[^/\s]+", args.repo):
        print(f"Invalid --repo: {args.repo}", file=sys.stderr)
        return 2

    build_store(root=root, repo=args.repo, branch=args.branch, include_blocked=not args.exclude_blocked)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())