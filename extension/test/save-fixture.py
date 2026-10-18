# Converts a Playwright evaluate dump (JSON string) into a gzipped HTML fixture.
# usage: python3 save-fixture.py <dump.html> <name>
import gzip, json, pathlib, sys
src, name = sys.argv[1], sys.argv[2]
html = json.loads(pathlib.Path(src).read_text())
out = pathlib.Path(__file__).parent / "fixtures" / f"{name}.html.gz"
out.write_bytes(gzip.compress(html.encode(), 9))
print(out.name, len(html) // 1024, "KB ->", out.stat().st_size // 1024, "KB")
