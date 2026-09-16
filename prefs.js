import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SHORTCUT_KEY = 'toggle-shortcut';
const BATTERY_KEY = 'low-battery-threshold';
const HINT = '눌러서 새 조합을 지정, Backspace 로 해제';

// 충돌을 훑어볼 스키마. 여기 없는 곳(앱 자체 단축키 등)의 충돌은 잡지 못한다.
const CONFLICT_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];

const CUSTOM_LIST_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_ITEM_SCHEMA =
    'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

// 문자열 비교로는 '<Super><Shift>l' 과 '<Shift><Super>L' 을 구분하지 못한다.
// 파싱해서 (keyval, mask) 로 비교한다.
function parseAccel(accel) {
    const [ok, keyval, mask] = Gtk.accelerator_parse(accel);
    return ok ? {keyval, mask} : null;
}

function sameAccel(a, b) {
    return a && b && a.keyval === b.keyval && a.mask === b.mask;
}

// 해당 조합을 이미 쓰고 있는 곳의 이름. 없으면 null.
function findConflict(accel) {
    const target = parseAccel(accel);
    if (!target)
        return null;

    const source = Gio.SettingsSchemaSource.get_default();

    for (const id of CONFLICT_SCHEMAS) {
        const schema = source.lookup(id, true);
        if (!schema)
            continue;
        const settings = new Gio.Settings({settings_schema: schema});
        for (const key of schema.list_keys()) {
            const value = settings.get_value(key);
            if (value.get_type_string() !== 'as')
                continue;
            for (const accelStr of value.deep_unpack()) {
                if (sameAccel(parseAccel(accelStr), target))
                    return `${id} ${key}`;
            }
        }
    }

    return findCustomConflict(target);
}

// 사용자 정의 단축키는 relocatable 스키마라 경로를 따라가야 한다.
function findCustomConflict(target) {
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source.lookup(CUSTOM_ITEM_SCHEMA, true) ||
        !source.lookup(CUSTOM_LIST_SCHEMA, true))
        return null;

    const list = new Gio.Settings({schema_id: CUSTOM_LIST_SCHEMA});
    for (const path of list.get_strv('custom-keybindings')) {
        const item = new Gio.Settings({
            schema_id: CUSTOM_ITEM_SCHEMA,
            path,
        });
        if (sameAccel(parseAccel(item.get_string('binding')), target))
            return item.get_string('name') || '사용자 정의 단축키';
    }
    return null;
}

