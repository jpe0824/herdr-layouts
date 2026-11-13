# herdr-layouts

Layouts for the [Herdr](https://herdr.dev) desktop app. Each folder is one layout, laid out
like a Herdr home (`layouts/`, `mods/`, `keys.json`), with a `RECIPE.md` brief and a
`preview.png`.

| Layout | What it is |
|---|---|
| [kanbandrawer](kanbandrawer/) | A kanban board of git worktrees in a bottom drawer, with live Claude sessions on each card, a Stage column for the issue, plan and PR, and Reviews / Projects panels. |

## Installing one

Ask your agent to add `herdr.dev/layouts/<owner>/kanbandrawer`, or by hand:

1. Copy `kanbandrawer/layouts/kanbandrawer.json` to `~/.config/herdr-app/layouts/` and each
   folder in `kanbandrawer/mods/` to `~/.config/herdr-app/mods/`. Rename on a name clash.
2. Merge `kanbandrawer/keys.json` into `~/.config/herdr-app/keys.json`.
3. Copy `kanbandrawer/support/bin/*` to `~/.claude/herdr/bin/`. Copy
   `support/config.example.json` to `~/.claude/herdr/config.json` and fill in your org.
   `seats.example.json` → `~/.claude/herdr/seats.json` is optional.
4. Add `~/.claude/herdr/bin/herdr-board hook` as a Claude Code `PostToolUse` hook.
5. `herdr-app do layout.switch '{"name":"kanbandrawer"}'`.

See [kanbandrawer/RECIPE.md](kanbandrawer/RECIPE.md) for the full description.
