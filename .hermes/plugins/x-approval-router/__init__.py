from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[3]
STATE_DIR = ROOT / "state"


def register(ctx: Any) -> None:
    ctx.register_hook("pre_gateway_dispatch", _route_x_approval_thread)


def _route_x_approval_thread(event: Any, **_: Any) -> dict[str, str] | None:
    source = getattr(event, "source", None)
    platform = _platform_value(getattr(source, "platform", ""))
    if platform != "discord":
        return None

    thread_id = str(getattr(source, "chat_id", "") or "").strip()
    text = str(getattr(event, "text", "") or "").strip()
    if not thread_id or not text:
        return None

    match = _find_pending_for_thread(thread_id)
    if not match:
        return None

    rewritten = _build_rewrite_prompt(match, text)
    logger.info(
        "x-approval-router rewrote Discord thread %s as %s approval turn",
        thread_id,
        match["workflow"],
    )
    return {"action": "rewrite", "text": rewritten}


def _platform_value(value: Any) -> str:
    return str(getattr(value, "value", value) or "").strip().lower()


def _find_pending_for_thread(thread_id: str) -> dict[str, Any] | None:
    mention = _read_json(STATE_DIR / "pending-mention-reaction.json")
    if str(mention.get("threadId") or "") == thread_id:
        return {"workflow": "mention-reaction", "pending": mention}

    self_tweet = _read_json(STATE_DIR / "pending-self-tweet.json")
    if str(self_tweet.get("threadId") or "") == thread_id:
        return {"workflow": "self-tweet", "pending": self_tweet}

    return None


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _build_rewrite_prompt(match: dict[str, Any], master_reply: str) -> str:
    workflow = match["workflow"]
    pending = match["pending"]
    pending_json = json.dumps(_compact_pending(workflow, pending), ensure_ascii=False, indent=2)

    if workflow == "mention-reaction":
        instructions = """このDiscord threadはXメンション反応の承認・修正スレッドです。
マスターの返信を、固定文言ではなく文脈上の意図で判断してください。

判断方針:
- 「どうぞ」「お願い」「そのまま」「これで」「いいよ」など、現在候補を進める意図なら承認です。
- 番号や m1/m2 指定があれば該当候補だけ、指定がなければ現在提示中の実行対象を承認します。
- 「ここをこう変えて」「もう少し柔らかく」「この文だけ直して」などは修正です。LLM判断で候補全文を作り直し、`node scripts/nikechan-hermes.mjs mention-propose --preserve-thread true --items-json '<json>'` を実行してください。
- 質問・確認・ログ確認なら投稿せず、短く答えて pending を維持してください。
- このthreadでは self-tweet pending を実行しないでください。
- 承認時は `node scripts/nikechan-hermes.mjs mention-approve --ids ...` だけを実行し、結果を短く報告してください。

Discordへの返答スタイル:
- マスターには内部コマンド、pending ID、`needs_approval`、JSON、実行ログを見せないでください。マスターが明示的にログ確認を求めた場合だけ最小限に出します。
- 修正した場合は「了解しました。では雰囲気を変えて以下のような案でどうでしょう。」のように自然に返し、変更後の候補本文だけを見せてください。
- 承認・投稿した場合は投稿済みURLだけを簡潔に返してください。
- 事務報告ではなく、Discord上の会話として自然な短文にしてください。"""
    else:
        instructions = """このDiscord threadはXセルフツイートの承認・修正スレッドです。
マスターの返信を、固定文言ではなく文脈上の意図で判断してください。

判断方針:
- 「どうぞ」「お願い」「そのまま」「これで」「いいよ」など、現在候補を進める意図なら承認です。
- 番号指定があれば該当候補だけ、指定がなければ文脈上もっとも自然な候補を承認します。
- 「ここをこう変えて」「もっと短く」「語尾を変えて」などは修正です。LLM判断で候補を作り直し、`node scripts/nikechan-hermes.mjs propose --preserve-thread true --candidates-json '<json>'` を実行してください。
- 質問・確認・ログ確認なら投稿せず、短く答えて pending を維持してください。
- このthreadでは mention-reaction pending を実行しないでください。
- 承認時は `node scripts/nikechan-hermes.mjs approve --ids ...` だけを実行し、結果を短く報告してください。

Discordへの返答スタイル:
- マスターには内部コマンド、pending ID、`needs_approval`、JSON、実行ログを見せないでください。マスターが明示的にログ確認を求めた場合だけ最小限に出します。
- 修正した場合は「了解しました。では雰囲気を変えて以下のような案でどうでしょう。」のように自然に返し、変更後の候補本文だけを見せてください。
- 承認・投稿した場合は投稿済みURLだけを簡潔に返してください。
- 事務報告ではなく、Discord上の会話として自然な短文にしてください。"""

    return f"""{instructions}

## マスターの返信
{master_reply}

## 現在のpending
{pending_json}
"""


def _compact_pending(workflow: str, pending: dict[str, Any]) -> dict[str, Any]:
    base = {
        "id": pending.get("id"),
        "kind": pending.get("kind"),
        "status": pending.get("status"),
        "threadId": pending.get("threadId"),
        "threadName": pending.get("threadName"),
        "revisionCount": pending.get("revisionCount", 0),
    }
    if workflow == "mention-reaction":
        base["items"] = [
            {
                "id": item.get("id"),
                "tweetLogId": item.get("tweetLogId"),
                "postId": item.get("postId"),
                "username": item.get("username"),
                "displayName": item.get("displayName"),
                "type": item.get("type"),
                "body": item.get("body"),
                "originalTweetId": item.get("originalTweetId"),
                "originalTweetText": item.get("originalTweetText"),
                "replyAction": item.get("replyAction"),
                "replyText": item.get("replyText"),
                "quoteAction": item.get("quoteAction"),
                "quoteText": item.get("quoteText"),
                "reason": item.get("reason"),
            }
            for item in pending.get("items", [])
        ]
        base["candidates"] = [
            {
                "id": item.get("id"),
                "tweetLogId": item.get("tweetLogId"),
                "postId": item.get("postId"),
                "username": item.get("username"),
                "displayName": item.get("displayName"),
                "nickname": item.get("nickname"),
                "type": item.get("type"),
                "body": item.get("body"),
                "originalTweetId": item.get("originalTweetId"),
                "originalTweetText": item.get("originalTweetText"),
            }
            for item in pending.get("candidates", [])
        ]
    else:
        base["candidates"] = [
            {
                "id": item.get("id"),
                "text": item.get("text"),
                "reason": item.get("reason"),
                "sourceMode": item.get("sourceMode"),
                "guard": item.get("guard"),
            }
            for item in pending.get("candidates", [])
        ]
    return base
