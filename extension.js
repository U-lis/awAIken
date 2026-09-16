import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
const SESSION_SCHEMA = 'org.gnome.desktop.session';

// 활성 시 'nothing' 으로 덮어쓸 gsd-power 키
const POWER_KEYS = [
    'sleep-inactive-ac-type',
    'sleep-inactive-battery-type',
    'lid-close-ac-action',
    'lid-close-battery-action',
];

// logind 에 요청할 block inhibitor 종류
const INHIBIT_WHAT = 'handle-lid-switch:sleep:idle';

// inhibitor 를 들고 있는 transient systemd user unit.
// 셸 프로세스가 아니라 이 유닛이 락의 단일 진실 소스다.
const UNIT = 'lid-awake-inhibit.service';

// 없으면 락을 잡을 수 없는 실행 파일들
const REQUIRED_PROGRAMS = ['systemd-run', 'systemctl', 'systemd-inhibit'];

// 덮개 상태는 logind 가 아니라 UPower 가 프로퍼티로 노출한다.
const UPOWER = {
    name: 'org.freedesktop.UPower',
    path: '/org/freedesktop/UPower',
    iface: 'org.freedesktop.UPower',
};

// 화면만 끄는 통로. gnome-shell 50 부터 별도 프로세스가 이 이름을 잡는다.
const SCREENSAVER = {
    name: 'org.gnome.ScreenSaver',
    path: '/org/gnome/ScreenSaver',
    iface: 'org.gnome.ScreenSaver',
};

// 배터리는 개별 장치가 아니라 셸 배터리 아이콘과 같은 합산 장치에서 읽는다.
const BATTERY = {
    name: 'org.freedesktop.UPower',
    path: '/org/freedesktop/UPower/devices/DisplayDevice',
    iface: 'org.freedesktop.UPower.Device',
};

// org.freedesktop.UPower.Device 의 Type / State 열거값
const DEVICE_TYPE_BATTERY = 2;
const DEVICE_STATE_DISCHARGING = 2;

const LOGIN1 = {
    name: 'org.freedesktop.login1',
    path: '/org/freedesktop/login1',
    iface: 'org.freedesktop.login1.Manager',
};

// 이 비율(%) 미만으로 방전되면 강제 절전. 0 이면 끔.
const BATTERY_KEY = 'low-battery-threshold';

// 토글 단축키를 담은 설정 키. Main.wm.addKeybinding 이 키 이름으로 찾아간다.
const SHORTCUT_KEY = 'toggle-shortcut';

const ICON_ON = 'weather-clear-symbolic';
const ICON_OFF = 'weather-clear-night-symbolic';

const Indicator = GObject.registerClass(
class LidAwakeIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'awAIken');
        this._ext = ext;

        this._icon = new St.Icon({
            icon_name: ICON_OFF,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._toggle = new PopupMenu.PopupSwitchMenuItem('깨어 있기', false);
        this._toggle.connect('toggled', (_item, state) => ext.setActive(state));
        this.menu.addMenuItem(this._toggle);

        this._status = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            style_class: 'popup-inactive-menu-item',
        });
        this.menu.addMenuItem(this._status);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._lockItem = new PopupMenu.PopupSwitchMenuItem(
            '덮으면 잠그기', ext.settings.get_boolean('lock-on-lid-close'));
        this._lockItem.connect('toggled', (_item, state) =>
            ext.settings.set_boolean('lock-on-lid-close', state));
        this.menu.addMenuItem(this._lockItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('설정…');
        settingsItem.connect('activate', () => ext.openPreferences());
        this.menu.addMenuItem(settingsItem);

        const prefsItem = new PopupMenu.PopupMenuItem('시스템 전원 설정…');
        prefsItem.connect('activate', () => {
            Gio.Subprocess.new(
                ['gnome-control-center', 'power'], Gio.SubprocessFlags.NONE);
        });
        this.menu.addMenuItem(prefsItem);

        // CLI(systemctl --user stop …)로 밖에서 유닛을 껐을 수도 있으므로
        // 메뉴를 열 때마다 실제 유닛 상태를 다시 읽는다.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                ext.refresh();
        });
    }

    sync(active, detail, deps) {
        // 못 하는 일은 스위치를 잠가 둔다. 눌러도 안 되는 토글보다
        // 왜 안 되는지 상태줄에 적힌 편이 낫다.
        this._toggle.setSensitive(deps.systemd);
        this._lockItem.setSensitive(deps.upower);

        this._icon.icon_name = active ? ICON_ON : ICON_OFF;
        // 활성 시 강조
        if (active)
            this._icon.add_style_class_name('lid-awake-active');
        else
            this._icon.remove_style_class_name('lid-awake-active');
        this._toggle.setToggleState(active);
        this._status.label.text = detail;
    }
});

