#!/usr/bin/env python3
"""Native messaging host for the Zen Notes extension.

Speaks Firefox's native messaging protocol (4-byte little-endian length
followed by UTF-8 JSON) over stdin/stdout and keeps notes as plain .md files
in a folder that Obsidian or any other editor can open.

Requests:  {"id": n, "cmd": "...", ...args}
Responses: {"id": n, "ok": true, "result": ...} or {"id": n, "ok": false, "error": "..."}
Events:    {"event": "changed", "notes": [...]}  (sent when files change on disk)
"""

import base64
import json
import logging
import logging.handlers
import mimetypes
import os
import re
import struct
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

CONFIG_DIR = Path.home() / "Library" / "Application Support" / "ZenNotes"
if sys.platform != "darwin":
    CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "zen-notes"
CONFIG_FILE = CONFIG_DIR / "config.json"
DEFAULT_FOLDER = Path.home() / "Zen Notes"  # outside Documents, which macOS blocks for the helper
ATTACHMENTS = "attachments"
WATCH_INTERVAL = 1.5

FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.S)
ID_KEY = "zen-id"

out_lock = threading.Lock()

CONFIG_DIR.mkdir(parents=True, exist_ok=True)
log = logging.getLogger("zen-notes")
_handler = logging.handlers.RotatingFileHandler(CONFIG_DIR / "helper.log", maxBytes=500_000, backupCount=1)
_handler.setFormatter(logging.Formatter("%(asctime)s [%(process)d] %(message)s"))
log.addHandler(_handler)
log.setLevel(logging.INFO)


# --- Protocol -----------------------------------------------------------------

def send(msg):
    data = json.dumps(msg).encode("utf-8")
    with out_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def receive():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


# --- Config -------------------------------------------------------------------

def load_config():
    try:
        return json.loads(CONFIG_FILE.read_text())
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))


def notes_folder():
    folder = Path(os.path.expanduser(load_config().get("folder", str(DEFAULT_FOLDER))))
    folder.mkdir(parents=True, exist_ok=True)
    return folder


# --- Files --------------------------------------------------------------------

