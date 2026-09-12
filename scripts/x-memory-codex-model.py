#!/usr/bin/env python3
"""Tool-free X extraction using the existing profile's Codex OAuth resolver.

Runs inside nikechan-x with HERMES_HOME set to its X profile. Credentials are
never copied, logged, or returned. Shared Hermes refresh locking is preserved.
"""
import json
import sys
import requests
from hermes_cli.auth import resolve_codex_runtime_credentials


def main():
    doc = json.load(sys.stdin)
    try:
        creds = resolve_codex_runtime_credentials()
        payload = {"model": doc.get("model", "gpt-5.5"), "instructions": doc["instructions"],
                   "input": [{"role": "user", "content": json.dumps(doc["input"], ensure_ascii=False)}],
                   "store": False, "stream": True, "tools": [],
                   "reasoning": {"effort": "medium"},
                   "text": {"format": {"type": "json_schema", "name": "x_batch", "strict": True, "schema": doc["schema"]}}}
        with requests.post(creds["base_url"].rstrip("/") + "/responses",
                           headers={"Authorization": "Bearer " + creds["api_key"], "Content-Type": "application/json"},
                           json=payload, stream=True, timeout=(15, 180)) as response:
            if response.status_code != 200:
                code = "model_authentication" if response.status_code in (401, 403) else "model_usage_limit" if response.status_code == 429 else "model_execution_failed"
                print(json.dumps({"error": code, "http_status": response.status_code})); return
            completed = None
            output_items = []
            failure_code = None
            for line in response.iter_lines():
                if not line.startswith(b"data: "): continue
                try: event = json.loads(line[6:])
                except (ValueError, UnicodeError): continue
                if event.get("type") == "response.output_item.done": output_items.append(event["item"])
                if event.get("type") == "response.completed": completed = event.get("response")
                if event.get("type") in ("response.failed", "error"):
                    failure_code = event.get("code") or event.get("response", {}).get("error", {}).get("code")
                    print(json.dumps({"error": "model_execution_failed", "provider_error_code": failure_code})); return
            if not completed: raise ValueError("incomplete")
            output = completed.get("output") or output_items
            if any(item.get("type") not in ("reasoning", "message") for item in output): raise ValueError("unexpected tool")
            text = "".join(content.get("text", "") for item in output if item.get("type") == "message"
                           for content in item.get("content", []) if content.get("type") == "output_text")
            print(json.dumps({"value": json.loads(text), "model": payload["model"], "usage": completed.get("usage")}))
    except requests.Timeout:
        print(json.dumps({"error": "model_timeout"}))
    except requests.RequestException:
        print(json.dumps({"error": "model_network"}))
    except Exception as error:
        print(json.dumps({"error": "model_execution_failed", "exception_type": type(error).__name__}))


if __name__ == '__main__': main()
