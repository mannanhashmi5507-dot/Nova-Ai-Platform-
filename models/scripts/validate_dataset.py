import json
import sys

VALID_ROLES = {"system", "user", "assistant"}

def validate(path: str):
    rows = 0
    with open(path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            obj = json.loads(line)
            messages = obj.get("messages")
            if not isinstance(messages, list) or not messages:
                raise ValueError(f"line {line_no}: messages must be a non-empty list")
            roles = []
            for msg in messages:
                if not isinstance(msg, dict):
                    raise ValueError(f"line {line_no}: message must be an object")
                role = msg.get("role")
                if role not in VALID_ROLES:
                    raise ValueError(f"line {line_no}: invalid role {role!r}")
                if not isinstance(msg.get("content"), str) or not msg["content"].strip():
                    raise ValueError(f"line {line_no}: content must be non-empty text")
                roles.append(role)
            if "user" not in roles or "assistant" not in roles:
                raise ValueError(f"line {line_no}: each example needs user and assistant turns")
            rows += 1
    print(f"validated {rows} examples")
    return rows

if __name__ == "__main__":
    validate(sys.argv[1] if len(sys.argv) > 1 else "data/seed.jsonl")
