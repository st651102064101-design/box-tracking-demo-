import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../models/location.dart';
import '../services/api_client.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Move a box that is already in the warehouse to a different shelf position.
///
/// Mechanically this is the same write the receiving flow ends on
/// (POST /api/boxes/:tag/putaway) — the WMS has one concept of "where is this
/// box", and relocating is just setting it again. What makes it a separate
/// screen is the starting point: receiving knows which box it just created,
/// whereas a relocation starts from a box already on a shelf that the
/// operator has physically picked up, so it has to be *identified* first.
///
/// Two steps, one screen:
///  1. [_Step.pick] — scan the box (barcode or RFID), or search by tag/type.
///  2. [_Step.place] — pick the destination from the Location Master.
class RelocateScreen extends StatefulWidget {
  const RelocateScreen({super.key});
  @override
  State<RelocateScreen> createState() => _RelocateScreenState();
}

enum _Step { pick, place }

class _RelocateScreenState extends State<RelocateScreen> {
  final _searchCtrl = TextEditingController();
  final _searchFocus = FocusNode();

  _Step _step = _Step.pick;
  Box? _target;
  bool _saving = false;
  String? _error;

  String? _zone, _rack, _shelf, _slot;

  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<bool>? _triggerSub;
  bool _sweeping = false;

  AppController get _c => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    final rfid = _c.rfid;
    // A trigger pull on the pick step resolves the read straight to a box —
    // the operator is holding the box, so scanning it is the fastest way to
    // say which one is moving.
    _tagSub = rfid.tagReads.listen(_onTagRead);
    _triggerSub = rfid.triggers.listen((p) {
      if (mounted) setState(() => _sweeping = p);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _searchFocus.requestFocus());
  }

