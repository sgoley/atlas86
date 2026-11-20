import threading
import time

from atlassian import Confluence, Jira


class Cache:
    """Tiny in-process TTL cache. Single-user local app: clear() on writes."""

    def __init__(self):
        self._d = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            hit = self._d.get(key)
            if hit and hit[0] > time.monotonic():
                return hit[1]
            self._d.pop(key, None)
            return None

    def set(self, key, value, ttl=60):
        with self._lock:
            self._d[key] = (time.monotonic() + ttl, value)

    def clear(self):
        with self._lock:
            self._d.clear()


class AtlasClient:
    """Thin wrapper over atlassian.Jira + .Confluence."""

    def __init__(self, cfg):
        auth = dict(url=cfg["url"], username=cfg.get("user") or "",
                    password=cfg["token"], cloud=bool(cfg.get("cloud")))
        self._cloud = bool(cfg.get("cloud"))
        self._fnames = None
        self.cache = Cache()
        self.jira = Jira(**auth)
        self.conf = Confluence(**auth)

    def field_names(self):
        if self._fnames is None:
            ver = "3" if self._cloud else "2"
            res = self.jira.get(f"rest/api/{ver}/field") or []
            self._fnames = {f["id"]: f.get("name", "") for f in res}
        return self._fnames
