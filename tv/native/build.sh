#!/usr/bin/env bash
# Builds app/src/main/jniLibs/arm64-v8a/libnodebridge.so from node_bridge.c.
#
# Needs: a clang that targets aarch64 (any LLVM clang), an ELF lld, the NDK's jni.h, and
# nodejs-mobile's libnode.so to link against. With the Android NDK installed:
#   NDK=$ANDROID_HOME/ndk/<version>
#   CLANG=$NDK/toolchains/llvm/prebuilt/*/bin/clang  LLD=$NDK/toolchains/llvm/prebuilt/*/bin/ld.lld
#   JNI_INCLUDE=$NDK/toolchains/llvm/prebuilt/*/sysroot/usr/include
# libnode.so and libc++_shared.so (from the NDK: libnode needs it) go in the same jniLibs folder;
# they are not in the repository (62 MB): see tv/README.md.
set -euo pipefail
cd "$(dirname "$0")"
: "${CLANG:?}" "${LLD:?}" "${JNI_INCLUDE:?}"
OUT=../app/src/main/jniLibs/arm64-v8a
[ -f "$OUT/libnode.so" ] || { echo "put nodejs-mobile's arm64-v8a libnode.so in $OUT first" >&2; exit 1; }
"$CLANG" --target=aarch64-linux-android24 -ffreestanding -fPIC -O2 -Wall -I"$JNI_INCLUDE" -c node_bridge.c -o node_bridge.o
"$LLD" -shared -soname libnodebridge.so --hash-style=both -z max-page-size=16384 -o "$OUT/libnodebridge.so" node_bridge.o "$OUT/libnode.so"
rm -f node_bridge.o
echo "built $OUT/libnodebridge.so"
