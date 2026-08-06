/// An offline gate transaction queued while the device was offline. Flushed to
/// the backend (`/api/gate/in` or `/api/gate/out`) once connectivity returns.
class OutboxTx {
  final String type; // 'in' | 'out'
  final List<String> tags;
  final int gate;
  final String wh;
  final String recorder;

  /// Employee master id of whoever scanned this batch. Captured at scan time
  /// rather than at flush time — a queued batch belongs to the person who was
  /// holding the device then, not to whoever happens to be on shift when the
  /// network comes back.
  final String employeeId;
  final String ts;

  // out-only
  final String? customer;

  // vehicle info, captured on both directions
  final String? plate;
  final String? driver;
  final String? vehicleType;

  // in-only
  final String? note;

  /// in-only — tags the operator flagged 'hold' or 'damage' while scanning
  /// this batch in (see ScanScreen's per-box condition dropdown). A tag
  /// absent here just lands on 'warehouse' as normal.
  final Map<String, String>? conditions;

  OutboxTx({
    required this.type,
    required this.tags,
    required this.gate,
    required this.wh,
    required this.recorder,
    this.employeeId = '',
    required this.ts,
    this.customer,
    this.plate,
    this.driver,
    this.vehicleType,
    this.note,
    this.conditions,
  });

  Map<String, dynamic> toJson() => {
        'type': type,
        'tags': tags,
        'gate': gate,
        'wh': wh,
        'recorder': recorder,
        if (employeeId.isNotEmpty) 'employeeId': employeeId,
        'ts': ts,
        if (customer != null) 'customer': customer,
        if (plate != null) 'plate': plate,
        if (driver != null) 'driver': driver,
        if (vehicleType != null) 'vehicleType': vehicleType,
        if (note != null) 'note': note,
        if (conditions != null && conditions!.isNotEmpty) 'conditions': conditions,
      };

  factory OutboxTx.fromJson(Map<String, dynamic> j) => OutboxTx(
        type: j['type'] as String,
        tags: (j['tags'] as List).map((e) => e.toString()).toList(),
        gate: (j['gate'] as num).toInt(),
        wh: (j['wh'] ?? '').toString(),
        recorder: (j['recorder'] ?? '').toString(),
        employeeId: (j['employeeId'] ?? '').toString(),
        ts: (j['ts'] ?? '').toString(),
        customer: j['customer']?.toString(),
        plate: j['plate']?.toString(),
        driver: j['driver']?.toString(),
        vehicleType: j['vehicleType']?.toString(),
        note: j['note']?.toString(),
        conditions: (j['conditions'] as Map?)?.map((k, v) => MapEntry(k.toString(), v.toString())),
      );
}
