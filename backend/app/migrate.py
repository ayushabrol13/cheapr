"""Schema migrations (Alembic). `python -m app.migrate` upgrades; `python -m app.migrate revision "msg"` autogenerates."""
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config


def config() -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    return cfg


def upgrade() -> None:
    command.upgrade(config(), "head")


if __name__ == "__main__":
    if sys.argv[1:2] == ["revision"]:
        command.revision(config(), message=sys.argv[2], autogenerate=True)
    else:
        upgrade()
