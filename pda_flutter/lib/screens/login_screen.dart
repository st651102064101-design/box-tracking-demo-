import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final top = MediaQuery.of(context).padding.top;
    final bottom = MediaQuery.of(context).padding.bottom;

    final items = c.users.map((u) {
      final name = (u['name'] ?? u['username'] ?? '').toString();
      final role = (u['role'] ?? 'staff').toString();
      // The backend uses "-" as its own placeholder for "unset" on several
      // fields (see StateSnapshot.whName etc.) — treat it as empty here too,
      // or every account with no real department shows a bare "· -".
      final deptRaw = u['dept']?.toString().trim() ?? '';
      final dept = deptRaw.isEmpty || deptRaw == '-' ? null : deptRaw;
      return {
        'name': name,
        'username': (u['username'] ?? '').toString(),
        'sub': '$role${dept != null ? ' · $dept' : ''}',
        'initials': name.trim().isEmpty ? '?' : name.trim().substring(0, 1),
      };
    }).toList();

    return Column(
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(22, top + 30, 22, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: const [
              Row(
                children: [
                  BrandMark(size: 42),
                  SizedBox(width: 11),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Wordmark(),
                      Text('เข้าสู่ระบบก่อนเริ่มกะ', style: TextStyle(fontSize: 12, color: C.muted)),
                    ],
                  ),
                ],
              ),
              SizedBox(height: 22),
              Text('เลือกพนักงาน\nผู้ปฏิบัติงาน',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700, letterSpacing: -0.6, height: 1.15)),
              SizedBox(height: 6),
              Text('ทุกการยิงเข้า–ออกจะบันทึกในชื่อผู้ที่ล็อกอิน',
                  style: TextStyle(fontSize: 13.5, color: C.muted)),
            ],
          ),
        ),
        if (!c.connected)
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 6, 22, 0),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
              decoration: BoxDecoration(
                color: C.orangeBg,
                borderRadius: BorderRadius.circular(15),
                border: Border.all(color: C.orangeBorder),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    c.connError == null
                        ? 'ยังไม่พบข้อมูลจากระบบหลัก BoxTrace — แตะปุ่มด้านล่างเพื่อตั้งค่าการเชื่อมต่อ'
                        : 'เชื่อมต่อไม่ได้: ${c.connError}',
                    style: const TextStyle(fontSize: 13, color: C.orange, fontWeight: FontWeight.w600, height: 1.45),
                  ),
                  const SizedBox(height: 9),
                  _smallOutline('ตั้งค่าการเชื่อมต่อ', () => c.go(Screen.settings)),
                ],
              ),
            ),
          ),
        Expanded(
          child: items.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      c.connected ? 'ยังไม่มีบัญชีพนักงานในระบบ' : 'รอเชื่อมต่อกับระบบหลักก่อน',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 13.5, color: C.faint),
                    ),
                  ),
                )
              : ListView(
                  padding: EdgeInsets.fromLTRB(22, 18, 22, bottom + 20),
                  children: items
                      .map((e) => Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: _EmployeeTile(
                              name: e['name']!,
                              sub: e['sub']!,
                              initials: e['initials']!,
                              onTap: () => _promptPassword(context, c, e['username']!, e['name']!),
                            ),
                          ))
                      .toList(),
                ),
        ),
      ],
    );
  }

  Widget _smallOutline(String label, VoidCallback onTap) => OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(
          foregroundColor: C.orange,
          side: const BorderSide(color: C.orangeBorder),
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
        ),
        child: Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
      );

  Future<void> _promptPassword(
    BuildContext context,
    AppController c,
    String username,
    String name,
  ) {
    return showDialog(
      context: context,
      builder: (_) => _PasswordDialog(controller: c, username: username, name: name),
    );
  }
}

/// Modal password gate shown after tapping an employee tile. Verifies against
/// the real account via `POST /api/auth/login` — a wrong password just shows
/// an inline error and stays open, it never falls back to a bypass.
class _PasswordDialog extends StatefulWidget {
  final AppController controller;
  final String username;
  final String name;
  const _PasswordDialog({required this.controller, required this.username, required this.name});

  @override
  State<_PasswordDialog> createState() => _PasswordDialogState();
}

class _PasswordDialogState extends State<_PasswordDialog> {
  final _pass = TextEditingController();
  final _focus = FocusNode();
  String? _error;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _pass.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final pw = _pass.text;
    if (pw.isEmpty || _submitting) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    final err = await widget.controller.loginAsEmployee(widget.username, pw);
    if (!mounted) return;
    if (err == null) {
      Navigator.of(context).pop();
    } else {
      setState(() {
        _submitting = false;
        _error = err;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.symmetric(horizontal: 26),
      child: ConstrainedBox(
        // Without this the dialog just fills (window width - insetPadding) —
        // fine on a phone, a wall of white on a wide desktop test window.
        constraints: const BoxConstraints(maxWidth: 380),
        child: Container(
        padding: const EdgeInsets.all(22),
        decoration: BoxDecoration(color: C.surface, borderRadius: BorderRadius.circular(20)),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: const BoxDecoration(color: C.neutralBg, shape: BoxShape.circle),
                  alignment: Alignment.center,
                  child: Text(
                    widget.name.trim().isEmpty ? '?' : widget.name.trim().substring(0, 1),
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: C.ink2),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(widget.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                      const Text('ใส่รหัสผ่านเพื่อเข้าสู่ระบบ', style: TextStyle(fontSize: 12, color: C.muted)),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),
            TextField(
              controller: _pass,
              focusNode: _focus,
              obscureText: true,
              autofocus: true,
              onSubmitted: (_) => _submit(),
              decoration: pdaInput('รหัสผ่าน'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(fontSize: 12.5, color: C.red, fontWeight: FontWeight.w600)),
            ],
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _submitting ? null : () => Navigator.of(context).pop(),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: C.ink2,
                      side: const BorderSide(color: C.border2),
                      padding: const EdgeInsets.symmetric(vertical: 13),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
                    ),
                    child: const Text('ยกเลิก', style: TextStyle(fontWeight: FontWeight.w600)),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    onPressed: _submitting ? null : _submit,
                    style: FilledButton.styleFrom(
                      backgroundColor: C.ink,
                      padding: const EdgeInsets.symmetric(vertical: 13),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
                    ),
                    child: _submitting
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : const Text('เข้าสู่ระบบ', style: TextStyle(fontWeight: FontWeight.w600)),
                  ),
                ),
              ],
            ),
          ],
        ),
        ),
      ),
    );
  }
}

class _EmployeeTile extends StatelessWidget {
  final String name, sub, initials;
  final VoidCallback onTap;
  const _EmployeeTile({required this.name, required this.sub, required this.initials, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: C.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: C.border),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 2, offset: const Offset(0, 1))],
          ),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: const BoxDecoration(color: C.neutralBg, shape: BoxShape.circle),
                alignment: Alignment.center,
                child: Text(initials,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: C.ink2)),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: C.ink)),
                    Text(sub,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12.5, color: C.muted)),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: C.chevron, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}
