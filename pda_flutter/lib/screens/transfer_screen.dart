import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// "ย้ายตำแหน่ง" — relocate a box already sitting in the warehouse to a new
/// zone/rack/shelf/slot. Reuses [ApiClient.putawayBox] (the same call
/// BoxRegisterScreen's putaway step makes) rather than a dedicated
/// transfer endpoint — the backend already logs a 'relocate' history entry
/// instead of 'putaway' whenever the box's status is already 'warehouse',
/// so no new API was needed, only a screen that lets an operator reach that
/// call for a box that isn't mid-intake.
class TransferScreen extends StatefulWidget {
  const TransferScreen({super.key});
  @override
  State<TransferScreen> createState() => _TransferScreenState();
}

class _TransferScreenState extends State<TransferScreen> {
  final _searchCtrl = TextEditingController();
  final _searchFocus = FocusNode();
  final _zoneCtrl = TextEditingController();
  final _rackCtrl = TextEditingController();
  final _shelfCtrl = TextEditingController();
  final _slotCtrl = TextEditingController();

  Timer? _autoSearchTimer;
  static const _autoSearchDelay = Duration(milliseconds: 180);
  static const _autoSearchMinLen = 3;
  int _prevLen = 0;

  Box? _target;
  String? _error;
  bool _saving = false;

