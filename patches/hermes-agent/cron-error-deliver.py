#!/usr/bin/env python3
"""Patch hermes-agent cron scheduler to route failed jobs separately."""

from pathlib import Path

import cron.scheduler


path = Path(cron.scheduler.__file__)
text = path.read_text()

old = """                delivery_error = None
                if should_deliver:
                    try:
                        delivery_error = _deliver_result(job, deliver_content, adapters=adapters, loop=loop)
                    except Exception as de:
                        delivery_error = str(de)
                        logger.error("Delivery failed for job %s: %s", job["id"], de)
"""

new = """                delivery_job = job
                if should_deliver and not success and job.get("error_deliver"):
                    delivery_job = dict(job)
                    delivery_job["deliver"] = job["error_deliver"]

                delivery_error = None
                if should_deliver:
                    try:
                        delivery_error = _deliver_result(delivery_job, deliver_content, adapters=adapters, loop=loop)
                    except Exception as de:
                        delivery_error = str(de)
                        logger.error("Delivery failed for job %s: %s", job["id"], de)
"""

if old not in text:
    if "delivery_job = job" in text and 'job.get("error_deliver")' in text:
        raise SystemExit(0)
    raise SystemExit(f"cron scheduler patch target not found in {path}")

path.write_text(text.replace(old, new))
