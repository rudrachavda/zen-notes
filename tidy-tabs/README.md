# Tidy Tabs for Zen

Arc's "Tidy Tabs" brought to Zen. A broom sits next to **Clear** on the divider
above your unpinned tabs. Click it (or press **⌘⌥T**) and your tabs get sorted
into a few topics, each under a small grey header such as Cooking, Shopping or
Other.

- While it's working, the divider turns into a moving wavy line.
- New tabs stay loose at the top. Tidy again and they join an existing group, or
  start a new one. A link opened from a grouped tab stays in that tab's group.
- A tab belongs to the header above it, so you can drag a tab under another
  header to move it to that group.
- Double-click a header to rename it. Hover a header for **×**, which closes every
  tab in that group. Right-click a header to **Rename**, **Ungroup**, or **Close
  Tabs in Group**.
- Right-click the broom for **Undo Tidy**, **Remove All Headers**, and **Set
  Claude API Key…**.
- Groups are saved with your session, so they're still there after a restart.
- Only unpinned tabs in the current space are touched. Pinned tabs, folders and
  Essentials are left alone.

## Install

Quit Zen, then run:

```sh
./tidy-tabs/install.sh
```

This uses the same script loader as the Zen Notes Library tab. If that isn't set
up yet, the installer runs `zen-mod/install.sh` first. The repair app that comes
with it puts Tidy Tabs back after Zen updates.

The first time you click the broom, it asks for a Claude API key (from
[console.anthropic.com](https://console.anthropic.com)). The key is stored in
Zen's preferences on your Mac. If you leave it empty, tabs are grouped by website
instead.

To remove it, run `./tidy-tabs/install.sh --uninstall`.

## What gets sent

Only the tab titles and addresses (domain and path, with no query strings) of the
tabs being sorted. They go to Claude (`claude-haiku-5-5` by default), or to Ollama
on your Mac if you choose that. Page contents are never sent.

## Settings

These are in `about:config` (or in the Sine settings, if you install it with Sine):

| Preference | Default | What it does |
| --- | --- | --- |
| `zen.tidy-tabs.provider` | `claude` | `claude`, `ollama`, or `site` (no AI: group by website) |
| `zen.tidy-tabs.claude-api-key` | empty | Your Claude API key |
| `zen.tidy-tabs.claude-model` | `claude-haiku-5-5` | Any Claude model id |
| `zen.tidy-tabs.ollama-endpoint` | `http://localhost:11434` | Where Ollama runs |
| `zen.tidy-tabs.ollama-model` | `llama3.1` | Ollama model to use |
| `zen.tidy-tabs.min-tabs` | `4` | Show the broom once a space has this many unpinned tabs |
| `zen.tidy-tabs.shortcut` | `true` | ⌘⌥T tidies the current space |
| `zen.tidy-tabs.timeout-seconds` | `45` | Give up waiting after this long |

## Your own broom icon

The broom is drawn for this mod. To use a different icon, put it at
`<your Zen profile>/chrome/resources/zen-tidy-tabs/broom.svg` (or `broom.png`) and restart Zen. The installer creates that folder.
For the icon to follow the sidebar's colour, use `stroke="context-fill"` or
`fill="context-fill"` in the SVG.

## Development

The grouping logic (cleaning up the model's answer, grouping by site, keeping
each group in one block) has no browser dependencies and is tested in node:

```sh
node --test tidy-tabs/test/core.test.mjs
```