const ShortcutRow = GObject.registerClass(
class LidAwakeShortcutRow extends Adw.ActionRow {
    _init(settings) {
        super._init({
            title: '깨어 있기 토글',
            subtitle: HINT,
            activatable: true,
        });
        this._settings = settings;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: '없음',
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);

        this.connect('activated', () => this._openCapture());

        this._changedId = settings.connect(
            `changed::${SHORTCUT_KEY}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._changedId));
        this._sync();
    }

    _current() {
        const list = this._settings.get_strv(SHORTCUT_KEY);
        return list.length > 0 ? list[0] : '';
    }

    _set(accel) {
        this._settings.set_strv(SHORTCUT_KEY, accel ? [accel] : []);
    }

    _sync() {
        const accel = this._current();
        this._label.accelerator = accel;

        if (!accel) {
            this.subtitle = '지정되지 않음 — 아이콘으로만 토글';
            return;
        }
        const conflict = findConflict(accel);
        this.subtitle = conflict
            ? `충돌: ${conflict}`
            : HINT;
    }

    _openCapture() {
        const dialog = new Adw.AlertDialog({
            heading: '새 단축키 입력',
            body: '원하는 조합을 누르세요.\n' +
                  'Backspace 로 해제, Esc 로 취소합니다.',
        });
        dialog.add_response('cancel', '취소');

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() &
                         ~Gdk.ModifierType.LOCK_MASK;

            if (mask === 0 && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
                this._set('');
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // 수식키 없는 단일 키는 일반 입력을 잡아먹으므로 받지 않는다.
            if (!isValidBinding(mask, keycode, keyval) ||
                !isValidAccel(mask, keyval))
                return Gdk.EVENT_STOP;

            this._set(Gtk.accelerator_name_with_keycode(
                null, keyval, keycode, mask));
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);

        dialog.present(this.get_root());
    }
});

// gnome-control-center 의 keyboard-shortcuts 검사와 같은 기준.
function isValidBinding(mask, keycode, keyval) {
    if (mask === 0)
        return false;
    if (mask === Gdk.ModifierType.SHIFT_MASK && keycode !== 0) {
        if ((keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
            (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
            (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9) ||
            (keyval >= Gdk.KEY_kana_fullstop && keyval <= Gdk.KEY_semivoicedsound) ||
            (keyval >= Gdk.KEY_Arabic_comma && keyval <= Gdk.KEY_Arabic_sukun) ||
            (keyval >= Gdk.KEY_Serbian_dje && keyval <= Gdk.KEY_Cyrillic_HARDSIGN) ||
            (keyval >= Gdk.KEY_Greek_ALPHAaccent && keyval <= Gdk.KEY_Greek_omega) ||
            (keyval >= Gdk.KEY_hebrew_doublelowline && keyval <= Gdk.KEY_hebrew_taf) ||
            (keyval >= Gdk.KEY_Thai_kokai && keyval <= Gdk.KEY_Thai_lekkao) ||
            (keyval >= Gdk.KEY_Hangul_Kiyeog && keyval <= Gdk.KEY_Hangul_J_YeorinHieuh) ||
            (keyval === Gdk.KEY_space && mask === 0))
            return false;
    }
    return true;
}

function isValidAccel(mask, keyval) {
    return Gtk.accelerator_valid(keyval, mask) ||
           (keyval === Gdk.KEY_Tab && mask !== 0);
}

// 슬라이더는 이 값들 사이에서만 멈춘다. 0 은 끔.
const BATTERY_STEPS = [0, 5, 10, 15, 20, 30, 50];

// 간격이 고르지 않아 스케일은 값이 아니라 목록 인덱스를 움직인다.
const BatteryRow = GObject.registerClass(
class LidAwakeBatteryRow extends Adw.ActionRow {
    _init(settings) {
        super._init({title: '저전력 강제 절전'});
        this._settings = settings;

        this._scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: BATTERY_STEPS.length - 1,
                step_increment: 1,
                page_increment: 1,
            }),
            round_digits: 0,
            draw_value: false,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 280,
        });
        BATTERY_STEPS.forEach((value, i) => this._scale.add_mark(
            i, Gtk.PositionType.BOTTOM, value === 0 ? '끔' : `${value}%`));
        this.add_suffix(this._scale);

        this._scale.connect('value-changed', () => {
            // _sync 가 칸을 맞춘 것뿐이면 저장하지 않는다. 안 그러면 목록에 없는
            // 값이 설정창을 여는 것만으로 가까운 칸 값으로 바뀐다.
            if (this._syncing)
                return;
            const value = BATTERY_STEPS[Math.round(this._scale.get_value())];
            if (value !== settings.get_int(BATTERY_KEY))
                settings.set_int(BATTERY_KEY, value);
        });

        this._changedId = settings.connect(
            `changed::${BATTERY_KEY}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._changedId));
        this._sync();
    }

    _sync() {
        const value = this._settings.get_int(BATTERY_KEY);
        // gsettings 로 목록에 없는 값(예: 25)을 넣었을 수 있으니 가장 가까운 칸에 둔다.
        let index = 0;
        BATTERY_STEPS.forEach((step, i) => {
            if (Math.abs(step - value) < Math.abs(BATTERY_STEPS[index] - value))
                index = i;
        });
        this._syncing = true;
        this._scale.set_value(index);
        this._syncing = false;

        this.subtitle = value > 0
            ? `깨어 있기 중 배터리가 ${value}% 미만으로 방전되면 끄고 절전`
            : '사용 안 함 — 배터리가 다 되면 그대로 꺼짐';
    }
});

export default class LidAwakePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: '설정',
            icon_name: 'preferences-system-symbolic',
        });

        const batteryGroup = new Adw.PreferencesGroup({
            title: '배터리',
            description: '충전 중에는 동작하지 않습니다. 절전 후 깨어 있기는 꺼진 채로 돌아옵니다.',
        });
        batteryGroup.add(new BatteryRow(settings));
        page.add(batteryGroup);

        const group = new Adw.PreferencesGroup({
            title: '단축키',
            description: '변경은 즉시 적용됩니다. 다시 로그인할 필요 없습니다.',
        });
        group.add(new ShortcutRow(settings));
        page.add(group);

        window.add(page);
    }
}
