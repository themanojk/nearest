# NearNest ESP-IDF firmware

This project builds the existing `NearNestFirmware` Arduino implementation as
an ESP-IDF application with Arduino as a managed component. The Arduino sketch
remains the single source of truth and can still be opened in Arduino IDE.

## First build

```bash
source ~/esp/esp-idf-v5.5.4/export.sh
cd NearNestFirmwareIdf
idf.py set-target esp32
idf.py build
```

Run the `source` command once in every new terminal before using `idf.py`.
Managed Arduino and ArduinoJson dependencies are downloaded automatically on
the first build.

## Find the serial port, flash, and monitor

Connect the ESP32 over USB, then list likely macOS serial ports:

```bash
ls /dev/cu.usbserial* /dev/cu.SLAB_USBtoUART* /dev/cu.wchusbserial* 2>/dev/null
```

Use the port that exists on your machine:

```bash
idf.py -p /dev/cu.usbserial-0001 flash monitor
```

Exit the monitor with `Ctrl+]`. For later source changes, `idf.py build` and
the same flash command are sufficient.

## Migration and performance notes

- The custom partition table exactly matches the Arduino IDE `min_spiffs`
  layout, including both OTA application slots.
- Do not run `idf.py erase-flash` during migration. NVS holds the recording
  sequence and BLE bonding state.
- The IDF defaults use the 240 MHz CPU, Wi-Fi IRAM optimizations, a 12-frame
  receive block-ack window, and 16 KB TCP send/receive windows for SoftAP file
  transfer.
- Bluetooth uses the ESP-IDF controller with the existing NimBLE-Arduino host;
  the duplicate Bluedroid host is disabled to conserve RAM.
- The generated firmware image is `build/nearnest_firmware.bin`.

## Physical transfer test status

The current flashed implementation uses hybrid UDP transfer with TCP repair.
Short 10 MiB recording trials reached approximately 1.2–1.39 MiB/s, compared
with approximately 0.74 MiB/s before the SD/UDP pipeline changes. The UDP RAM
benchmark reaches approximately 2.3–2.6 MiB/s, so the remaining limit is the
SPI SD path.

The required minimum of 1.5 MiB/s needs an SDMMC hardware migration. ESP32
slot 1 uses CLK GPIO14, CMD GPIO15, DAT0 GPIO2, DAT1 GPIO4, DAT2 GPIO12, and
DAT3 GPIO13. One-bit mode needs only CLK, CMD, and DAT0; four-bit mode is
preferred when all data lines are exposed. The firmware must remain in SPI
mode until the card socket is rewired.
