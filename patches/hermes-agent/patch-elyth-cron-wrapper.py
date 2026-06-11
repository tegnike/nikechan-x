from pathlib import Path

path = Path("/usr/local/lib/python3.11/dist-packages/gateway/delivery.py")
text = path.read_text()

if "def _strip_nikechan_elyth_cron_wrapper" not in text:
    marker = (
        "def _is_thread_not_found_delivery_error(result: Any) -> bool:\n"
        "    error = _send_result_error(result)\n"
        '    return bool(error and "thread not found" in error.lower())\n\n\n'
    )
    helper = '''def _strip_nikechan_elyth_cron_wrapper(content: str, metadata: Optional[Dict[str, Any]]) -> str:
    """Remove Hermes cron wrapper for the AI Nikechan ELYTH Discord report."""
    if not content.startswith("Cronjob Response: "):
        return content

    divider = "\\n-------------\\n\\n"
    footer_prefix = '\\n\\nTo stop or manage this job, send me a new message (e.g. "stop reminder '
    divider_pos = content.find(divider)
    footer_pos = content.rfind(footer_prefix)
    if divider_pos < 0 or footer_pos < 0 or footer_pos <= divider_pos:
        return content
    header = content[:divider_pos]
    if "\\n(job_id: " not in header:
        return content
    if (
        (metadata or {}).get("job_id") != "nikechan-another-world-elyth-live-v1"
        and "(job_id: nikechan-another-world-elyth-live-v1)" not in header
    ):
        return content
    body = content[divider_pos + len(divider):footer_pos].strip()
    return body or content


'''
    if marker not in text:
        raise SystemExit("helper insertion marker not found")
    text = text.replace(marker, marker + helper)

old = "        result = await adapter.send(target.chat_id, content, metadata=send_metadata or None)\n"
new = (
    "        platform_content = content\n"
    "        if target.platform == Platform.DISCORD:\n"
    "            platform_content = _strip_nikechan_elyth_cron_wrapper(content, send_metadata)\n"
    "        result = await adapter.send(target.chat_id, platform_content, metadata=send_metadata or None)\n"
)
if old in text and "platform_content = content" not in text:
    text = text.replace(old, new, 1)

old_retry = "                result = await adapter.send(target.chat_id, content, metadata=send_metadata or None)\n"
new_retry = "                result = await adapter.send(target.chat_id, platform_content, metadata=send_metadata or None)\n"
if old_retry in text:
    text = text.replace(old_retry, new_retry, 1)

path.write_text(text)

scheduler_path = Path("/usr/local/lib/python3.11/dist-packages/cron/scheduler.py")
scheduler_text = scheduler_path.read_text()
scheduler_old = '''    if wrap_response:
        task_name = job.get("name", job["id"])
        job_id = job.get("id", "")
        delivery_content = (
            f"Cronjob Response: {task_name}\\n"
            f"(job_id: {job_id})\\n"
            f"-------------\\n\\n"
            f"{content}\\n\\n"
            f"To stop or manage this job, send me a new message (e.g. \\"stop reminder {task_name}\\")."
        )
    else:
        delivery_content = content
'''
scheduler_new = '''    if job.get("id") == "nikechan-another-world-elyth-live-v1":
        delivery_content = content
    elif wrap_response:
        task_name = job.get("name", job["id"])
        job_id = job.get("id", "")
        delivery_content = (
            f"Cronjob Response: {task_name}\\n"
            f"(job_id: {job_id})\\n"
            f"-------------\\n\\n"
            f"{content}\\n\\n"
            f"To stop or manage this job, send me a new message (e.g. \\"stop reminder {task_name}\\")."
        )
    else:
        delivery_content = content
'''
if scheduler_old in scheduler_text and "nikechan-another-world-elyth-live-v1" not in scheduler_text[scheduler_text.find("if wrap_response:") - 200:scheduler_text.find("if wrap_response:") + 900]:
    scheduler_text = scheduler_text.replace(scheduler_old, scheduler_new, 1)
scheduler_path.write_text(scheduler_text)
