from atlassian import Confluence, Jira


class AtlasClient:
    """Thin wrapper over atlassian.Jira + .Confluence."""

    def __init__(self, cfg):
        auth = dict(url=cfg["url"], username=cfg.get("user") or "",
                    password=cfg["token"], cloud=bool(cfg.get("cloud")))
        self.jira = Jira(**auth)
        self.conf = Confluence(**auth)
