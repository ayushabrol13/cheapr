"""Guards against shipping a model change without a migration (create_all would hide it in tests)."""
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext

from app.migrate import upgrade
from app.models import Base, engine


def test_models_match_migrations():
    upgrade()
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    assert diff == [], f"models differ from migrations; run: python -m app.migrate revision 'msg' -> {diff}"
