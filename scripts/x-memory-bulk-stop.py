#!/usr/bin/env python3
"""Gracefully stop only the bounded X bulk Node process inside its container."""
from pathlib import Path
import os
import signal
for path in Path('/proc').glob('[0-9]*/cmdline'):
    try:
        args = path.read_bytes().split(b'\0')
        if b'/profile/scripts/x-memory-bulk-backfill.mjs' in args and args[0].endswith(b'node'):
            os.kill(int(path.parent.name), signal.SIGTERM)
            print('stop_requested', path.parent.name)
    except (FileNotFoundError, ProcessLookupError):
        pass
