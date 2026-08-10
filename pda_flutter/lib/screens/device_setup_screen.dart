import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/connect_qr.dart';
import '../services/i18n.dart';
import '../services/theme_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/scan_capture.dart';

/// Connecting a terminal to the main system — done once, by whoever hands the
/// device out. It holds the one password in the whole product — the device's
/// own service account, typed by an admin, never by warehouse staff.
///
/// คลัง/ประตูไม่ได้ถูกถามที่นี่อีกต่อไป — เดิมเคยผูกเครื่องไว้กับประตูเดียวถาวร
/// แต่เครื่องจริงพกไปใช้หลายคลัง/ประตูในกะเดียวกันได้ จึงย้ายไปเลือกตอนกด
/// รับเข้า/ส่งออกจากหน้าแรกแทน (ดู AppController.pickWh/pickGate และ
/// home_screen.dart._pickPostThen)
class DeviceSetupScreen extends StatefulWidget {
  const DeviceSetupScreen({super.key});

  @override
  State<DeviceSetupScreen> createState() => _DeviceSetupScreenState();
}

class _DeviceSetupScreenState extends State<DeviceSetupScreen> {
  late final TextEditingController _url;
  late final TextEditingController _account;
  late final TextEditingController _password;
  bool _showAccount = false;

  /// The typed-by-hand fallback for the server address. Off by default — the
  /// QR is the intended path (see [_ServerAddressField]); this only appears
  /// once someone deliberately asks for it.
  bool _manualUrl = false;

  /// True once this session's address came from a scanned QR, so the tile can
  /// say where the value came from instead of just showing a URL that might
  /// equally be a leftover from the last provisioning.
  bool _fromQr = false;

  /// The one profile this screen actually shows/picks — resolved from what
  /// Android reports the handheld as (see [_detectDevice]), not assumed.
  /// Null while detection is still running.
  _DeviceProfile? _profile;

  @override
  void initState() {
    super.initState();
    final c = context.read<AppController>();
    _url = TextEditingController(text: c.prefs.baseUrl);
    _account = TextEditingController(text: c.prefs.username);
    _password = TextEditingController();
    _detectDevice(c);
  }

  /// Used to auto-pick the Zebra profile for every device this build ran
  /// on, regardless of what it actually was — a phone or an emulator got
  /// labelled "Zebra MC3300 Series (MC3390R)" just as confidently as a real
  /// unit, because the picker never asked the OS. Now it does: Build.MODEL/
  /// MANUFACTURER/BRAND (via RfidService.deviceInfo, no reader connection
  /// required) either matches the one qualified profile or it doesn't, and
  /// only a genuine match gets that name — anything else shows its own real
  /// manufacturer/model instead of a false "Zebra" label.
  Future<void> _detectDevice(AppController c) async {
    final info = await c.rfid.deviceInfo();
    final model = (info['model'] ?? '').toString();
    final manufacturer = (info['manufacturer'] ?? '').toString();
    final brand = (info['brand'] ?? '').toString();
    final release = (info['androidRelease'] ?? '').toString();
    final looksZebra = manufacturer.toLowerCase().contains('zebra') ||
        brand.toLowerCase().contains('zebra') ||
        model.toUpperCase().contains('MC33');

    final resolved = looksZebra
        ? const _DeviceProfile(
            id: 'mc3390r',
            name: 'Zebra MC3300 Series (MC3390R)',
            androidVersion: 'Android 8.0 (Oreo)',
            note: 'เครื่องอ่าน RFID ในตัวเครื่อง',
            hasRfid: true,
          )
        : _DeviceProfile(
            id: 'generic',
            name: [manufacturer, model]
                    .where((s) => s.isNotEmpty)
                    .join(' ')
                    .trim()
                    .isEmpty
                ? 'อุปกรณ์นี้'
                : [manufacturer, model].where((s) => s.isNotEmpty).join(' '),
            androidVersion: release.isEmpty ? '' : 'Android $release',
            note: 'ไม่มีเครื่องอ่าน RFID ในตัวเครื่อง — ใช้บาร์โค้ดได้ตามปกติ',
            hasRfid: false,
          );
    if (!mounted) return;
    setState(() => _profile = resolved);
    // Single detected option — picking it for the operator is the same
    // "no real choice, don't make them tap it" reasoning the old
    // always-Zebra version had, just now backed by an actual check.
    if (c.prefs.deviceModel.isEmpty) c.setDeviceModel(resolved.id);
  }