  AppController get _c => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _searchFocus.requestFocus());
  }

  @override
  void dispose() {
    _autoSearchTimer?.cancel();
    _searchCtrl.dispose();
    _searchFocus.dispose();
    _zoneCtrl.dispose();
    _rackCtrl.dispose();
    _shelfCtrl.dispose();
    _slotCtrl.dispose();
    super.dispose();
  }

  void _onSearchChanged() {
    _autoSearchTimer?.cancel();
    final text = _searchCtrl.text.trim();
    final addedChars = _searchCtrl.text.length - _prevLen;
    _prevLen = _searchCtrl.text.length;
    setState(() {});
    if (text.isEmpty) return;
    if (text.length < _autoSearchMinLen) return;
    // Same burst-detection as track_screen/rfid_locate_screen: a scan lands
    // as more than one new character in a single callback, which commits
    // immediately instead of waiting out the debounce.
    if (addedChars > 1) {
      _resolve(text);
      return;
    }
    _autoSearchTimer = Timer(_autoSearchDelay, () {
      if (!mounted || _searchCtrl.text.trim() != text) return;
      _resolve(text);
    });
  }

  void _resolve(String raw) {
    final c = _c;
    final tag = c.resolveTag(raw);
    final b = c.S?.box(tag);
    if (b == null) {
      setState(() => _error = 'ไม่พบกล่อง "$raw" ในระบบ');
      return;
    }
    if (b.status != 'warehouse') {
      setState(() => _error = 'ย้ายตำแหน่งได้เฉพาะกล่องที่อยู่ในคลังเท่านั้น (สถานะปัจจุบัน: ${StatusMeta.of(b.status).label})');
      return;
    }
    final l = b.location;
    setState(() {
      _target = b;
      _error = null;
      _zoneCtrl.text = (l['zone'] ?? '').toString();
      _rackCtrl.text = (l['rack'] ?? '').toString();
      _shelfCtrl.text = (l['shelf'] ?? '').toString();
      _slotCtrl.text = (l['slot'] ?? '').toString();
    });
  }

  void _changeTarget() {
    setState(() {
      _target = null;
      _error = null;
      _searchCtrl.clear();
      _prevLen = 0;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _searchFocus.requestFocus());
  }

  Future<void> _submit() async {
    final c = _c;
    final b = _target;
    if (b == null || _saving) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await c.api.putawayBox(
        b.tag,
        wh: c.wh,
        zone: _zoneCtrl.text.trim(),
        rack: _rackCtrl.text.trim(),
        shelf: _shelfCtrl.text.trim(),
        slot: _slotCtrl.text.trim(),
      );
      if (!mounted) return;
      c.toastMsg('ย้ายตำแหน่งแล้ว', b.tag, ResultKind.ok);
      _changeTarget();
    } catch (e) {
      setState(() => _error = e is ApiException ? e.message : 'ย้ายตำแหน่งไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final b = _target;

    return Column(
      children: [
        StickyHeader(
          onBack: c.backToHome,
          title: Text(loc.t('ย้ายตำแหน่ง')),
          subtitle: Text(loc.t('ยิงหรือพิมพ์รหัสกล่องที่จะย้าย')),
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
            children: [
              if (b == null) ...[
                TextField(
                  controller: _searchCtrl,
                  focusNode: _searchFocus,
                  textCapitalization: TextCapitalization.characters,
                  autocorrect: false,
                  enableSuggestions: false,
                  onChanged: (_) => _onSearchChanged(),
                  onSubmitted: (_) => _resolve(_searchCtrl.text.trim()),
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
                  decoration: InputDecoration(
                    hintText: loc.t('รหัสกล่อง เช่น CRT-01'),
                    hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 15),
                    prefixIcon: Icon(Icons.sync_alt, color: C.muted),
                    isDense: true,
                    filled: true,
                    fillColor: C.surface,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: BorderSide(color: C.ink, width: 1.5),
                    ),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 10),
                  Text(_error!, style: TextStyle(fontSize: 13, color: C.red, fontWeight: FontWeight.w600)),
                ],
              ] else ...[
                Panel(
                  padding: const EdgeInsets.all(16),
                  radius: 18,
                  child: Row(
                    children: [
                      Container(
                        width: 46,
                        height: 46,
                        decoration: BoxDecoration(color: C.neutralBg2, borderRadius: BorderRadius.circular(13)),
                        child: Icon(Icons.inventory_2_outlined, size: 24, color: C.ink2),
                      ),
                      const SizedBox(width: 13),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(b.tag,
                                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
                            Text('${c.S?.typeName(b.type) ?? ''} · ${c.S?.whName(b.location['wh']?.toString()) ?? ''}',
                                style: TextStyle(fontSize: 12, color: C.muted)),
                          ],
                        ),
                      ),
                      GestureDetector(
                        onTap: _changeTarget,
                        child: Text(loc.t('เปลี่ยนกล่อง'),
                            style: TextStyle(fontSize: 12.5, color: C.ink2, fontWeight: FontWeight.w600)),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${loc.t('ตำแหน่งใหม่')} · ${c.selWhName}',
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                FieldLabel(loc.t('โซน')),
                                TextField(controller: _zoneCtrl, decoration: pdaInput('เช่น A', radius: 12)),
                              ],
                            ),
                          ),
                          const SizedBox(width: 9),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                FieldLabel(loc.t('แร็ค')),
                                TextField(controller: _rackCtrl, decoration: pdaInput('เช่น 1', radius: 12)),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 11),
                      Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                FieldLabel(loc.t('ชั้น')),
                                TextField(controller: _shelfCtrl, decoration: pdaInput('เช่น 2', radius: 12)),
                              ],
                            ),
                          ),
                          const SizedBox(width: 9),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                FieldLabel(loc.t('ช่อง')),
                                TextField(controller: _slotCtrl, decoration: pdaInput('เช่น 3', radius: 12)),
                              ],
                            ),
                          ),
                        ],
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 10),
                        Text(_error!, style: TextStyle(fontSize: 12.5, color: C.red)),
                      ],
                      const SizedBox(height: 14),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton(
                          onPressed: _saving ? null : _submit,
                          style: FilledButton.styleFrom(
                            backgroundColor: C.ink,
                            padding: const EdgeInsets.symmetric(vertical: 14),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          ),
                          child: Text(_saving ? loc.t('กำลังบันทึก…') : loc.t('ยืนยันย้ายตำแหน่ง')),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
