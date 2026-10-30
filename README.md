# Zen Notes

Arc-style notes for Zen browser. Each note opens as its own tab with a clean
writing page, and is saved as a plain `.md` file in a folder on your Mac, so
Obsidian (or any editor) can open the same notes.

- **New note:** `⌘/` on any web page or note, or `⌘ Option N` anywhere (including
  the address bar and about: pages; change it in about:addons → gear icon →
  Manage Extension Shortcuts). Also the Zen Notes toolbar button, or right-click a
  page and pick "New note about this page" (the page URL is saved as `source:`).
- **Formatting:** select text (or click an empty line) and a toolbar appears on
  the left: H1, H2, H3, body text, bullet and numbered lists, BIU (bold, italic,
  underline, strikethrough, code), image, link. Markdown shortcuts like `## `,
  `- ` and `**bold**` work as you type. `⌘K` adds a link, `⌘S` saves now.
- **Images:** paste, drag in or use the image button. They're saved into an
  `attachments/` folder next to the note.
- **Share button** (bottom right): copy as Markdown, open in Obsidian, show in
  Finder, delete (moves the file to the Trash).
- **Pin it:** a note is a normal tab, so you can pin it or drop it in Essentials
  in Zen's sidebar like any other tab.
- Notes save as you type. If you edit a note in Obsidian while it's open in Zen,
  the tab picks up the change.

## How files look

`~/Zen Notes/My Note.md`:

```markdown
---
zen-id: 637944bc1137
created: 2026-10-30T04:46:09
---
Your note in plain markdown.
```

The filename is the note's title, and renaming the title renames the file.
`zen-id` lets the tab find the note again after a rename. Notes you create in
Obsidian show up too; they get a `zen-id` the first time you edit them in Zen.
Any other frontmatter you add is kept.

## Install (macOS)

You need `python3` (run `xcode-select --install` if `python3 -V` doesn't work).

1. **Install the helper.** It's the small script that reads and writes the files.

   ```bash
   cd helper
   ./install.sh                                   # notes go in ~/Zen Notes
   ./install.sh "$HOME/Notes/Zen"                 # or any folder outside Documents/Desktop/Downloads
   ```

   You can also change the folder later from the toolbar popup.

2. **Install the extension** (`zen-notes.xpi`). Pick one:
   - **Quick try:** open `about:debugging#/runtime/this-firefox`, click
     "Load Temporary Add-on…" and choose `extension/manifest.json`. It's removed
     when Zen restarts.
   - **Keep it installed:** sign it for free as a self-distributed add-on
     (nothing is published publicly). Create an API key at
     https://addons.mozilla.org/developers/addon/api/key/, then run
     `./scripts/sign.sh` and paste the issuer and secret when asked (the secret
     isn't shown or saved). Open the `.xpi` it puts in `signed/` from
     about:addons → gear icon → Install Add-on From File… Each new signing needs a
     higher `version` in `extension/manifest.json`.
   - Or, in `about:config`, set `xpinstall.signatures.required` to `false`
     (only works if your Zen build honours it) and open `zen-notes.xpi`.

3. Restart Zen after installing the helper the first time.

If a note tab shows "Is the Zen Notes helper installed?", check that
`~/Library/Application Support/zen/NativeMessagingHosts/zen_notes.json` exists
and that its `path` points at a script you can run.

## Develop

```bash
npm install
npm run dev        # builds extension/dist
npm run package    # minified build + zen-notes.xpi
```

- `helper/zen_notes_host.py`: native messaging host (Python, standard library only)
- `extension/background.js`: talks to the helper, opens note tabs, shortcut and menus
- `extension/src/note.js`: the editor page (Tiptap + tiptap-markdown)
- `extension/src/popup.js`: the toolbar popup with search and the notes list
