from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[3]
STATE_DIR = ROOT / "profiles" / "nikechan-another-world" / "state" / "karakuri-rate-limit"
DEFAULT_CHANNEL = "1493132651958112319"
NOTIFICATION_RE = re.compile(r"\bnotification_id:\s*(notif-[A-Za-z0-9_-]+)\b")
EXEMPT_RE = re.compile(
    r"(会話|話しかけ|話しかけられ|発言|返事|返信|譲渡|受け取|transfer|conversation|イベント|event)",
    re.IGNORECASE,
)


def register(ctx: Any) -> None:
    ctx.register_hook("pre_gateway_dispatch", _rate_limit_karakuri)


def _rate_limit_karakuri(event: Any, **_: Any) -> dict[str, str] | None:
    source = getattr(event, "source", None)
    if _platform_value(getattr(source, "platform", "")) != "discord":
        return None

    chat_id = str(getattr(source, "chat_id", "") or "").strip()
    if chat_id not in _target_channels():
        return None

    text = str(getattr(event, "text", "") or "")
    notification_id = _extract_notification_id(text)
    if not notification_id:
        logger.info("karakuri-rate-limit skip: no notification_id chat=%s", chat_id)
        return {"action": "skip", "reason": "karakuri_no_notification_id"}

    if EXEMPT_RE.search(text):
        logger.info(
            "karakuri-rate-limit allow exempt notification=%s chat=%s",
            notification_id,
            chat_id,
        )
        return None

    cooldown = _cooldown_seconds()
    if cooldown <= 0:
        return None

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state_path = STATE_DIR / "dispatch.json"
    state = _read_json(state_path)
    now = time.time()
    last_allowed = float(state.get("last_allowed_epoch") or 0)
    remaining = int(last_allowed + cooldown - now)
    if remaining > 0:
        logger.info(
            "karakuri-rate-limit skip: cooldown remaining=%ss notification=%s chat=%s",
            remaining,
            notification_id,
            chat_id,
        )
        return {"action": "skip", "reason": "karakuri_cooldown"}

    _write_json(
        state_path,
        {
            "last_allowed_epoch": now,
            "last_allowed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            "last_notification_id": notification_id,
            "last_message_id": str(getattr(event, "message_id", "") or ""),
        },
    )
    logger.info("karakuri-rate-limit allow notification=%s chat=%s", notification_id, chat_id)
    return None


def _target_channels() -> set[str]:
    raw = os.getenv("KARAKURI_RATE_LIMIT_CHANNELS", DEFAULT_CHANNEL)
    return {item.strip() for item in raw.split(",") if item.strip()}


def _cooldown_seconds() -> int:
    try:
        return int(os.getenv("KARAKURI_RATE_LIMIT_SECONDS", "600"))
    except ValueError:
        return 600


def _extract_notification_id(text: str) -> str | None:
    match = NOTIFICATION_RE.search(text)
    return match.group(1) if match else None


def _platform_value(value: Any) -> str:
    return str(getattr(value, "value", value) or "").strip().lower()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_json(path: Path, data: dict[str, Any]) -> None:
    temp_path = path.with_suffix(f".tmp.{os.getpid()}")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_path.replace(path)
