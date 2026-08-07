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
