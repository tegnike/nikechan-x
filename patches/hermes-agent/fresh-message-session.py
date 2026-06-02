#!/usr/bin/env python3
"""Patch Hermes gateway session keys for selected per-message channels."""

from pathlib import Path

import gateway.session


path = Path(gateway.session.__file__)
text = path.read_text()

old = """    if isolate_user and participant_id:
        key_parts.append(str(participant_id))

    return ":".join(key_parts)
"""

new = """    if isolate_user and participant_id:
        key_parts.append(str(participant_id))

    fresh_channels = {
        item.strip()
        for item in os.getenv("HERMES_FRESH_MESSAGE_SESSION_CHANNELS", "").split(",")
        if item.strip()
    }
    if (
        source.platform == Platform.DISCORD
        and source.chat_id in fresh_channels
        and source.message_id
    ):
        key_parts.extend(["message", str(source.message_id)])

    return ":".join(key_parts)
"""

if old not in text:
    if "HERMES_FRESH_MESSAGE_SESSION_CHANNELS" in text:
        raise SystemExit(0)
    raise SystemExit(f"session key patch target not found in {path}")

path.write_text(text.replace(old, new))