def split_frontmatter(text):
    """Return (frontmatter lines, body). Frontmatter lines exclude the --- fences."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return [], text
    return m.group(1).splitlines(), text[m.end():]


def fm_get(lines, key):
    for line in lines:
        k, sep, v = line.partition(":")
        if sep and k.strip() == key:
            return v.strip().strip("'\"")
    return None


def join_frontmatter(lines, body):
    if not lines:
        return body
    return "---\n" + "\n".join(lines) + "\n---\n" + body


def safe_title(title):
    title = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", (title or "").strip())
    title = title.strip(". ")[:120].strip()
    return title or "Untitled"


def unique_path(folder, title, current=None):
    base = safe_title(title)
    candidate = folder / f"{base}.md"
    n = 2
    while candidate.exists() and candidate != current:
        candidate = folder / f"{base} {n}.md"
        n += 1
    return candidate


def walk_error(err):
    # os.walk skips folders it can't read; on macOS that usually means Zen
    # hasn't been allowed into Documents/Desktop/iCloud Drive, so say so.
    raise PermissionError(
        f"Can't read {err.filename}. Allow Zen in System Settings > Privacy & Security > "
        "Files and Folders (or Full Disk Access), then try again."
    ) from err


def iter_md_files(root):
    for dirpath, dirnames, filenames in os.walk(root, onerror=walk_error):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != ATTACHMENTS]
        for name in filenames:
            if name.endswith(".md") and not name.startswith("."):
                yield Path(dirpath) / name


class Index:
    """Maps note ids to files. A note's id is its zen-id frontmatter value, or
    "path:<relative path>" for files the extension has never saved."""

    def __init__(self):
        self.cache = {}  # path -> (mtime, id)
        self.known = {}  # id -> path for notes this helper created or saved
        self.previews = {}  # path -> first lines of the note, for the library
        self.lock = threading.Lock()

    def remember(self, note_id, path):
        self.known[note_id] = path

    def scan(self):
        root = notes_folder()
        seen = {}
        with self.lock:
            for path in iter_md_files(root):
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                cached = self.cache.get(path)
                if cached and cached[0] == mtime:
                    note_id = cached[1]
                else:
                    try:
                        head = path.read_text(encoding="utf-8", errors="replace")[:4096]
                    except OSError:
                        continue
                    lines, body = split_frontmatter(head)
                    note_id = fm_get(lines, ID_KEY) or "path:" + str(path.relative_to(root))
                    self.previews[path] = make_preview(body)
                seen[path] = (mtime, note_id)
            self.cache = seen
        return root, seen

    def find(self, note_id):
        known = self.known.get(note_id)
        if known and known.exists():
            return known
        for _ in range(2):
            root, entries = self.scan()
            for path, (_, nid) in entries.items():
                if nid == note_id:
                    return path
            if note_id.startswith("path:"):
                path = root / note_id[5:]
                if path.exists():
                    return path
        log.info("not found %s; known=%s; files=%s", note_id, self.known,
                 {str(p): nid for p, (_, nid) in self.cache.items()})
        raise KeyError(f"Note not found: {note_id}")


index = Index()
own_writes = {}  # path -> mtime we last wrote, so the watcher ignores our own saves


def make_preview(body, limit=200):
    """Plain-text start of a note: markdown symbols, images and links stripped."""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", body)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)", "", text, flags=re.M)
    text = re.sub(r"[*_`~]", "", text)
    text = " ".join(text.split())
    return text[:limit]


def note_summary(root, path, mtime, note_id):
    return {
        "id": note_id,
        "title": path.stem,
        "folder": str(path.parent.relative_to(root)) if path.parent != root else "",
        "mtime": mtime,
        "preview": index.previews.get(path, ""),
    }


# --- Commands -----------------------------------------------------------------

HELPER_VERSION = 3  # the extension asks for at least this; bump with protocol changes


def cmd_config(_):
    return {"folder": str(notes_folder()), "version": HELPER_VERSION}


def cmd_set_folder(msg):
    folder = Path(os.path.expanduser(msg["folder"]))
    folder.mkdir(parents=True, exist_ok=True)
    cfg = load_config()
    cfg["folder"] = str(folder)
    save_config(cfg)
    return {"folder": str(folder)}


def cmd_list(_):
    root, entries = index.scan()
    notes = [note_summary(root, p, m, i) for p, (m, i) in entries.items()]
    notes.sort(key=lambda n: n["mtime"], reverse=True)
    return notes


def cmd_read(msg):
    path = index.find(msg["noteId"])
    text = path.read_text(encoding="utf-8")
    lines, body = split_frontmatter(text)
    return {
        "id": fm_get(lines, ID_KEY) or msg["noteId"],
        "title": path.stem,
        "body": body,
        "mtime": path.stat().st_mtime,
        "path": str(path),
    }


def cmd_create(msg):
    root = notes_folder()
    path = unique_path(root, msg.get("title") or "Untitled")
    note_id = uuid.uuid4().hex[:12]
    lines = [f"{ID_KEY}: {note_id}", f"created: {datetime.now().isoformat(timespec='seconds')}"]
    if msg.get("source"):
        lines.append(f"source: {msg['source']}")
    path.write_text(join_frontmatter(lines, msg.get("body", "")), encoding="utf-8")
    own_writes[path] = path.stat().st_mtime
    index.remember(note_id, path)
    return {"id": note_id, "title": path.stem, "path": str(path)}


def cmd_write(msg):
    path = index.find(msg["noteId"])
    lines, _ = split_frontmatter(path.read_text(encoding="utf-8"))
    note_id = fm_get(lines, ID_KEY)
    if not note_id:
        # First save from the extension: give the file a stable id so the tab
        # still finds it after a rename. Other frontmatter is kept as is.
        note_id = uuid.uuid4().hex[:12]
        lines = [f"{ID_KEY}: {note_id}"] + lines

    target = path
    if "title" in msg and safe_title(msg["title"]) != path.stem:
        target = unique_path(path.parent, msg["title"], current=path)

    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(join_frontmatter(lines, msg["body"]), encoding="utf-8")
    os.replace(tmp, target)
    if target != path:
        path.unlink(missing_ok=True)
    mtime = target.stat().st_mtime
    own_writes[target] = mtime
    index.remember(note_id, target)
    return {"id": note_id, "title": target.stem, "mtime": mtime, "path": str(target)}


def cmd_delete(msg):
    path = index.find(msg["noteId"])
    trash = Path.home() / ".Trash"
    if sys.platform == "darwin" and trash.is_dir():
        dest = trash / path.name
        n = 2
        while dest.exists():
            dest = trash / f"{path.stem} {n}{path.suffix}"
            n += 1
        os.replace(path, dest)
    else:
        path.unlink()
    return True


def cmd_save_attachment(msg):
    note_dir = index.find(msg["noteId"]).parent
    folder = note_dir / ATTACHMENTS
    folder.mkdir(exist_ok=True)
    name = safe_title(Path(msg.get("name") or "image.png").stem)
    ext = Path(msg.get("name") or "").suffix or mimetypes.guess_extension(msg.get("mime", "")) or ".png"
    dest = folder / f"{name}{ext}"
    n = 2
    while dest.exists():
        dest = folder / f"{name} {n}{ext}"
        n += 1
    dest.write_bytes(base64.b64decode(msg["data"]))
    return {"src": f"{ATTACHMENTS}/{dest.name}"}


# Firefox drops messages over 1 MB from the helper, so attachments are read in chunks.
ATTACHMENT_CHUNK = 512 * 1024


def cmd_read_attachment(msg):
    note_dir = index.find(msg["noteId"]).parent
    path = (note_dir / msg["src"]).resolve()
    root = notes_folder().resolve()
    if root not in path.parents:
        raise PermissionError("Attachment is outside the notes folder")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    offset = int(msg.get("offset", 0))
    with path.open("rb") as f:
        f.seek(offset)
        chunk = f.read(ATTACHMENT_CHUNK)
    return {"mime": mime, "size": path.stat().st_size, "offset": offset,
            "data": base64.b64encode(chunk).decode()}


def cmd_reveal(msg):
    path = index.find(msg["noteId"]) if msg.get("noteId") else notes_folder()
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)] if path.is_file() else ["open", str(path)])
    return True


COMMANDS = {
    "config": cmd_config,
    "setFolder": cmd_set_folder,
    "list": cmd_list,
    "read": cmd_read,
    "create": cmd_create,
    "write": cmd_write,
    "delete": cmd_delete,
    "saveAttachment": cmd_save_attachment,
    "readAttachment": cmd_read_attachment,
    "reveal": cmd_reveal,
}


# --- Watcher ------------------------------------------------------------------

def watch():
    """Polls the notes folder and reports files changed by other apps."""
    _, previous = index.scan()
    while True:
        time.sleep(WATCH_INTERVAL)
        try:
            root, current = index.scan()
        except OSError:  # includes folder permission errors; requests report those
            continue
        changed = []
        for path, (mtime, nid) in current.items():
            old = previous.get(path)
            if old and old[0] == mtime:
                continue
            if own_writes.get(path) == mtime:
                continue
            changed.append(note_summary(root, path, mtime, nid))
        live_ids = {nid for _, nid in current.values()}
        removed = [nid for _, nid in previous.values() if nid not in live_ids]
        if changed or removed:
            send({"event": "changed", "notes": changed, "removed": removed})
        previous = current


def main():
    log.info("start python=%s folder=%s", sys.version.split()[0], notes_folder())
    threading.Thread(target=watch, daemon=True).start()
    while True:
        msg = receive()
        if msg is None:
            log.info("stdin closed, exiting")
            break
        handler = COMMANDS.get(msg.get("cmd"))
        log.info("%s %s", msg.get("cmd"), msg.get("noteId", ""))
        try:
            if not handler:
                raise ValueError(f"Unknown command: {msg.get('cmd')}")
            send({"id": msg.get("id"), "ok": True, "result": handler(msg)})
        except Exception as e:  # report every failure back to the extension
            log.info("error in %s: %s: %s", msg.get("cmd"), type(e).__name__, e)
            send({"id": msg.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
