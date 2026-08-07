# PDA Flutter Build & Deployment Instructions

## 1. Rebuild All Services When Ready
ทุกครั้งที่ user พร้อม ต้องทำการ rebuild ทั้งหมด:

Every time the user is ready, rebuild all services:
- **Frontend** - `docker-compose build frontend --no-cache && docker-compose up -d frontend`
- **Backend** - `docker-compose build backend --no-cache && docker-compose up -d backend`
- **PDA Web** - `docker-compose build pda --no-cache && docker-compose up -d pda`
- **PDA Flutter App** - `flutter build apk --release` or `flutter build ios --release`

## 2. Workflow for PDA Flutter Changes
ถ้า user พิมพ์ให้แก้ไฟล์ pda_flutter ต้องทำตามขั้นตอน:

If the user asks to modify pda_flutter files, follow this workflow:
1. Make changes in the `pda` branch (brand pda)
2. Commit and push the changes to git
3. Create a pull request to merge into `main` branch
4. Review and merge to main

**Important:** Always work on the `pda` branch and merge to `main` - do not commit directly to main.

```bash
# Switch to pda branch
git checkout pda

# Make changes and commit
git add .
git commit -m "description"

# Push to remote
git push origin pda

# Create PR and merge to main (via GitHub or git merge)
```

## 3. Testing Requirement
ทุกครั้งที่แก้ไฟล์ใน pda_flutter ต้องทำ unit test ดังนี้:

Every time a pda_flutter file is changed, run these tests:
1. **Targeted test** - run/write the unit test that covers the specific code just edited
2. **Full PDA test suite** - run the entire pda_flutter test suite, not just the targeted test

```bash
cd pda_flutter

# Targeted test for the file just changed
flutter test test/<relevant_test_file>.dart

# Full test suite
flutter test
```

Do not consider a pda_flutter change complete until both pass.

## 4. Self-Recheck Requirement
หลังแก้ไขงานเสร็จทุกครั้ง ต้อง recheck งานที่ตัวเองเพิ่งแก้ แล้วรายงานเป็นข้อ ๆ ว่าจุดไหนผิดหรือมีปัญหา (ถ้าไม่มีก็ระบุว่าตรวจแล้วไม่พบปัญหา)

After finishing any edit, re-review the change just made and report findings as a numbered list — call out exactly what's wrong or risky, point by point. If nothing is wrong, state that explicitly rather than skipping the recheck.

## 5. Always Consult This File
ทุกครั้งที่มีการทำงานเกี่ยวกับ pda_flutter (ไม่ว่าจะแก้โค้ด, build, deploy) ต้องอ่านไฟล์นี้ก่อนทุกครั้ง

Every time work touches pda_flutter (editing code, building, or deploying), read this file first before proceeding.
