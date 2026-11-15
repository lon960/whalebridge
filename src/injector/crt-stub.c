/*
 * Minimal CRT stand-ins for /NODEFAULTLIB builds.
 *
 * The compiler emits calls to these even when no CRT is linked: memcpy for
 * struct copies, __chkstk for stack probing in functions with large frames.
 * Without them the link fails with LNK2019.
 *
 * __chkstk here is a no-op, which is only safe because every probe in this
 * project keeps large buffers static. A large stack frame plus a no-op probe
 * will walk straight into the guard page and take the process down.
 */
void* memcpy(void* dst, const void* src, unsigned long long n)
{
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    unsigned long long i;
    for (i = 0; i < n; i++) d[i] = s[i];
    return dst;
}

void __chkstk(void) { }