  @override
  void dispose() {
    _tagSub?.cancel();
    _triggerSub?.cancel();
    _searchCtrl.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  void _onTagRead(RfidTagRead read) {
    if (_step != _Step.pick || read.epc.isEmpty) return;
    final tag = _c.S?.tagForCode(read.epc);
    if (tag == null) return; // a tag this WMS has never seen: not a box to move
    final b = _c.S?.box(tag);
    if (b != null) _pick(b);
  }

  LocationCascade get _cascade => LocationCascade(_c.S?.locations ?? const {});

  void _pick(Box b) {
    final l = b.location;
    setState(() {
      _target = b;
      _step = _Step.place;
      _error = null;
      // Seeded with where the box is now, so a move that only changes the
      // slot doesn't make the operator re-pick zone/rack/shelf from scratch.
      _zone = (l['zone'] ?? '').toString().isEmpty ? null : l['zone'].toString();
      _rack = (l['rack'] ?? '').toString().isEmpty ? null : l['rack'].toString();
      _shelf = (l['shelf'] ?? '').toString().isEmpty ? null : l['shelf'].toString();
      _slot = (l['slot'] ?? '').toString().isEmpty ? null : l['slot'].toString();
    });
    unawaited(_c.rfid.stopInventory());
  }

  void _changeTarget() {
    setState(() {
      _step = _Step.pick;
      _target = null;
      _error = null;
      _searchCtrl.clear();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _searchFocus.requestFocus());
  }

  Future<void> _toggleSweep() async {
    final c = _c;
    if (!c.rfid.supported) return;
    if (_sweeping) {
      setState(() => _sweeping = false);
      await c.rfid.stopInventory();
      return;
    }
    if (c.rfidCharging) {
      c.toastMsg('ยิงแท็กไม่ได้ขณะชาร์จ', 'ยกเครื่องออกจากแท่นชาร์จก่อน', ResultKind.warn);
      return;
    }
    setState(() => _sweeping = true);
    await c.rfid.startInventory();
  }

  Future<void> _save() async {
    final b = _target;
    if (b == null || _saving) return;
    // Every level empty would file a move to "somewhere in this warehouse",
    // which is not a relocation — it's erasing the position the box had.
    if (_zone == null && _rack == null && _shelf == null && _slot == null) {
      setState(() => _error = 'เลือกตำแหน่งปลายทางอย่างน้อยหนึ่งระดับก่อน');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await _c.api.putawayBox(
        b.tag,
        wh: _c.wh,
        zone: _zone ?? '',
        rack: _rack ?? '',
        shelf: _shelf ?? '',
        slot: _slot ?? '',
      );
      await _c.refresh();
      if (!mounted) return;
      final where = [_zone, _rack, _shelf, _slot].whereType<String>().join(' · ');
      _c.toastMsg('ย้ายตำแหน่งแล้ว', '${b.tag} → $where', ResultKind.ok);
      _changeTarget();
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.message : 'ย้ายตำแหน่งไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    return Column(
      children: [
        StickyHeader(
          onBack: _step == _Step.place ? _changeTarget : c.backToHome,
          title: const Text('ย้ายตำแหน่งกล่อง'),
          subtitle: Text(_step == _Step.pick ? 'เลือกกล่องที่จะย้าย' : 'เลือกตำแหน่งปลายทาง'),
        ),
        Expanded(child: _step == _Step.pick ? _pickBody(c) : _placeBody(c)),
      ],
    );
  }

  // ── Step 1: which box is moving ───────────────────────────────────────
  Widget _pickBody(AppController c) {
    final bottom = MediaQuery.of(context).padding.bottom;
    final q = _searchCtrl.text.trim().toLowerCase();
    final all = c.S?.boxes.toList() ?? const <Box>[];
    // Only boxes actually in the warehouse can be moved within it — one that
    // is out with a customer has no shelf position to change.
    final movable = all.where((b) => b.status == 'warehouse' || b.status == 'hold').toList();
    final results = q.isEmpty
        ? const <Box>[]
        : movable.where((b) {
            final type = c.S!.typeName(b.type).toLowerCase();
            return b.tag.toLowerCase().contains(q) || type.contains(q);
          }).take(30).toList();

    return ListView(
      padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
      children: [
        TextField(
          controller: _searchCtrl,
          focusNode: _searchFocus,
          textCapitalization: TextCapitalization.characters,
          autocorrect: false,
          enableSuggestions: false,
          onChanged: (_) => setState(() {}),
          onSubmitted: (_) {
            if (results.length == 1) _pick(results.first);
          },
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
          decoration: InputDecoration(
            hintText: 'ยิงบาร์โค้ด / พิมพ์รหัสกล่อง',
            hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 15),
            prefixIcon: Icon(Icons.search, color: C.muted),
            isDense: true,
            filled: true,
            fillColor: C.surface,
            border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: C.fieldBorder, width: 1.5)),
            enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: C.fieldBorder, width: 1.5)),
            focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: C.ink, width: 1.5)),
          ),
        ),
        const SizedBox(height: 10),
        if (c.rfid.supported)
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _toggleSweep,
              icon: Icon(_sweeping ? Icons.stop : Icons.nfc, size: 18),
              label: Text(_sweeping ? 'กำลังยิง… แตะเพื่อหยุด' : 'ยิงแท็ก RFID เพื่อเลือกกล่อง',
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
              style: OutlinedButton.styleFrom(
                foregroundColor: _sweeping ? C.red : C.ink,
                backgroundColor: _sweeping ? C.orangeBg : null,
                side: BorderSide(color: _sweeping ? C.orangeBorder : C.border2),
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ),
        const SizedBox(height: 14),
        if (q.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 4),
            child: Text('ยิงแท็ก/บาร์โค้ดของกล่อง หรือพิมพ์รหัสเพื่อค้นหา\nย้ายได้เฉพาะกล่องที่อยู่ในคลังเท่านั้น',
                style: TextStyle(fontSize: 13, color: C.faint, height: 1.5)),
          )
        else if (results.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 4),
            child: Text('ไม่พบกล่องในคลังที่ตรงกับ "$q"',
                style: TextStyle(fontSize: 13.5, color: C.red, fontWeight: FontWeight.w600)),
          )
        else
          Container(
            decoration: BoxDecoration(
              color: C.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: C.border),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: List.generate(results.length, (i) {
                final b = results[i];
                final l = b.location;
                final where = [l['zone'], l['rack'], l['shelf'], l['slot']]
                    .map((e) => (e ?? '').toString())
                    .where((e) => e.isNotEmpty)
                    .join(' · ');
                return InkWell(
                  onTap: () => _pick(b),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      border: i == results.length - 1 ? null : Border(bottom: BorderSide(color: C.border)),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.inventory_2_outlined, size: 18, color: C.muted),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(b.tag,
                                  style: const TextStyle(
                                      fontSize: 15, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
                              Text(
                                '${c.S!.typeName(b.type)}${where.isEmpty ? ' · ยังไม่ระบุตำแหน่ง' : ' · $where'}',
                                style: TextStyle(fontSize: 12, color: C.muted),
                              ),
                            ],
                          ),
                        ),
                        Icon(Icons.chevron_right, size: 18, color: C.chevron),
                      ],
                    ),
                  ),
                );
              }),
            ),
          ),
      ],
    );
  }

  // ── Step 2: where is it going ─────────────────────────────────────────
  Widget _placeBody(AppController c) {
    final bottom = MediaQuery.of(context).padding.bottom;
    final b = _target!;
    final cascade = _cascade;
    final wh = c.wh;
    final l = b.location;
    final from = [l['zone'], l['rack'], l['shelf'], l['slot']]
        .map((e) => (e ?? '').toString())
        .where((e) => e.isNotEmpty)
        .join(' · ');

    String? clamp(String? v, List<String> opts) => (v != null && opts.contains(v)) ? v : null;

    // Same rule as the receiving flow's putaway step: a level typed here has
    // to become a real Location Master row, not free text on this one box, or
    // it would never show up as an option anywhere else.
    Future<String?> addLevel(String field, String typed) async {
      final v = typed.toUpperCase();
      final zone = field == 'zone' ? v : _zone;
      final rack = field == 'rack' ? v : _rack;
      final shelf = field == 'shelf' ? v : _shelf;
      final slot = field == 'slot' ? v : _slot;
      final code = [zone, rack, shelf, slot].whereType<String>().where((s) => s.isNotEmpty).join('-');
      if (code.isEmpty) return null;
      try {
        await _c.api.createLocation(code: code, wh: wh, zone: zone, rack: rack, shelf: shelf, slot: slot);
        await _c.refresh();
        return v;
      } catch (e) {
        if (mounted) {
          _c.toastMsg('เพิ่มตำแหน่งไม่สำเร็จ', e is ApiException ? e.message : '', ResultKind.err);
        }
        return null;
      }
    }

    Widget dd(String label, String field, String? value, List<String> options,
        void Function(String?) onChanged) {
      return Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            FieldLabel(label),
            AddableDropdown(
              value: clamp(value, options),
              options: options,
              hint: '— ไม่ระบุ —',
              onChanged: onChanged,
              onAdd: (typed) => addLevel(field, typed),
            ),
          ],
        ),
      );
    }

    return ListView(
      padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
      children: [
        Panel(
          padding: const EdgeInsets.all(16),
          radius: 18,
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(b.tag,
                        style: const TextStyle(
                            fontSize: 20, fontWeight: FontWeight.w800, fontFamily: 'monospace')),
                    Text('${c.S!.typeName(b.type)} · จาก ${from.isEmpty ? "ยังไม่ระบุตำแหน่ง" : from}',
                        style: TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              TextButton(
                onPressed: _changeTarget,
                style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: Size.zero),
                child: Text('เปลี่ยนกล่อง',
                    style: TextStyle(fontSize: 12.5, color: C.orange, fontWeight: FontWeight.w700)),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Panel(
          padding: const EdgeInsets.all(16),
          radius: 18,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const FieldLabel('ตำแหน่งปลายทาง'),
              const SizedBox(height: 4),
              Row(
                children: [
                  dd('โซน', 'zone', _zone, cascade.zones(wh), (v) {
                    setState(() {
                      _zone = v;
                      _rack = null;
                      _shelf = null;
                      _slot = null;
                    });
                  }),
                  const SizedBox(width: 9),
                  dd('แร็ค', 'rack', _rack, cascade.racks(wh, _zone), (v) {
                    setState(() {
                      _rack = v;
                      _shelf = null;
                      _slot = null;
                    });
                  }),
                ],
              ),
              const SizedBox(height: 11),
              Row(
                children: [
                  dd('ชั้น', 'shelf', _shelf, cascade.shelves(wh, _zone, _rack), (v) {
                    setState(() {
                      _shelf = v;
                      _slot = null;
                    });
                  }),
                  const SizedBox(width: 9),
                  dd('ช่อง', 'slot', _slot, cascade.slots(wh, _zone, _rack, _shelf),
                      (v) => setState(() => _slot = v)),
                ],
              ),
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(_error!, style: TextStyle(fontSize: 12.5, color: C.red)),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _saving ? null : _save,
            style: FilledButton.styleFrom(
              backgroundColor: C.lime,
              foregroundColor: C.limeDeep,
              disabledBackgroundColor: C.neutralBg,
              disabledForegroundColor: C.faint,
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
            ),
            child: Text(_saving ? 'กำลังบันทึก…' : 'ยืนยันย้ายตำแหน่ง',
                style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
          ),
        ),
      ],
    );
  }
}
