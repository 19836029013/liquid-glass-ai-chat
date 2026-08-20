import pathlib
import re

base = pathlib.Path(r"C:\Users\CHJ19\Documents\ChatGPT\dsAPP\liquid-glass-ai-chat-android\app\src\main\assets")
js = (base / "app.js").read_text(encoding="utf-8")
html = (base / "index.html").read_text(encoding="utf-8")

html_ids = set(re.findall(r'id="([^"]+)"', html))
refs = set(re.findall(r"\$\('#([A-Za-z0-9_-]+)'\)", js))
refs |= set(re.findall(r'\$\("#([A-Za-z0-9_-]+)"\)', js))
refs |= set(re.findall(r"getElementById\('([A-Za-z0-9_-]+)'\)", js))
missing_ids = sorted(refs - html_ids)
print("referenced ids:", len(refs))
print("MISSING ids:", missing_ids if missing_ids else "none")

html_classes = set()
for m in re.findall(r'class="([^"]+)"', html):
    html_classes.update(m.split())
class_refs = set(re.findall(r"querySelectorAll\('\.([A-Za-z0-9_-]+)'\)", js))
class_refs |= set(re.findall(r'querySelectorAll\("\.([A-Za-z0-9_-]+)"\)', js))
missing_classes = sorted(c for c in class_refs if c not in html_classes)
print("class selectors:", class_refs)
print("MISSING classes:", missing_classes if missing_classes else "none")
