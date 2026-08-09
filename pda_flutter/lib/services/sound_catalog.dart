/// Display side of the "which sound plays on a detection" catalog — the
/// native side (RfidReaderController.kt's `playSoundIdBlocking`) is the
/// playback side. The two id sets have to be kept in sync by hand; there is
/// no shared source of truth across the platform channel for something this
/// small.
class SoundOption {
  final String id;
  final String name;
  const SoundOption(this.id, this.name);
}

/// Every sound either the RFID or barcode channel can be set to. Order here
/// is display order in the picker.
const kSoundCatalog = <SoundOption>[
  SoundOption('html_tick', 'ติ๊ด (เหมือนแอป RFID HTML)'),
  SoundOption('classic_beep', 'ติ๊ดคลาสสิก'),
  SoundOption('classic_ack', 'ติ๊ดรับทราบ'),
  SoundOption('soft_tick', 'ติ๊กนุ่ม'),
  SoundOption('high_tick', 'ติ๊ดแหลม'),
  SoundOption('low_tick', 'ติ๊ดทุ้ม'),
  SoundOption('double_tick', 'ติ๊ดคู่'),
  SoundOption('ping', 'ปิ๊ง'),
  SoundOption('none', 'ไม่มีเสียง'),
];

String soundNameFor(String id) => kSoundCatalog
    .firstWhere((s) => s.id == id, orElse: () => kSoundCatalog.first)
    .name;
