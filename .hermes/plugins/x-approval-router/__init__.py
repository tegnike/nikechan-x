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
        return {"workflow": "mention-reaction", "pending": mention, "archived": False}

    archived_mention = _find_archived_mention_for_thread(thread_id)
    if archived_mention:
        return {"workflow": "mention-reaction", "pending": archived_mention, "archived": True}

    self_tweet = _read_json(STATE_DIR / "pending-self-tweet.json")
    if str(self_tweet.get("threadId") or "") == thread_id:
        return {"workflow": "self-tweet", "pending": self_tweet, "archived": False}

    return None


def _find_archived_mention_for_thread(thread_id: str) -> dict[str, Any] | None:
    matches: list[tuple[int, dict[str, Any]]] = []
    for path in STATE_DIR.glob("pending-mention-reaction.*.json"):
        name = path.name
        if ".executed-" in name or ".cancelled-" in name:
            continue
        pending = _read_json(path)
        reason = str(pending.get("archiveReason") or pending.get("status") or name)
        remaining_ids = _remaining_mention_ids(pending)
        is_closed = ".closed." in name
        if not is_closed and "superseded" not in reason:
            continue
        if is_closed and not remaining_ids:
            continue
        if str(pending.get("threadId") or "") != thread_id:
            continue
        if pending.get("cancelledAt"):
            continue
        if pending.get("executedAt") and not remaining_ids:
            continue
        matches.append((_archived_sort_key(path, pending), pending))
    if not matches:
        return None
    matches.sort(key=lambda item: item[0], reverse=True)
    return matches[0][1]


def _remaining_mention_ids(pending: dict[str, Any]) -> list[str]:
    items = pending.get("items")
    if not isinstance(items, list):
        return []
    executed = _executed_mention_ids(pending)
    actionable = [
        str(item.get("id"))
        for item in items
        if item.get("id") and str(item.get("id")) not in executed
        and (item.get("replyAction") == "reply" or item.get("quoteAction") == "quote")
    ]
    if actionable:
        return actionable
    return [str(item.get("id")) for item in items if item.get("id") and str(item.get("id")) not in executed]


def _executed_mention_ids(pending: dict[str, Any]) -> set[str]:
    result = pending.get("executionResult")
    if not isinstance(result, dict):
        return set()
    results = result.get("results")
    if not isinstance(results, list):
        return set()
    return {str(entry.get("itemId") or entry.get("item_id")) for entry in results if isinstance(entry, dict) and (entry.get("itemId") or entry.get("item_id"))}


def _archived_sort_key(path: Path, pending: dict[str, Any]) -> int:
    parts = path.name.split(".")
    if len(parts) > 1 and parts[1].isdigit():
        return int(parts[1])
    for key in ("archivedAt", "notifiedAt", "createdAt"):
        value = str(pending.get(key) or "")
        if value:
            return int(path.stat().st_mtime * 1000)
    return int(path.stat().st_mtime * 1000)


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
        thread_id = str(pending.get("threadId") or "").strip()
        archived_note = "\n- この候補は後続候補で退避済みですが、このthreadの上の候補が正です。承認時は必ず --thread-id を付けてください。" if match.get("archived") else ""
        instructions = f"""このDiscord threadはXメンション反応の承認・修正スレッドです。
マスターの返信を、固定文言ではなく文脈上の意図で判断してください。

判断方針:
- 「どうぞ」「お願い」「そのまま」「これで」「いいよ」など、現在候補を進める意図なら承認です。
- 番号や m1/m2 指定があれば該当候補だけを承認します。
- 番号指定のない承認語なら、CLI側で現在提示中の実行対象を全件選ぶため `--ids` を付けないでください。
- 「ここをこう変えて」「もう少し柔らかく」「この文だけ直して」などは修正です。LLM判断で候補全文を作り直し、`node scripts/nikechan-x.mjs mention-propose --preserve-thread true --items-json '<json>'` を実行してください。
- 質問・確認・ログ確認なら投稿せず、短く答えて pending を維持してください。
- このthreadでは self-tweet pending を実行しないでください。{archived_note}
- 承認時は `node scripts/nikechan-x.mjs mention-approve --thread-id {thread_id}` を実行してください。番号指定がある場合だけ `--ids m1,m2` を付けます。

Discordへの返答スタイル:
- マスターには内部コマンド、pending ID、`needs_approval`、JSON、実行ログを見せないでください。マスターが明示的にログ確認を求めた場合だけ最小限に出します。
- 修正した場合は「了解しました。では雰囲気を変えて以下のような案でどうでしょう。」のように自然に返し、変更後の候補本文だけを見せてください。
- 承認・投稿した場合は投稿済みURLだけを簡潔に返してください。
- 事務報告ではなく、Discord上の会話として自然な短文にしてください。"""
    else:
        instructions = """このDiscord threadはXセルフツイートのネタ相談スレッドです。
マスターの返信を、固定文言ではなく文脈上の意図で判断してください。

判断方針:
- 現在pendingは投稿本文ではなく、ソース付きのネタ候補です。
- 番号指定は「そのネタを広げたい」という意味で扱い、投稿承認として扱わないでください。
- 「どうぞ」「お願い」「そのまま」「これで」「いいよ」だけでは投稿しません。最終本文が未確定なら、選ばれたネタの切り口を一緒に詰めてください。
- 「このネタは違う」「別角度で」「ソースを変えて」などは修正です。LLM判断でネタ候補JSONを作り直し、`node scripts/nikechan-x.mjs propose --preserve-thread true --candidates-json '<json>'` を実行してください。
- 質問・確認・ログ確認なら投稿せず、短く答えて pending を維持してください。
- このthreadでは mention-reaction pending を実行しないでください。
- `node scripts/nikechan-x.mjs approve --ids ...` は使わないでください。
- マスターと最終投稿本文まで合意し、その本文を明示的に「投稿して」と言われた場合だけ、`node scripts/nikechan-x.mjs post --action tweet --source self-tweet --text '...'` を実行してください。

Discordへの返答スタイル:
- マスターには内部コマンド、pending ID、`needs_approval`、JSON、実行ログを見せないでください。マスターが明示的にログ確認を求めた場合だけ最小限に出します。
- ネタを選ばれた場合は、なぜそのネタが使えそうか、どの切り口に寄せるか、本文に入れる/入れない要素を短く相談してください。
- 修正した場合は、変更後のネタ候補をソース・理由つきで見せてください。
- 投稿した場合だけ投稿済みURLを簡潔に返してください。
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
        remaining_ids = set(_remaining_mention_ids(pending))
        executed_ids = sorted(_executed_mention_ids(pending))
        source_items = pending.get("items", [])
        if executed_ids:
            source_items = [item for item in source_items if str(item.get("id") or "") in remaining_ids]
        base["remainingItemIds"] = sorted(remaining_ids)
        base["executedItemIds"] = executed_ids
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
            for item in source_items
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
                "title": item.get("title"),
                "angle": item.get("angle"),
                "text": item.get("text"),
                "reason": item.get("reason"),
                "sourceRefs": item.get("sourceRefs"),
                "sourceMode": item.get("sourceMode"),
                "guard": item.get("guard"),
            }
            for item in pending.get("candidates", [])
        ]
    return base
