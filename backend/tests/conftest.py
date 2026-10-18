import os
import tempfile

# Every test session gets a fresh database unless DATABASE_URL points somewhere explicit (e.g. Postgres in CI).
os.environ.setdefault("DATABASE_URL", f"sqlite:///{tempfile.mkdtemp()}/test.db")
os.environ.setdefault("ADMIN_TOKEN", "secret")
