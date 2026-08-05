/// One row of the WMS employee master (`S.employees`), as the PDA sees it.
///
/// This master — maintained in the BoxTrace web app's "พนักงาน" page — is the
/// *only* place people are managed. The PDA deliberately does not have its own
/// accounts: an operator is a row here plus the badge they carry, so adding,
/// suspending, or removing someone is one edit in one screen with no password
/// to issue and nothing to reset.
class Employee {
  final String id;
  final String name;
  final String role;
  final String dept;
  final String wh;
  final String shift;

  /// Value printed on the employee's badge (QR/barcode) or written to their
  /// RFID card. Matched against whatever the reader hands us.
  final String scanCode;

  /// 'operator' | 'supervisor' | 'admin' | 'viewer' — the same vocabulary the
  /// web app's EMP_ACCESS map uses.
  final String access;

  /// 'active' | 'leave' | 'inactive'
  final String status;

  /// Whether this employee has a PIN on file on the *backend* — the source of
  /// truth for the PIN gate, never a device-local flag (a PIN set on one PDA
  /// must be asked for on every other PDA too).
  final bool hasPin;

  const Employee({
    required this.id,
    required this.name,
    this.role = '',
    this.dept = '',
    this.wh = '',
    this.shift = '',
    this.scanCode = '',
    this.access = 'operator',
    this.status = 'active',
    this.hasPin = false,
  });

  /// The web app writes '-' into several fields as its own placeholder for
  /// "unset", so treat that as empty rather than rendering a bare "· -".
  static String _s(dynamic v, [String fallback = '']) {
    final s = (v ?? '').toString().trim();
    if (s.isEmpty || s == '-') return fallback;
    return s;
  }

  factory Employee.fromJson(Map<String, dynamic> j) => Employee(
        id: _s(j['id']),
        name: _s(j['name']),
        role: _s(j['role']),
        dept: _s(j['dept']),
        wh: _s(j['wh']),
        shift: _s(j['shift']),
        scanCode: _s(j['scanCode']),
        access: _s(j['access'], 'operator'),
        status: _s(j['status'], 'active'),
        hasPin: j['hasPin'] == true,
      );

  /// Employees on leave or off the payroll can't start a session. This is the
  /// off-switch a supervisor already has in the WMS, now with teeth on the PDA.
  bool get active => status == 'active';

  /// Viewers may look boxes up but never record a movement.
  bool get canScan => access != 'viewer';

  /// Supervisors may re-point the device at another gate or edit its
  /// connection — the only things on the PDA worth gating.
  bool get isSupervisor => access == 'supervisor' || access == 'admin';

  /// Gates the hardware-debug tiles in Settings (raw RFID reads, the backend
  /// URL) — low-level values a regular operator has no use for and that only
  /// add noise/confusion to their screen.
  bool get isAdmin => access == 'admin';

  /// What is actually printed on this person's badge. The WMS fills `scanCode`
  /// in with the employee id when it is left blank, but records created before
  /// that never got one — so fall back to the id here too, or everyone already
  /// on file would be unable to badge in until someone re-saved them.
  String get badgeCode => scanCode.isNotEmpty ? scanCode : id;

  /// Badge codes are matched case-insensitively: a printed QR read by the
  /// imager and the same value typed into the WMS shouldn't disagree over case.
  bool matchesCode(String code) {
    final c = code.trim().toUpperCase();
    final badge = badgeCode.toUpperCase();
    return c.isNotEmpty && badge.isNotEmpty && badge == c;
  }

  String get initials => name.trim().isEmpty ? '?' : name.trim().substring(0, 1);

  /// "หัวหน้าคลัง · คลังสินค้า" — omitting whichever half is unset.
  String get subtitle => [role, dept].where((s) => s.isNotEmpty).join(' · ');
}
