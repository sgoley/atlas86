import os
from pathlib import Path

from dotenv import dotenv_values

ENV_FILE = Path.home() / ".atlas86.env"
VARS = ("ATLAS86_URL", "ATLAS86_USER", "ATLAS86_TOKEN", "ATLAS86_CLOUD")


def load_config():
    file_vals = dotenv_values(ENV_FILE) if ENV_FILE.exists() else {}

    def pick(var):
        v = os.environ.get(var)
        if v in (None, ""):
            v = file_vals.get(var)
        return v or ""

    return {
        "url": pick("ATLAS86_URL").strip().rstrip("/"),
        "user": pick("ATLAS86_USER"),
        "token": pick("ATLAS86_TOKEN"),
        "cloud": pick("ATLAS86_CLOUD").strip().lower() in ("1", "true", "yes", "on"),
    }


def configured(cfg):
    return bool(cfg.get("url") and cfg.get("token"))


def save_config(url, user, token, cloud):
    lines = (
        f"ATLAS86_URL={url}\n"
        f"ATLAS86_USER={user}\n"
        f"ATLAS86_TOKEN={token}\n"
        f"ATLAS86_CLOUD={'true' if cloud else 'false'}\n"
    )
    fd = os.open(ENV_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(lines)
    # O_CREAT mode only applies on creation; tighten an existing file too.
    os.chmod(ENV_FILE, 0o600)
