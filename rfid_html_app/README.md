# rfid_html_app — หน้า HTML 1 input รับ RFID จาก MC3390R แบบไม่มี delay

หน้าเว็บอยู่ที่ [rfid_test/index.html](../rfid_test/index.html) ไฟล์เดียว ใช้ได้ 2 ทาง:

| โหมด | ใครป้อนข้อมูล | delay ต่อ tag | ยิงรัวต่อเนื่อง |
|---|---|---|---|
| **A — เปิดในเบราว์เซอร์** | DataWedge keystroke output | ผ่าน IME (~10–50 ms/tag) | ได้ แต่ช้ากว่า |
| **B — เปิดในแอปนี้** | Zebra RFIDAPI3 SDK ตรง ๆ | ไม่มี | ได้เต็มความเร็วเครื่องอ่าน |

## ทำไมต้องมีแอป

หน้าเว็บที่รันในเบราว์เซอร์ **เข้าถึง Zebra RFID SDK ไม่ได้เลย** — ไม่ใช่เรื่องขอ
permission แล้วจะได้ เพราะ SDK เป็น Java library ที่คุยกับ service บนเครื่อง
ไม่ใช่ web API ที่เบราว์เซอร์ expose ให้ ทางเดียวที่เบราว์เซอร์รับได้คือ
DataWedge keystroke ซึ่งวิ่งผ่านคีย์บอร์ด นั่นแหละคือที่มาของ delay

แอปนี้จึงเป็น WebView บาง ๆ ที่โหลด `index.html` ตัวเดิม แล้วยิง tag เข้า JS
ตรงจาก callback ของ SDK — ไม่ผ่านคีย์บอร์ด ไม่มี delay

## Build / ติดตั้ง

```bash
cd rfid_html_app
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

APK ~6.9 MB ใช้ไฟล์ SDK `.aar` ชุดเดียวกับ `pda_flutter/android/app/libs`
(อ้างอิงตรงจากที่นั่น ไม่ได้ copy ซ้ำ เพื่อไม่ให้ SDK สองแอปเวอร์ชันเพี้ยนกัน)

Debug หน้าเว็บได้ผ่าน `chrome://inspect` เสียบ USB

## ใช้งาน

เปิดแอป → กด **เชื่อมต่อ** (ปกติต่อเองอัตโนมัติตอนเปิด) → เหนี่ยวไกค้างไว้
tag จะไหลเข้า input ตัวเดียวบนจอต่อเนื่อง พร้อมตัวเลข reads / unique /
tags-per-second / ระยะห่างระหว่างการอ่าน (ms) สำหรับดูว่ามี delay จริงไหม

- **ซ้ำไม่นับ** — กรอง EPC ซ้ำออก (ปิดไว้ถ้าอยากวัดความถี่การยิงจริง)
- **เสียง** — บี๊บผ่าน WebAudio ในหน้าเว็บ ไม่ได้บี๊บใน thread ของ SDK
  เพราะ `ToneGenerator` ใน `eventReadNotify` จะไปหน่วง event ถัดไป

## ถ้าจะใช้โหมด A (เบราว์เซอร์ + DataWedge)

ตั้งค่า DataWedge profile ให้ผูกกับเบราว์เซอร์ แล้ว:

- **Keystroke output → Enabled**
- **Action key character → Enter** (หน้าเว็บใช้ Enter เป็นตัวจบ 1 tag
  ไม่ได้ใช้ timer รอ ซึ่งจะกลายเป็น delay คงที่ต่อ tag)
- **Inter character delay → 0 ms**, **Inter key delay → 0 ms**
- **RFID input → Enabled**, Trigger mode = continuous / hold

แล้วเปิด `index.html` (ไฟล์ในเครื่อง หรือ serve จากที่ไหนก็ได้) — หน้าเว็บ
ตรวจเองว่าไม่มี native bridge แล้วสลับไปโหมด keystroke อัตโนมัติ

## หมายเหตุที่ตั้งใจตัดออก

- **ไม่อ่าน TID** — การอ่าน TID ต้อง `Inventory.stop()` เพื่อรัน access
  operation แล้วค่อยเริ่มใหม่ ทำให้เกิดช่องว่างหลักสิบ ms ระหว่าง tag
  ซึ่งขัดกับจุดประสงค์ของหน้านี้ (ถ้าต้องการ TID ดู
  `pda_flutter/.../RfidReaderController.kt`)
- **Session S0 / state A** — tag เดิมถูกรายงานซ้ำได้เรื่อย ๆ ตราบใดที่ยัง
  อยู่ในสนาม จึงเกิดสตรีมต่อเนื่องขณะเหนี่ยวไกค้าง
