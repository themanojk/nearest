file(GLOB_RECURSE CRYPTO_SOURCES "src/*.cpp")

idf_component_register(
    SRCS ${CRYPTO_SOURCES}
    INCLUDE_DIRS "src"
    REQUIRES arduino-esp32 nvs_flash
)