  /// Opens the scan sheet and applies whatever comes back.
  ///
  /// The account fields are only overwritten when the QR actually carries
  /// them: an admin who prints a URL-only QR (the default on the web side) is
  /// re-pointing a terminal at a moved server, and silently blanking that
  /// terminal's working service account would break it in a way that looks
  /// like the new address being wrong.
  Future<void> _scanConnectQr() async {
    final cfg = await showModalBottomSheet<ConnectQr>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => const _ConnectQrSheet(),
    );
    if (cfg == null || !mounted) return;
    setState(() {
      _url.text = cfg.baseUrl;
      _fromQr = true;
      _manualUrl = false;
      if (cfg.username != null) _account.text = cfg.username!;
      if (cfg.password != null) _password.text = cfg.password!;
      if (cfg.username != null || cfg.password != null) _showAccount = true;
    });
  }

  @override
  void dispose() {
    _url.dispose();
    _account.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final themeCtrl = context.watch<ThemeController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final canSave = c.prefs.deviceModel.isNotEmpty;
    // A device being provisioned for the first time has nowhere to go back to.
    final canLeave = c.deviceConfigured;

    return AutoHideHeader(
      header: StickyHeader(
        onBack: canLeave ? c.backToHome : null,
        title: Text(loc.t('ตั้งค่าเครื่อง')),
        subtitle:
            Text(loc.t('เชื่อมต่อครั้งเดียว — เลือกคลัง/ประตูตอนเริ่มงานแทน')),
        actions: [
          LangToggleButton(loc: loc),
          const SizedBox(width: 8),
          ThemeToggleButton(ctrl: themeCtrl)
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(16, 18, 16, bottom + 96),
              children: [
                _StepLabel(loc.t('1 · อุปกรณ์ที่ใช้งาน')),
                const SizedBox(height: 11),
                _DeviceModelPicker(
                  profile: _profile,
                  selected: c.prefs.deviceModel,
                  onPick: c.setDeviceModel,
                  loc: loc,
                ),
                const SizedBox(height: 18),
                _StepLabel(loc.t('2 · การเชื่อมต่อระบบหลัก')),
                const SizedBox(height: 11),
                Panel(
                  padding: const EdgeInsets.all(16),
                  radius: 18,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Only shown once there's something to say — connected, or
                      // a real error from the last attempt. Nothing has failed
                      // yet on a fresh setup screen, so there's nothing to report.
                      if (c.connected || c.connError != null) ...[
                        Row(
                          children: [
                            Container(
                              width: 11,
                              height: 11,
                              decoration: BoxDecoration(
                                color: c.connected ? C.lime : C.red,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 11),
                            Expanded(
                              child: Text(
                                c.connected
                                    ? '${loc.t('เชื่อมต่อแล้ว')} · ${c.boxCount} ${loc.t('กล่อง')}'
                                    : c.connError!,
                                style: const TextStyle(
                                    fontSize: 14, fontWeight: FontWeight.w600),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 14),
                      ],
                      FieldLabel(loc.t('ที่อยู่เซิร์ฟเวอร์')),
                      _ServerAddressField(
                        url: _url.text.trim(),
                        fromQr: _fromQr,
                        loc: loc,
                        onScan: _scanConnectQr,
                        onManual: () => setState(() => _manualUrl = true),
                      ),
                      // Kept as an escape hatch, not as the main path: a site
                      // with no screen to show the QR on (or a terminal whose
                      // imager has died) still has to be able to connect at
                      // all, and that is exactly the situation where nobody
                      // can be told "go generate a QR first".
                      if (_manualUrl) ...[
                        const SizedBox(height: 9),
                        TextField(
                          controller: _url,
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          onChanged: (_) => setState(() {}),
                          decoration: pdaInput('http://192.168.1.10:4000'),
                        ),
                      ],
                      const SizedBox(height: 10),
                      // Collapsed by default: on a device that already works,
                      // nobody should be poking at its credentials.
                      GestureDetector(
                        onTap: () =>
                            setState(() => _showAccount = !_showAccount),
                        child: Row(
                          children: [
                            Icon(
                                _showAccount
                                    ? Icons.expand_less
                                    : Icons.expand_more,
                                size: 18,
                                color: C.muted),
                            const SizedBox(width: 4),
                            Text(loc.t('บัญชีประจำเครื่อง'),
                                style: TextStyle(
                                    fontSize: 12.5,
                                    color: C.muted,
                                    fontWeight: FontWeight.w600)),
                          ],
                        ),
                      ),
                      if (_showAccount) ...[
                        const SizedBox(height: 10),
                        TextField(
                          controller: _account,
                          autocorrect: false,
                          decoration:
                              pdaInput(loc.t('ชื่อบัญชีเครื่อง เช่น pda-01')),
                        ),
                        const SizedBox(height: 8),
                        TextField(
                          controller: _password,
                          obscureText: true,
                          decoration: pdaInput(
                              loc.t('รหัสผ่าน (เว้นว่าง = ไม่เปลี่ยน)')),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          loc.t(
                              'บัญชีนี้เป็นของเครื่อง ไม่ใช่ของพนักงาน — ตั้งครั้งเดียวตอนแจกเครื่อง'),
                          style: TextStyle(
                              fontSize: 11.5, color: C.faint, height: 1.4),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: EdgeInsets.fromLTRB(16, 12, 16, bottom + 14),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.bottomCenter,
                end: Alignment.topCenter,
                colors: [C.bg, const Color(0x00F5F5F7)],
                stops: const [0.68, 1],
              ),
            ),
            child: PrimaryButton(
              label: c.busy
                  ? loc.t('กำลังเชื่อมต่อ…')
                  : loc.t('บันทึกและเริ่มใช้งาน'),
              trailing: Icon(Icons.arrow_forward,
                  size: 19, color: canSave ? C.limeDeep : C.faint),
              onTap: (canSave && !c.busy)
                  ? () => c.completeDeviceSetup(
                        baseUrl: _url.text,
                        username: _account.text,
                        password: _password.text,
                      )
                  : null,
            ),
          ),
        ],
      ),
    );
  }
}

/// Step 2's server address — a scan target, not a text box.
///
/// Typing `http://192.168.1.10:4000` is the single worst interaction left in
/// this app: it is done on a handheld keypad, by the person least likely to be
/// standing next to the server, and every failure mode of getting it wrong
/// looks identical to the network being down. The address is generated as a QR
/// on the web app (ตั้งค่า → เชื่อมต่อ PDA) and read here with the imager the
/// terminal already uses for every other value it accepts — the same "scanned,
/// never typed" rule the rest of the app enforces, finally applied to the one
/// field that was exempt from it.
class _ServerAddressField extends StatelessWidget {
  final String url;
  final bool fromQr;
  final LocaleController loc;
  final VoidCallback onScan;
  final VoidCallback onManual;
  const _ServerAddressField({
    required this.url,
    required this.fromQr,
    required this.loc,
    required this.onScan,
    required this.onManual,
  });

  @override
  Widget build(BuildContext context) {
    final has = url.isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Material(
          color: has ? C.limeBg : C.neutralBg,
          borderRadius: BorderRadius.circular(14),
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: onScan,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                    color: has ? C.limeBorder : C.border2,
                    width: has ? 1.5 : 1),
              ),
              child: Row(
                children: [
                  Icon(has ? Icons.check_circle : Icons.qr_code_scanner,
                      size: 22, color: has ? C.limeText : C.ink2),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          has ? url : loc.t('สแกน QR เพื่อเชื่อมต่อ'),
                          style: TextStyle(
                            fontSize: has ? 13.5 : 15,
                            fontWeight: FontWeight.w700,
                            fontFamily: has ? 'monospace' : null,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          has
                              ? (fromQr
                                  ? loc.t('จาก QR · แตะเพื่อสแกนใหม่')
                                  : loc.t('ที่อยู่เดิมของเครื่อง · แตะเพื่อสแกนใหม่'))
                              : loc.t(
                                  'เปิดหน้าเว็บ ตั้งค่า → เชื่อมต่อ PDA แล้วยิง QR ที่หน้าจอ'),
                          style: TextStyle(fontSize: 12, color: C.muted),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            onPressed: onManual,
            style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap),
            child: Text(loc.t('ไม่มี QR — พิมพ์ที่อยู่เอง'),
                style: TextStyle(
                    fontSize: 11.5,
                    color: C.muted,
                    fontWeight: FontWeight.w600)),
          ),
        ),
      ],
    );
  }
}

/// The scan target itself. No preview, no camera: the decoded text arrives
/// through [ScanCapture] exactly as a box barcode does, so the sheet is a
/// pure state display — aim the terminal at the screen, pull the trigger.
class _ConnectQrSheet extends StatefulWidget {
  const _ConnectQrSheet();
  @override
  State<_ConnectQrSheet> createState() => _ConnectQrSheetState();
}

class _ConnectQrSheetState extends State<_ConnectQrSheet> {
  /// Set when something was scanned that isn't a connection QR — a box
  /// barcode, a shelf code. Shown rather than swallowed, because "nothing
  /// happened" on a trigger pull is indistinguishable from a dead imager.
  String? _wrongCode;

  void _onScan(String code) {
    final cfg = ConnectQr.parse(code);
    if (cfg == null) {
      setState(() => _wrongCode = code);
      return;
    }
    Navigator.of(context).pop(cfg);
  }

  @override
  Widget build(BuildContext context) {
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    return ScanCapture(
      onScan: _onScan,
      child: Container(
        padding: EdgeInsets.fromLTRB(20, 18, 20, bottom + 18),
        decoration: BoxDecoration(
          color: C.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                    color: C.border2, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            const SizedBox(height: 18),
            Center(
              child: Container(
                width: 74,
                height: 74,
                decoration: BoxDecoration(
                    color: C.limeBg, borderRadius: BorderRadius.circular(22)),
                child: Icon(Icons.qr_code_2, size: 40, color: C.limeText),
              ),
            ),
            const SizedBox(height: 16),
            Text(loc.t('ยิง QR เชื่อมต่อระบบ'),
                textAlign: TextAlign.center,
                style:
                    const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 7),
            Text(
              loc.t(
                  'บนคอมพิวเตอร์: เปิดเว็บ BoxTrace → ตั้งค่า → เชื่อมต่อ PDA แล้วเล็งเครื่องไปที่ QR บนหน้าจอ'),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: C.muted, height: 1.45),
            ),
            if (_wrongCode != null) ...[
              const SizedBox(height: 14),
              Panel(
                padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
                radius: 13,
                color: C.redBg,
                border: Border.all(color: C.red.withOpacity(0.35)),
                child: Row(
                  children: [
                    Icon(Icons.error_outline, size: 18, color: C.red),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Text(
                        '${loc.t('ไม่ใช่ QR เชื่อมต่อระบบ')} — ${_wrongCode!}',
                        style: TextStyle(
                            fontSize: 12.5,
                            color: C.red,
                            fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 18),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(loc.t('ยกเลิก'),
                  style: TextStyle(
                      fontSize: 14,
                      color: C.muted,
                      fontWeight: FontWeight.w700)),
            ),
          ],
        ),
      ),
    );
  }
}

/// One entry in the supported-hardware catalog. `androidVersion` is shown
/// verbatim rather than inferred from the running OS, since the point of
/// this step is to record what the *device* is, independent of whatever
/// firmware happens to be on it at provisioning time.
class _DeviceProfile {
  final String id;
  final String name;
  final String androidVersion;
  final String note;
  final bool hasRfid;
  const _DeviceProfile({
    required this.id,
    required this.name,
    required this.androidVersion,
    required this.note,
    required this.hasRfid,
  });
}

/// Step 1 of setup: which handheld this terminal actually is — detected (see
/// [_DeviceSetupScreenState._detectDevice]), not assumed. [profile] is null
/// while that detection is still in flight. Auto-picked once known, so this
/// stays visible as confirmation of what was found rather than a required
/// tap — but it's now confirming a real check, not repeating a hardcoded
/// name at every device that opens this screen.
class _DeviceModelPicker extends StatelessWidget {
  final _DeviceProfile? profile;
  final String selected;
  final ValueChanged<String> onPick;
  final LocaleController loc;
  const _DeviceModelPicker({
    required this.profile,
    required this.selected,
    required this.onPick,
    required this.loc,
  });

  @override
  Widget build(BuildContext context) {
    final p = profile;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          loc.t(
              'ระบุรุ่นอุปกรณ์พกพาที่ใช้งานเครื่องนี้ เพื่อให้ระบบตั้งค่าฟังก์ชันเครื่องอ่าน RFID ให้ถูกต้อง'),
          style: TextStyle(fontSize: 12.5, color: C.muted, height: 1.4),
        ),
        const SizedBox(height: 11),
        if (p == null)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Center(
                child: SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2.4))),
          )
        else ...[
          Padding(
            padding: const EdgeInsets.only(bottom: 9),
            child: _DeviceProfileTile(
              profile: p,
              selected: selected == p.id,
              onTap: () => onPick(p.id),
            ),
          ),
          Text(
            p.hasRfid
                ? loc.t(
                    'ขณะนี้ระบบรองรับอุปกรณ์รุ่นนี้เพียงรุ่นเดียว รุ่นอื่นจะเปิดให้เลือกในการอัปเดตครั้งถัดไป')
                : loc.t(
                    'ตรวจไม่พบเครื่องอ่าน RFID ในตัวเครื่องนี้ — ฟังก์ชันบาร์โค้ดยังใช้งานได้ตามปกติ'),
            style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.4),
          ),
        ],
      ],
    );
  }
}

class _DeviceProfileTile extends StatelessWidget {
  final _DeviceProfile profile;
  final bool selected;
  final VoidCallback onTap;
  const _DeviceProfileTile(
      {required this.profile, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? C.limeBg : C.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
                color: selected ? C.limeBorder : C.border2,
                width: selected ? 1.5 : 1),
          ),
          child: Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: selected ? C.lime : C.neutralBg,
                  borderRadius: BorderRadius.circular(11),
                ),
                alignment: Alignment.center,
                child: Icon(Icons.qr_code_scanner,
                    size: 20, color: selected ? C.limeDeep : C.ink2),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(profile.name,
                        style: const TextStyle(
                            fontSize: 14.5, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text(
                        [
                          if (profile.androidVersion.isNotEmpty)
                            profile.androidVersion,
                          profile.note
                        ].join(' · '),
                        style: TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(
                selected ? Icons.check_circle : Icons.radio_button_unchecked,
                size: 22,
                color: selected ? C.limeText : C.chevron,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StepLabel extends StatelessWidget {
  final String text;
  const _StepLabel(this.text);
  @override
  Widget build(BuildContext context) => Text(text,
      style:
          TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: C.ink));
}
