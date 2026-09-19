---
name: android-emulators
description: ADB helpers for the two local Android emulators used by the ui agent for visual checks.
---

# Android emulators (visual verification)

Two Android emulators are normally running, built and logged in:

- **Pixel_10_Pro_A** — account `a@a.com`, password `aaaaaaaa`
- **Pixel_10_Pro_B** — account `b@b.com`, password `bbbbbbbb`

Do not hardcode ADB serials — they change across restarts. Run `adb devices -l` first and match by AVD/product name.

```bash
adb devices -l
adb -s <serial> exec-out screencap -p > /tmp/ui-check.png   # then Read the PNG
adb -s <serial> shell uiautomator dump /sdcard/wd.xml && adb -s <serial> shell cat /sdcard/wd.xml
adb -s <serial> shell input tap <x> <y>
```

Only reach for emulators when you cannot otherwise tell whether an edit did what was asked — the human is usually watching hot-reload.
