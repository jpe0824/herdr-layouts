# Herdr + Termchat

Herdr's default layout with [termchat](https://github.com/jpe0824/termchat) in the right
panel. A **termchat** button in the tab bar shows how many messages are unread and opens a
live termchat session beside your terminals. A new message plays Herdr's alert sound and
marks the termchat pane in the agents list, as an agent that finished does.

![Herdr + Termchat](preview.png)

## What you see

Herdr's shipped `main` layout, unchanged except for:

- **Tab bar** (`termchat-tabs`): after **Files** and **Changes**, a 1×16px divider and a
  **termchat** button (lucide `message-square`). When anything is unread, an `accent` badge
  shows the total across all conversations (`99+` above 99).
- **Right panel**: a third view, `termchat`, after `files` and `changes`. It shows the kept
  terminal named `termchat`, which runs the termchat interface.

## How it behaves

- **Unread count**: polled every 5 s from `termchat chats --json`. A conversation open in the
  panel's termchat counts as read once the interface marks it read, so the badge counts the
  other conversations.
- **Opening termchat**: the button starts the terminal when none is live
  (`hc run --bg --keep --no-notify --name termchat`), then shows the panel. The terminal is
  started from the app, so it has no parent agent and outlives any session.
- **Quitting termchat** (`ctrl+c`) leaves the terminal at "termchat closed. Press enter to
  open it again." Herdr closes a pane whose program exits and removes its block from the
  layout, so the terminal runs termchat in a loop. If the block is gone anyway, the button
  puts it back.
- **Panel widths**: each panel view keeps its own width. The width the panel has when you
  leave a view (another view, or the panel closed) is saved for that view in shared
  `panel.widths` and restored next time. termchat starts at half the window; the others at
  the layout's 368px.
- **Alerts**: termchat reports its status to Herdr (OSC 7501): `working`, then `done` a
  second later, for each message that notifies. Herdr plays its alert sound and marks the
  pane done in the agents list; it shows its corner note only when you are not looking at
  the pane, and posts no system notification. termchat's own `notify.os` setting covers
  system notifications. This needs a termchat build with jpe0824/termchat#15; older builds
  send OSC 99, which Herdr shows as an in-app notice at most.

## Installing

Needs `termchat` with an account (`termchat join`) and `hc` on the login shell's `PATH`.

1. Copy `layouts/termchat.json` to `~/.config/herdr-app/layouts/` and each folder in `mods/`
   to `~/.config/herdr-app/mods/`. Rename on a name clash.
2. `herdr-app do layout.switch --name termchat`.

## Built from

Layout `layouts/termchat.json`: Herdr's `main` layout with these changes.

```
root
└─ work
   ├─ tabs: termchat-tabs (was tabs)
   └─ work-body
      └─ panel (column, 368px, hidden)
         └─ panel-body (stack): files · changes · termchat { "terminal": "termchat" }
```

Mods:

- `termchat-tabs`: Herdr's shipped `tabs`, plus `termchat.js` (button, unread polling,
  terminal and block upkeep) and `panelwidth.js` (per-view widths).

## Watch out

- **A program exiting deletes its block.** Herdr closes a pane whose program exits and
  removes that block from the layout, panel blocks included. Run termchat in a loop in the
  terminal, and re-add the block (`layout.set`) when it is missing.
- **Start the terminal from the app, not from an agent's terminal.** `hc run` inside an agent's
  terminal records that agent as the parent; the new terminal then dies with it
  (`die_with_parent`) and sends it notes. The mod's `exec("hc", ...)` has no parent.
- **Blocks resolve terminals by name.** `{ "terminal": "termchat" }` follows whichever live
  terminal holds that name, so a restarted terminal shows in the same place.
- **Herdr reports focus in, never focus out on an app switch.** A termchat build without
  jpe0824/termchat#15 trusts that report, so after one click into the panel it marks its
  open conversation read while you are away, and that conversation never counts toward the
  badge. Builds with the fix ignore focus reports inside Herdr.
- **Polling starts termchat's background process.** `termchat chats` starts it when it is not
  running, every 5 s.
- **Herdr alerts come only from OSC 7501, and only on a change.** OSC 9, 99 and 777 make an
  in-app notice at most. `working` and `done` in one write leave a pane that is still `done`
  unchanged, so no sound; the second's gap fixes that.
- **Herdr skips its toast for the focused pane**, even with the window in the background, so
  a toast mod cannot turn every alert into a system notification.
