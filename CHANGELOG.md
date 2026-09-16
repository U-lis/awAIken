# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Low-battery suspend** (20 % by default): while the toggle is on and the
  battery is discharging, dropping below the threshold turns the toggle off
  and suspends via `org.freedesktop.login1.Manager.Suspend`, instead of
  running until the battery dies. The threshold is a slider in the
  preferences window that snaps to 0 / 5 / 10 / 15 / 20 / 30 / 50 %; `0`
  disables it. Stored in the new `low-battery-threshold` key.

### Changed

- The menu item **단축키 설정…** is now **설정…**, since the preferences
  window holds more than the shortcut.

### Removed

- **Restore on login** option and its `restore-state` key. The toggle now
  always starts off after login; a toggle left on and forgotten no longer
  carries over. A gnome-shell crash still keeps the toggle on, since the
  inhibitor unit survives it.
- **Keep screen on** option and its `keep-screen-on` key. The screen now
  turns off when the lid closes, and follows GNOME's own
  `idle-delay` while it is open; the extension no longer overwrites
  `idle-delay`. A backup taken before this change still restores it.
- **Blank on lid close** option and its `blank-on-lid-close` key. Closing the
  lid while the toggle is on now always turns the screen off (and locks it if
  **Lock on lid close** is on), as the default already did.

- Renamed the project from **wAIk-up** to **awAIken**, in the README and in
  every user-visible string: the extension name in the Extensions app, the
  panel button's accessible name, and the `--description` / `--who` fields the
  inhibitor unit shows in `systemd-inhibit --list`. The UUID
  (`lid-awake@ulismoon.local`), the GSettings schema id and the unit name stay
  `lid-awake` so existing installs keep their dconf state.

## [0.2.0] - 2026-09-09

### Added

- **Lock on lid close** option (on by default): the lid-close blank now goes
  through `org.gnome.ScreenSaver.Lock` instead of `SetActive(true)`, so
  reopening the lid asks for the password. `SetActive(true)` only draws the
  shield without setting the locked flag, which left the previous session
  visible on reopen. The lid-open `SetActive(false)` call is skipped while
  locked — it would open the session without authentication.

## [0.1.0] - 2026-08-27

### Added

- Top bar toggle (sun/moon icon) that blocks lid-close and idle suspend while
  enabled, and restores default power behaviour when disabled.
- Logind inhibitor lock (`handle-lid-switch:sleep:idle`, `--mode=block`) held
  by a transient systemd user unit (`lid-awake-inhibit.service`) so the lock
  survives a gnome-shell crash; the unit is the single source of truth for
  toggle state.
- Screen-blank on lid close via `org.gnome.ScreenSaver.SetActive` so the
  display turns off even though suspend is blocked (on by default).
- **Keep screen on** option that overrides the screen-blank and leaves the
  display on while the lid is closed.
- **Restore on login** option that re-enables the master toggle automatically
  after the next login (off by default).
- Runtime dependency probing for systemd (`systemd-run`, `systemctl`,
  `systemd-inhibit`) and UPower on extension load; affected controls are
  disabled with an explanatory status line when dependencies are missing.
- `Super+Shift+L` keyboard shortcut for the master toggle; reads the actual
  unit state rather than the stored setting so it stays correct even if the
  unit was stopped from the command line; an OSD notification reports the
  resulting state.
- Preferences window (reachable from the menu item or the Extensions app) to
  rebind the shortcut, with conflict detection against window manager, shell,
  mutter, gsd-media-keys, and user-defined keybindings; changes take effect
  immediately without re-login.
- `Backspace` in the shortcut capture dialog clears the current binding;
  `Esc` cancels without making a change.
