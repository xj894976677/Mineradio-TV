// The one native function of Mineradio TV: start Node (libnode.so, nodejs-mobile) on the calling
// thread with the given arguments. node::Start returns when the script ends.
//
// Built without a C library, so it links against libnode.so alone: see build.sh.
#include <jni.h>

// int node::Start(int argc, char** argv)
extern int node_start(int argc, char **argv) __asm__("_ZN4node5StartEiPPc");

#define MAX_ARGS 16
#define ARG_BYTES 16384
// libuv wants argv in one contiguous block, each string right after the one before.
static char arg_block[ARG_BYTES];
static char *arg_vector[MAX_ARGS + 1];

JNIEXPORT jint JNICALL
Java_tv_mineradio_app_NodeBridge_startNode(JNIEnv *env, jclass clazz, jobjectArray args) {
    (void) clazz;
    jsize count = (*env)->GetArrayLength(env, args);
    if (count > MAX_ARGS) count = MAX_ARGS;
    jsize used = 0;
    int argc = 0;
    for (jsize i = 0; i < count; i++) {
        jstring s = (jstring) (*env)->GetObjectArrayElement(env, args, i);
        if (!s) continue;
        jsize bytes = (*env)->GetStringUTFLength(env, s);
        jsize chars = (*env)->GetStringLength(env, s);
        if (used + bytes + 1 > ARG_BYTES) return -2;
        (*env)->GetStringUTFRegion(env, s, 0, chars, arg_block + used);
        arg_block[used + bytes] = 0;
        arg_vector[argc++] = arg_block + used;
        used += bytes + 1;
        (*env)->DeleteLocalRef(env, s);
    }
    arg_vector[argc] = 0;
    return node_start(argc, arg_vector);
}
