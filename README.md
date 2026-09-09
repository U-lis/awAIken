# awAIken

![GNOME Shell 50](https://img.shields.io/badge/GNOME%20Shell-50-4A86CF)
![License: MIT](https://img.shields.io/badge/License-MIT-green)
![Version: 0.2.0](https://img.shields.io/badge/version-0.2.0-blue)

Keep your laptop awake while AI agents are working.

A GNOME Shell extension that adds a top bar toggle to block suspend. Built for
the case where you kick off a long-running agent task, close the lid to move,
and don't want the machine to suspend and kill the job halfway.

When enabled, closing the lid turns the screen off but keeps the system running.
Turn it back off and the system returns to its normal power behaviour.

## Install

```sh
git clone https://github.com/U-lis/awAIken.git \
    ~/.local/share/gnome-shell/extensions/lid-awake@ulismoon.local
glib-compile-schemas \
    ~/.local/share/gnome-shell/extensions/lid-awake@ulismoon.local/schemas/
gnome-extensions enable lid-awake@ulismoon.local
```

The `glib-compile-schemas` step is required — the compiled schema is not
committed, and the extension fails to load without it. On Wayland you have to
log out and back in for the shell to pick up the extension.

## Compatibility

| GNOME Shell | Status |
| --- | --- |
| 50 | Supported — developed and running on 50.1 (Ubuntu 26.04, Wayland) |
| 45–49 | Untested. Likely to work; bump `shell-version` in `metadata.json` to try |
| <= 44 | Not supported — predates ESM extensions and the `Extension` class |

Only 50 is declared in `metadata.json`, because that is the only version
actually tested. Other versions are on the list to check in a VM.

The extension only touches four Shell APIs (`PanelMenu.Button`, the
`PopupMenu` item classes, `Main.panel.addToStatusArea()` and
`Extension.getSettings()`), none of which changed between 45 and 50. Everything
else it uses is GIO/GLib, UPower and `org.gnome.ScreenSaver` over D-Bus.

## Requirements

- **GNOME Shell 50** (see above).
- **systemd**, for `systemd-run`, `systemctl --user` and `systemd-inhibit`.
  Distributions without it (runit, OpenRC, s6) cannot hold the lock at all.
- **UPower**, for lid state. Without it the screen-off feature is unavailable;
  suspend blocking still works.

There is no way to declare these in `metadata.json` — GNOME only checks
`shell-version` — so the extension checks them itself on load and reports what
is missing in its menu, disabling the switches it cannot honour.

Note that suspend blocking rests on the logind inhibitor, not on the gsd-power
keys. Those keys are overwritten as a second line of defence and are reported
upstream to be a no-op on some versions.

## Usage

Click the sun icon in the top bar:

| Menu item | What it does |
| --- | --- |
| **깨어 있기** (Stay awake) | Master toggle. Blocks lid-close and idle suspend. |
| **덮으면 화면 끄기** (Blank on lid close) | Turns the screen off when the lid closes, without suspending. On by default. |
| **화면도 끄지 않기** (Keep screen on) | Never blanks the screen. Overrides the option above. |
| **덮으면 잠그기** (Lock on lid close) | Locks the session as it blanks, so reopening the lid asks for the password. On by default. Turn it off to get the old behaviour, where reopening returns straight to the desktop. |
| **로그인 시 상태 유지** (Restore on login) | Re-enables the toggle after login. Off by default. |
| **단축키 설정…** (Shortcut settings) | Opens the preferences window described below. |

### Keyboard shortcut

The master toggle is also bound to a keyboard shortcut, `Super+Shift+L` by
default. The shortcut flips the *actual* inhibitor unit state, not the stored
setting, so it stays correct even if the unit was stopped from the command
line. An OSD shows the resulting state.

To change it, open **단축키 설정…** from the menu (or the gear icon in the
Extensions app), click the row, and press the new combination. `Backspace`
clears the shortcut, `Esc` cancels. The row warns if the combination is already
taken by the window manager, the shell, mutter, gsd-media-keys, or a user-defined
shortcut.

Changing the shortcut takes effect immediately — no re-login. It can also be
set without the GUI:

```sh
gsettings set org.gnome.shell.extensions.lid-awake toggle-shortcut "['<Super><Shift>k']"
```

## How it works

Two independent things have to be handled, and the extension does both while
the toggle is on:

- **Suspend.** A logind inhibitor lock for `handle-lid-switch:sleep:idle` is
  held in `--mode=block`, and gsd-power's `lid-close-*-action` /
  `sleep-inactive-*-type` keys are overwritten with `nothing`. The original
  values are backed up and restored when the toggle goes off.
- **Screen.** The inhibitor does not turn the panel off, and with no external
  monitor attached mutter leaves the built-in panel on. So the extension
  watches UPower's `LidIsClosed` and activates the screen saver directly when
  the lid closes.

Two design notes worth knowing:

- The inhibitor is held by a transient systemd user unit
  (`lid-awake-inhibit.service`), not by the shell process. If gnome-shell
  crashes, the lock survives and your job keeps running. That unit is the
  single source of truth for the toggle state.
- Editing `/etc/systemd/logind.conf.d/` would be the obvious alternative, but
  it needs root and logind has no `ExecReload`, so applying it means a reboot.
  An inhibitor lock needs no privileges and is reverted instantly.

## Similar extensions

Nosleep and Lid Helper take the same approach. Caffeine only uses
`org.gnome.SessionManager.Inhibit` flags 4/8, which do not cover the lid switch.

## License

MIT
