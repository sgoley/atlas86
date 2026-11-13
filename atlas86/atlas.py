from atlassian import Confluence, Jira


class AtlasClient:
    """Thin wrapper over atlassian.Jira + .Confluence."""

    def __init__(self, cfg):
        auth = dict(url=cfg["url"], username=cfg.get("user") or "",
                    password=cfg["token"], cloud=bool(cfg.get("cloud")))
        self._cloud = bool(cfg.get("cloud"))
        self._fnames = None
        self.jira = Jira(**auth)
        self.conf = Confluence(**auth)

    def field_names(self):
        if self._fnames is None:
            ver = "3" if self._cloud else "2"
            res = self.jira.get(f"rest/api/{ver}/field") or []
            self._fnames = {f["id"]: f.get("name", "") for f in res}
        return self._fnames
