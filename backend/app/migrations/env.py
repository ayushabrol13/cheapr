from alembic import context

from app.models import Base, engine

target_metadata = Base.metadata


def run() -> None:
    with engine.connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, render_as_batch=True)  # batch: SQLite ALTERs
        with context.begin_transaction():
            context.run_migrations()


run()
