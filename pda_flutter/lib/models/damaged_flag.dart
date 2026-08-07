/// One "this box is damaged" report captured on the floor, independent of
/// whether the terminal had a signal at the time. Mirrors [OutboxTx]'s own
/// shape/reasoning (see outbox_tx.dart) — a small JSON-serializable record
/// kept in [Prefs.damagedFlags] until [AppController.flushDamagedFlags]
/// gets it to the server, plus enough identity (`id`) to update it in place
/// once that succeeds instead of appending a duplicate.
class DamagedFlag {
  /// Locally-generated, stable for the life of this record — lets a retry
  /// or a resumed sync find and update the same entry rather than filing it
  /// twice.
  final String id;

  /// The box's own barcode (1D/2D), scanned rather than typed — the thing
  /// a warehouse worker can actually read off a damaged box.
  final String barcode;

  /// Every distinct RFID EPC the sweep picked up while this report was
  /// open — "batch" here because a damaged pallet's tags all get flagged
  /// together in one sweep rather than one scan-and-save cycle per tag.
  final List<String> rfidEpcs;

  final String note;
  final DateTime createdAt;

  /// True once the server has this record — kept (not deleted) after sync
  /// so the "แจ้งแล้ว" history on this device still shows it happened,
  /// same reasoning as OutboxTx staying visible after a flush.
  final bool synced;

  const DamagedFlag({
    required this.id,
    required this.barcode,
    required this.rfidEpcs,
    required this.note,
    required this.createdAt,
    this.synced = false,
  });

  DamagedFlag copyWith({bool? synced}) => DamagedFlag(
        id: id,
        barcode: barcode,
        rfidEpcs: rfidEpcs,
        note: note,
        createdAt: createdAt,
        synced: synced ?? this.synced,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'barcode': barcode,
        'rfidEpcs': rfidEpcs,
        'note': note,
        'createdAt': createdAt.toIso8601String(),
        'synced': synced,
      };

  factory DamagedFlag.fromJson(Map<String, dynamic> j) => DamagedFlag(
        id: j['id'] as String,
        barcode: j['barcode'] as String? ?? '',
        rfidEpcs: (j['rfidEpcs'] as List?)?.whereType<String>().toList() ?? const [],
        note: j['note'] as String? ?? '',
        createdAt: DateTime.tryParse(j['createdAt'] as String? ?? '') ?? DateTime.now(),
        synced: j['synced'] as bool? ?? false,
      );
}