export default class LidAwakeExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._power = new Gio.Settings({schema_id: POWER_SCHEMA});
        this._session = new Gio.Settings({schema_id: SESSION_SCHEMA});

        // 확장 메타데이터에는 의존성을 선언할 수단이 없다. 셸이 확인해 주는 건
        // shell-version 뿐이라, 필요한 것들은 여기서 직접 확인한다.
        this._deps = {
            systemd: REQUIRED_PROGRAMS.every(
                p => GLib.find_program_in_path(p) !== null),
            upower: false,
        };

        this._lockedByLid = false;
        this._watchLid();
        this._watchBattery();
        this._deps.upower = Boolean(this._upower);

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        this._bindShortcut();

        // 유닛이 셸보다 오래 살아남으므로, 시작 시점의 진실은 설정이 아니라 유닛이다.
        if (this._lockRunning()) {
            // 셸이 크래시했다 살아난 경우. 락이 그대로 있으니 상태를 채택하고
            // gsd-power 쪽 덮어쓰기만 다시 맞춰 준다(백업은 건드리지 않는다).
            this.settings.set_boolean('active', true);
            this._writeOverrides();
        } else {
            // 락이 없다 = 로그아웃 등으로 절전이 살아 있다. 남아 있는 백업이
            // 있으면 원상 복구하고, 켜 둔 걸 잊은 채 다시 켜지지 않도록 꺼진 채 시작한다.
            this._restoreOriginals();
            this.settings.set_boolean('active', false);
        }

        this._sync();
    }

    disable() {
        // 잠금화면 진입 시에도 상태를 유지해야 하므로 session-modes 에
        // unlock-dialog 를 넣어 뒀다. 여기 도달했다면 실제 비활성화/로그아웃이다.
        this._apply(false);

        this._unbindShortcut();
        this._unwatchLid();
        this._unwatchBattery();

        this._indicator?.destroy();
        this._indicator = null;
        this._power = null;
        this._session = null;
        this._deps = null;
        this.settings = null;
    }

    setActive(state) {
        if (!this._deps.systemd) {
            this._sync();
            return;
        }
        this._apply(state);
        this.settings.set_boolean('active', state);
        this._sync();
    }

    // ---- 단축키 ----

    _bindShortcut() {
        // 단축키가 비어 있으면 셸이 등록을 건너뛴다(사용자가 지운 경우).
        Main.wm.addKeybinding(
            SHORTCUT_KEY, this.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._onShortcut());
    }

    _unbindShortcut() {
        Main.wm.removeKeybinding(SHORTCUT_KEY);
    }

    _onShortcut() {
        // 아이콘을 안 보고 누르는 경로라, 설정값이 아니라 실제 유닛 상태를
        // 기준으로 뒤집는다. 밖에서 유닛이 멈췄어도 한 번에 맞는 방향으로 간다.
        const running = this._lockRunning();
        this.setActive(!running);
        this._showOsd(this.settings.get_boolean('active'));
    }

    _showOsd(active) {
        const icon = Gio.ThemedIcon.new(active ? ICON_ON : ICON_OFF);
        Main.osdWindowManager.show(
            -1, icon, active ? '깨어 있기 켬' : '깨어 있기 끔', null);
    }

    // 실제 유닛 상태를 다시 읽어 UI/설정을 맞춘다.
    refresh() {
        const running = this._lockRunning();
        if (running !== this.settings.get_boolean('active')) {
            // 밖에서 유닛이 멈췄다면 덮어써 둔 전원 설정도 되돌려야 한다.
            if (!running)
                this._restoreOriginals();
            this.settings.set_boolean('active', running);
        }
        this._sync();
    }

    // ---- 핵심 동작 ----

    _apply(active) {
        if (active) {
            this._saveOriginals();
            this._writeOverrides();
            this._takeLock();
        } else {
            this._dropLock();
            this._restoreOriginals();
        }
    }

    _writeOverrides() {
        for (const key of POWER_KEYS)
            this._power.set_string(key, 'nothing');
    }

    _saveOriginals() {
        // 이미 백업이 있으면 덮어쓰지 않는다(원본 유실 방지).
        if (this.settings.get_string('saved-state') !== '{}')
            return;
        const saved = {power: {}};
        for (const key of POWER_KEYS)
            saved.power[key] = this._power.get_string(key);
        this.settings.set_string('saved-state', JSON.stringify(saved));
    }

    _restoreOriginals() {
        const raw = this.settings.get_string('saved-state');
        if (raw === '{}')
            return;
        try {
            const saved = JSON.parse(raw);
            for (const [key, value] of Object.entries(saved.power ?? {}))
                this._power.set_string(key, value);
            // '화면도 끄지 않기'를 없애기 전의 백업에만 들어 있다. 그 옵션을 켠 채
            // 업데이트했다면 idle-delay 가 0 으로 남아 있으니 되돌려 준다.
            if (saved.idleDelay !== undefined)
                this._session.set_uint('idle-delay', saved.idleDelay);
        } catch (e) {
            logError(e, 'lid-awake: 백업 복원 실패');
        }
        this.settings.set_string('saved-state', '{}');
    }

    // ---- systemd transient unit 으로 락 관리 ----
    //
    // 셸 프로세스가 fd 를 직접 들고 있으면 셸이 크래시할 때 락도 같이 사라져
    // 사용자 모르게 절전이 되살아난다. 별도 유닛에 맡기면 락이 살아남고,
    // 로그아웃 때는 user manager 가 유닛을 정리하므로 기본 동작으로 돌아간다.

    _lockRunning() {
        if (!this._deps.systemd)
            return false;
        return this._spawn(
            ['systemctl', '--user', 'is-active', '--quiet', UNIT]) === 0;
    }

    _takeLock() {
        if (this._lockRunning())
            return;
        const status = this._spawn([
            'systemd-run', '--user', '--collect', `--unit=${UNIT}`,
            '--description=awAIken: 덮개 닫힘·유휴 절전 차단',
            'systemd-inhibit',
            `--what=${INHIBIT_WHAT}`,
            '--who=awAIken',
            '--why=사용자가 깨어 있기를 켰음',
            '--mode=block',
            'sleep', 'infinity',
        ]);
        if (status !== 0)
            log(`lid-awake: inhibitor 유닛 시작 실패 (exit ${status})`);
    }

    _dropLock() {
        if (!this._lockRunning())
            return;
        const status = this._spawn(['systemctl', '--user', 'stop', UNIT]);
        if (status !== 0)
            log(`lid-awake: inhibitor 유닛 정지 실패 (exit ${status})`);
    }

    // ---- 덮개 감시: 잠들지는 않되 화면만 끄기 ----
    //
    // 절전을 막아 두면 mutter 가 유일한 내장 패널을 끄지 않아 덮어도 화면이 켜져
    // 있다. logind 쪽 idle inhibitor 도 gsd-power 의 blank 와는 무관하다.
    // 그래서 덮개가 닫히는 순간 스크린세이버를 직접 켜서 화면만 내린다.

    _watchLid() {
        try {
            this._upower = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                UPOWER.name, UPOWER.path, UPOWER.iface, null);
        } catch (e) {
            logError(e, 'lid-awake: UPower 연결 실패');
            return;
        }

        this._lidClosed = this._lidState() ?? false;
        this._lidId = this._upower.connect('g-properties-changed',
            (_proxy, changed) => {
                if (!changed.lookup_value('LidIsClosed', null))
                    return;
                const closed = this._lidState();
                if (closed === null || closed === this._lidClosed)
                    return;
                this._lidClosed = closed;
                this._onLidChanged(closed);
            });
    }

    _unwatchLid() {
        if (this._lidId)
            this._upower?.disconnect(this._lidId);
        this._lidId = null;
        this._upower = null;
    }

    _lidState() {
        const v = this._upower?.get_cached_property('LidIsClosed');
        return v ? v.get_boolean() : null;
    }

    _onLidChanged(closed) {
        // 확장이 꺼져 있으면 시스템 기본 동작(대개 서스펜드)에 맡긴다.
        if (!this.settings.get_boolean('active'))
            return;

        if (!closed) {
            // 잠갔다면 그대로 둔다. SetActive(false) 는 인증 없이 화면을
            // 여는 길이라 잠금의 의미가 사라진다. 사용자가 키를 누르면
            // 셸이 알아서 잠금 해제 창을 띄운다.
            if (!this._lockedByLid)
                this._setScreensaver(false);
            this._lockedByLid = false;
            return;
        }

        // 잠금은 Lock() 으로만 걸린다. SetActive(true) 는 화면만 가리고
        // 잠금 플래그를 세우지 않아서, 다시 열면 열려 있던 창이 그대로 보인다.
        if (this.settings.get_boolean('lock-on-lid-close')) {
            this._lockedByLid = true;
            this._callScreensaver('Lock', null);
        } else {
            this._setScreensaver(true);
        }
    }

    _setScreensaver(active) {
        this._callScreensaver('SetActive', new GLib.Variant('(b)', [active]));
    }

    _callScreensaver(method, args) {
        Gio.DBus.session.call(
            SCREENSAVER.name, SCREENSAVER.path, SCREENSAVER.iface, method,
            args, null, Gio.DBusCallFlags.NONE, -1, null,
            (bus, res) => {
                try {
                    bus.call_finish(res);
                } catch (e) {
                    logError(e, `lid-awake: 스크린세이버 ${method} 실패`);
                }
            });
    }

    // ---- 배터리 감시: 깨어 있다가 방전돼 꺼지는 것 막기 ----
    //
    // 절전을 막아 둔 채 잊어버리면 배터리가 0 이 될 때까지 버티다 그냥 꺼진다.
    // 설정한 비율 밑으로 방전되면 깨어 있기를 끄고 직접 절전시킨다.

    _watchBattery() {
        try {
            this._battery = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                BATTERY.name, BATTERY.path, BATTERY.iface, null);
        } catch (e) {
            logError(e, 'lid-awake: UPower 배터리 연결 실패');
            return;
        }

        // 켜는 순간이 아니라 잔량·충전 상태가 바뀔 때만 판단한다. 이미 문턱
        // 아래에서 켰다고 곧바로 재워 버리면 토글이 고장 난 것처럼 보인다.
        this._batteryId = this._battery.connect('g-properties-changed',
            (_proxy, changed) => {
                if (changed.lookup_value('Percentage', null) ||
                    changed.lookup_value('State', null))
                    this._checkBattery();
            });
    }

    _unwatchBattery() {
        if (this._batteryId)
            this._battery?.disconnect(this._batteryId);
        this._batteryId = null;
        this._battery = null;
    }

    // 배터리가 없으면(데스크톱 등) null.
    _batteryState() {
        const prop = name =>
            this._battery?.get_cached_property(name)?.deep_unpack();
        if (prop('IsPresent') !== true || prop('Type') !== DEVICE_TYPE_BATTERY)
            return null;
        const percentage = prop('Percentage');
        if (typeof percentage !== 'number')
            return null;
        return {
            percentage,
            discharging: prop('State') === DEVICE_STATE_DISCHARGING,
        };
    }

    _checkBattery() {
        if (!this.settings.get_boolean('active'))
            return;
        const threshold = this.settings.get_int(BATTERY_KEY);
        if (threshold <= 0)
            return;
        const battery = this._batteryState();
        if (!battery?.discharging || battery.percentage >= threshold)
            return;
        this._suspendForBattery(battery.percentage);
    }

    _suspendForBattery(percentage) {
        // 락을 먼저 푼다. 락을 든 채 재우려면 inhibitor 를 무시하는 절전이 필요한데
        // 그 polkit 권한(login1.suspend-ignore-inhibit)은 기본이 관리자 인증이다.
        // 락이 없으면 일반 suspend 권한(활성 세션이면 허용)으로 충분하고,
        // 깨어난 뒤에도 배터리가 모자라니 깨어 있기를 이어갈 이유가 없다.
        this.setActive(false);
        Main.notify('awAIken',
            `배터리 ${Math.floor(percentage)}% — 깨어 있기를 끄고 절전합니다`);

        Gio.DBus.system.call(
            LOGIN1.name, LOGIN1.path, LOGIN1.iface, 'Suspend',
            new GLib.Variant('(b)', [false]), null,
            Gio.DBusCallFlags.NONE, -1, null,
            (bus, res) => {
                try {
                    bus.call_finish(res);
                } catch (e) {
                    logError(e, 'lid-awake: 저전력 절전 실패');
                }
            });
    }

    // 짧게 끝나는 systemd 명령이라 동기 실행해도 셸이 눈에 띄게 멈추지 않는다.
    _spawn(argv) {
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait(null);
            return proc.get_exit_status();
        } catch (e) {
            logError(e, `lid-awake: ${argv[0]} 실행 실패`);
            return -1;
        }
    }

    _sync() {
        const active = this.settings.get_boolean('active');
        let detail;
        if (!this._deps.systemd)
            detail = 'systemd 없음 — 절전 차단 불가';
        else if (!active)
            detail = '시스템 기본 동작';
        else
            detail = this._lockRunning()
                ? '덮개 닫힘·유휴 절전 차단됨'
                : '차단 실패 — 로그 확인';

        const threshold = this.settings.get_int(BATTERY_KEY);
        if (active && threshold > 0 && this._batteryState())
            detail += `\n배터리 ${threshold}% 미만이면 절전`;

        if (this._deps.systemd && !this._deps.upower)
            detail += '\nUPower 없음 — 화면 끄기·저전력 절전 불가';

        this._indicator?.sync(active, detail, this._deps);
    }
}
