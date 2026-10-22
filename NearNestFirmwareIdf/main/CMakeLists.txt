get_filename_component(
  NEARNEST_ARDUINO_SOURCE
  "${CMAKE_CURRENT_LIST_DIR}/../../NearNestFirmware"
  ABSOLUTE
)

file(GLOB NEARNEST_SHINE_SOURCES "${NEARNEST_ARDUINO_SOURCE}/src/shine/*.c")

idf_component_register(
  SRCS
    ${NEARNEST_SHINE_SOURCES}
    "main.cpp"
    "${NEARNEST_ARDUINO_SOURCE}/NearNestConnectivity.cpp"
  INCLUDE_DIRS
    "."
    "${NEARNEST_ARDUINO_SOURCE}"
  REQUIRES
    arduino-esp32
    arduinojson
    crypto_arduino
    nimble_arduino
    tinygpsplus
)
