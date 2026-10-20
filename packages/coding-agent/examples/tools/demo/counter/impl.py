"""Persistent worker: reads one JSON request per line, writes one JSON response per line."""

import json
import sys

counts: dict[str, int] = {}

for line in sys.stdin:
    request = json.loads(line)
    try:
        label = request["input"]["label"]
        counts[label] = counts.get(label, 0) + 1
        response = {"id": request["id"], "result": f"{label} = {counts[label]}"}
    except Exception as error:  # report per-call errors instead of exiting
        response = {"id": request["id"], "error": str(error)}
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
