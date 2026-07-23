/// An offline gate transaction queued while the device was offline. Flushed to
/// the backend (`/api/gate/in` or `/api/gate/out`) once connectivity returns.
class OutboxTx {
  final String type; // 'in' | 'out'
  final List<String> tags;
  final int gate;
  final String wh;
  final String recorder;
  final String ts;

  // out-only
  final String? customer;
  final String? plate;
  final String? driver;

  // in-only
  final String? note;

  OutboxTx({
    required this.type,
    required this.tags,
    required this.gate,
    required this.wh,
    required this.recorder,
    required this.ts,
    this.customer,
    this.plate,
    this.driver,
    this.note,
  });

  Map<String, dynamic> toJson() => {
        'type': type,
        'tags': tags,
        'gate': gate,
        'wh': wh,
        'recorder': recorder,
        'ts': ts,
        if (customer != null) 'customer': customer,
        if (plate != null) 'plate': plate,
        if (driver != null) 'driver': driver,
        if (note != null) 'note': note,
      };

  factory OutboxTx.fromJson(Map<String, dynamic> j) => OutboxTx(
        type: j['type'] as String,
        tags: (j['tags'] as List).map((e) => e.toString()).toList(),
        gate: (j['gate'] as num).toInt(),
        wh: (j['wh'] ?? '').toString(),
        recorder: (j['recorder'] ?? '').toString(),
        ts: (j['ts'] ?? '').toString(),
        customer: j['customer']?.toString(),
        plate: j['plate']?.toString(),
        driver: j['driver']?.toString(),
        note: j['note']?.toString(),
      );
}
