#!/usr/bin/env python3
"""Tool-free structured inference for the X runtime, through the Codex CLI.

Reads {instructions, input, schema, model?, effort?} as JSON on stdin and prints
{"value": ..., "model": ..., "usage": ...} or {"error": "<code>"}.

Each call is an ephemeral `codex exec` with tools disabled. Authentication is the
Codex CLI's own ChatGPT login (CODEX_HOME); no token is read, copied, or logged here.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

DISABLED_FEATURES = [
    "shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "memories", "hooks",
    "multi_agent", "multi_agent_v2", "browser_use", "browser_use_external", "computer_use",
    "image_generation", "chronicle", "goals", "code_mode",
]
ENV_ALLOW = re.compile(r"^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LC_.*|TMPDIR|CODEX_HOME)$")
TIMEOUT_SECONDS = 200


def classify(diagnostic):
    if re.search(r"context window|too many tokens|maximum context", diagnostic, re.I):
        return "model_input_too_large"
    if re.search(r"usage limit|rate.limit|quota|credit|usage.*reset|429", diagnostic, re.I):
        return "model_usage_limit"
    if re.search(r"unauthorized|authentication|token.*expired|401|403", diagnostic, re.I):
        return "model_authentication"
    if re.search(r"certificate|connection|network|stream.*closed|timed out|502|503|504", diagnostic, re.I):
        return "model_network"
    return "model_execution_failed"


def run(doc):
    model = doc.get("model", "gpt-6.1-sol")
    effort = doc.get("effort", "medium")
    work = tempfile.mkdtemp(prefix="x-codex-model-")
    try:
        instructions = os.path.join(work, "instructions.md")
        schema = os.path.join(work, "schema.json")
        answer = os.path.join(work, "answer.json")
        with open(instructions, "w", encoding="utf-8") as handle:
            handle.write(doc["instructions"])
        with open(schema, "w", encoding="utf-8") as handle:
            json.dump(doc["schema"], handle)
        args = ["codex", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                "--sandbox", "read-only", "--skip-git-repo-check", "--cd", work,
                "--model", model, "--json", "--output-schema", schema,
                "--output-last-message", answer,
                "-c", "model_reasoning_effort=" + json.dumps(effort),
                "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"',
                "-c", "model_instructions_file=" + json.dumps(instructions)]
        for feature in DISABLED_FEATURES:
            args += ["--disable", feature]
        args.append("-")
        env = {key: value for key, value in os.environ.items() if ENV_ALLOW.match(key)}
        try:
            proc = subprocess.run(args, input=json.dumps(doc["input"], ensure_ascii=False),
                                  capture_output=True, text=True, env=env, timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            return {"error": "model_timeout"}
        except FileNotFoundError:
            return {"error": "model_process_unavailable"}
        if proc.returncode != 0:
            return {"error": classify((proc.stderr or "")[-5000:] + (proc.stdout or "")[-5000:])}
        usage = None
        for line in proc.stdout.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            item = event.get("item")
            if item and item.get("type") not in ("reasoning", "agent_message"):
                return {"error": "model_execution_failed", "exception_type": "unexpected_tool"}
            if event.get("type") == "turn.completed":
                usage = event.get("usage")
        with open(answer, encoding="utf-8") as handle:
            value = json.load(handle)
        return {"value": value, "model": model, "usage": usage}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except Exception as error:
        print(json.dumps({"error": "model_execution_failed", "exception_type": type(error).__name__}))


if __name__ == "__main__":
    main()
