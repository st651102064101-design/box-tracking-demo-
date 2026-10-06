# RFID radar calibration and gate metadata

Gate scans resolve EPC against existing box codes (including zero-padded ASCII EPCs). No association workflow is added. Metadata never changes box RFID bindings or gate status.

The controller deduplicates a box within each SDK batch and skips accepted queue entries on subsequent batches. A test drives 1,000 repeated reads twice through each gate direction and verifies one UI notification, one metadata row and one gate API call, including concurrent submit and a blocked metadata endpoint.

Metadata is queued separately (maximum 256 identities, batches of 64). After trigger release, one optional TID-header access is attempted while inventory is idle and the UI still selects RFID. Access timeout is 300 ms. Unknown EPCs, barcode mode and live inventory cannot invoke this access. Failed metadata requests retry at the next idle/submit opportunity. EPC metadata is saved even when TID is unavailable.

Authenticated APIs:

- `POST /api/rfid/radar/observe`: `{observations:[{epc,tag,model,powerPercent,readerProfile,tid?,referenceRssi?,weakestRssi?}]}`; at most 64 observations, gate permissions required.
- `GET /api/rfid/radar/profile?epc=...&model=...&powerPercent=100&readerProfile=radar`: own reference, then chip-family reference, then default.

Profiles use separate `app_settings` keys and survive full-state replacement. Scope is EPC/chip family + reader model + transmit-power percentage + RF profile. Gate and radar RF anchors are distinct. Tag identity metadata links chip-family information learned at a gate to radar search. A changed chip family invalidates the old tag reference. Group defaults are first-calibration-wins; a later individual calibration overrides the default for that tag.

The chip family is the first 32 bits of an E2 TID header. This identifies chip/capability families, not antenna/inlay construction and not a unique physical tag serial. Different inlays can share the same chip family. Replacing a tag with another of the same family and EPC cannot be detected from this header alone.

Calibration is voluntary. User confirms standing approximately one metre away; the app samples for three seconds. At most one sample per 50 ms is retained. At least eight valid samples across one second are required, and the 10–90 percentile spread must be <=12 dB. The median becomes the reference. Sparse, duplicate-only, unstable, wrong-EPC and invalid-RSSI windows are rejected.

Displayed metres use a backscatter heuristic anchored to the saved RSSI (default -60 dBm at one metre). Values remain approximate. Weakest observed RSSI records the furthest estimated detection seen, not a measured physical maximum. Orientation, shielding and multipath still affect estimates.

Radar selects the lowest supported positive backscatter data rate and max supported transmit power; gate screens restore the fast profile. Existing AB-flip inventory, disabled DPO and DB filtering remain. Unsupported Locate falls back to normal inventory RSSI. Tone is 30 ms at a constant pitch; pulse intervals vary continuously from 1200 to 60 ms with filtered signal.

## Device checks still required

1. MC3390R: alternate Barcode/RFID on Gate In and Gate Out; verify imager/antenna ownership and one accepted result per physical box.
2. Scan multiple known tags and a foreign tag: only DB boxes enter the queue. Release/press rapidly; optional TID access must not delay the screen or switch scanners.
3. Confirm metadata in DB after gate release; unreadable TID must not block a gate commit.
4. At radar, confirm the target, stand about one metre away and voluntarily calibrate. Leave during capture: no later callback may stop scanning on another page.
5. Reopen radar and test a second EPC with the same TID header; it uses the saved family default. Other reader model/power/RF profiles must use independent anchors.
6. Walk away and return with several tag orientations. Check smooth cadence, estimated metres and stale-signal silence. Real radio range, sensitivity and acoustic timing require hardware testing.

SDK reference: [Zebra Read Access](https://techdocs.zebra.com/dcs/rfid/android/2-0-5-275/tutorials/readaccess/).
