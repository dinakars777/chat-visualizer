# Troubleshooting

ChatVisualizer runs locally on your Mac. Most issues are startup, permissions, or missing optional tools.

## The Launcher Will Not Open

If macOS blocks `Start ChatVisualizer.command`:

1. Control-click `Start ChatVisualizer.command`.
2. Choose **Open**.
3. Confirm that you want to open it.

If the file opens in a text editor instead of Terminal, open Terminal, drag `Start ChatVisualizer.command` into the Terminal window, then press Return.

If Terminal says `permission denied`, run this from the unzipped ChatVisualizer folder:

```sh
chmod +x "Start ChatVisualizer.command"
```

Then double-click `Start ChatVisualizer.command` again.

## Node.js Is Missing Or Too Old

ChatVisualizer requires Node.js 20 or newer.

1. Install the **LTS** version from https://nodejs.org/.
2. Quit and reopen Terminal.
3. Double-click `Start ChatVisualizer.command` again.

## The Browser Does Not Open

Open this address manually:

```text
http://127.0.0.1:4173
```

Leave the Terminal window open while using ChatVisualizer.

## Port 4173 Is Already In Use

If ChatVisualizer says it is already running, open:

```text
http://127.0.0.1:4173
```

If you want to stop the old copy, close the Terminal window that started it or press `Control-C` in that window.

## No Sessions Are Showing

Check that you have used at least one supported tool on this Mac:

- Codex
- Claude Code
- Cursor
- Grok Build
- Antigravity

Some tools store history only after a real coding session. If you just installed a tool, run a small session first, then click **Refresh** in ChatVisualizer.

## Cursor Or Antigravity History Is Missing

Cursor and Antigravity indexing needs `sqlite3`. Many Macs already include it.

Check in Terminal:

```sh
sqlite3 --version
```

If it is missing, install Apple's command line tools:

```sh
xcode-select --install
```

Then restart ChatVisualizer.

## Deep Search Is Limited

Deep search works best with `ripgrep`.

Check in Terminal:

```sh
rg --version
```

If it is missing, install it with Homebrew:

```sh
brew install ripgrep
```

Normal browsing still works without ripgrep.

## Export Did Not Download

Try these steps:

1. Open a session first.
2. Click **Export**.
3. Choose **Markdown** or **JSON**.
4. Check your browser's Downloads folder.

Large sessions may take a moment because ChatVisualizer exports the complete transcript, not only the visible chunk.

## Privacy Flags Look Wrong

Privacy flags are local and approximate. They are meant to highlight possible secrets, tokens, credentials, or private values so you can inspect them yourself.

ChatVisualizer does not upload transcript content or call an AI service.

## Ask An AI Coding Assistant For Help

If you use Codex, Claude Code, Antigravity, Cursor, Grok Build, or another coding assistant, open the unzipped ChatVisualizer folder and ask:

```text
Help me install and run this local app. Check that Node.js 20 or newer is installed, run npm install if needed, then start ChatVisualizer. Do not upload, paste, or share any transcript files.
```
