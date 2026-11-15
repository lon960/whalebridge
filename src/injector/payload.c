/*
 * payload.c - the DLL that gets injected into QQ.exe.
 *
 * It waits for QQNT.dll to appear, then overwrites one comment block in the
 * embedded Node source with a tiny JS payload. That payload makes Node load our
 * engine once its module loader is ready.
 *
 * Why a comment, and why this one:
 *   QQ signs resources\app\application.json, so package.json/app.asar cannot be
 *   edited on disk without the client refusing to start. The most benign thing
 *   we can touch is a block comment inside Node's own JS source, which is dead
 *   data at runtime and is guaranteed to be parsed before any app code runs.
 *
 * Anchor rules (v2.1):
 *   - do NOT depend on a fixed RVA or on the comment's exact wording/length
 *   - a patch is only applied when the comment is *immediately followed by*
 *     one of the loader markers below
 *   - slot length is measured at run time, so the payload only has to fit
 *
 * Search order: known RVA -> +-4MB window -> whole image.
 * Anything slower than the first step risks losing the race against Node boot.
 */
#include "win32min.h"

typedef unsigned long long u64;
typedef unsigned int u32;
typedef unsigned char u8;

#define KNOWN_RVA  0xb869804u
#define WIN_RADIUS 0x400000u
#define MAX_SLOT   4096
#define LOGPATH    "C:\\Windows\\Temp\\whalejs9.log"

static const char PAYLOAD[] =
    ";process.nextTick(function(){try{Module._load(process.env.WB_JS||\"C:/wb.js\")}catch(e){}})";

static const char* MARKERS[] = {
    "function wrapModuleLoad(request, parent, isMain)",
    "Module._load = function(request, parent, isMain)",
    "function Module._load(request, parent, isMain)",
};
#define NMARK ((int)(sizeof(MARKERS)/sizeof(MARKERS[0])))

static int slen(const char* s){ int n=0; while(s[n]) n++; return n; }
static int eqn(const u8* a, const char* b, int n){ int i; for(i=0;i<n;i++) if(a[i]!=(u8)b[i]) return 0; return 1; }
static int is_ws(u8 c){ return c==' '||c=='\t'||c=='\r'||c=='\n'; }

static void logmsg(const char* s)
{
    HANDLE h = CreateFileA(LOGPATH, GENERIC_WRITE, 3, 0, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD w = 0;
        SetFilePointer(h, 0, 0, 2);            /* SEEK_END: append, don't scribble over */
        WriteFile(h, s, (DWORD)slen(s), &w, 0);
        CloseHandle(h);
    }
}
static void loghex(const char* tag, u64 v)
{
    char b[64]; int n=0,i; const char* p=tag; static const char* H="0123456789abcdef";
    while(*p && n<24) b[n++]=*p++;
    b[n++]='=';
    for(i=60;i>=0;i-=4) b[n++]=H[(v>>i)&0xf];
    b[n++]='\n'; logmsg(b);
}

/* index of the marker at p, or -1 */
static int marker_at(u8* p, u8* hi)
{
    int i;
    for (i = 0; i < NMARK; i++) {
        int ml = slen(MARKERS[i]);
        if (p + ml >= hi) continue;
        if (eqn(p, MARKERS[i], ml)) return i;
    }
    return -1;
}

/* comment block that ends just before p (whitespace allowed in between) */
static u8* comment_before(u8* p, u8* lo, int* len)
{
    int i, hi;
    u8* e = p;
    u8* close;
    while (e > lo && is_ws(e[-1])) e--;
    if (e - lo < 2 || !(e[-2]=='*' && e[-1]=='/')) return 0;
    close = e - 2;
    hi = (int)(close - lo);
    if (hi > MAX_SLOT) hi = MAX_SLOT;
    for (i = 1; i < hi; i++) {
        u8* q = close - i;
        if (q[0]=='/' && q[1]=='*') { *len = (int)(e - q); return q; }
    }
    return 0;
}

static int fill(u8* slot, int len, const char* how)
{
    DWORD old = 0; int n = 0;
    if (len < slen(PAYLOAD)) return 0;
    if (!VirtualProtect(slot, (SIZE_T)len + 0x1000, PAGE_READWRITE, &old)) { logmsg("VPFAIL\n"); return 0; }
    while (PAYLOAD[n]) { slot[n] = (u8)PAYLOAD[n]; n++; }
    while (n < len) { slot[n] = ' '; n++; }
    VirtualProtect(slot, (SIZE_T)len + 0x1000, old, &old);
    loghex("at", (u64)slot);
    loghex("len", (u64)len);
    logmsg(how);
    return 1;
}

/* Anchor check: patch the comment in front of a loader marker. Returns 1 when written.
 * `hit` may point either at the comment start or at the marker itself. */
static int try_anchor(u8* hit, u8* lo, u8* hi, const char* how)
{
    int len = 0;
    u8* slot;
    if (hit[0]=='/' && hit[1]=='*') {
        /* walk to the end of THIS comment, then require a marker right after it */
        int n;
        for (n = 2; n < MAX_SLOT; n++) {
            u8* e;
            u8* q;
            if (hit + n + 1 >= hi) return 0;
            if (!(hit[n]=='*' && hit[n+1]=='/')) continue;
            e = hit + n + 2;
            q = e;
            while (q < hi && is_ws(*q)) q++;
            if (marker_at(q, hi) >= 0) return fill(hit, n + 2, how);
            return 0;                      /* a comment, but not the loader one */
        }
        return 0;
    }
    if (marker_at(hit, hi) >= 0) {
        slot = comment_before(hit, lo, &len);
        if (slot) return fill(slot, len, how);
    }
    return 0;
}

/* Cheap pre-filter so the image scan stays a couple hundred milliseconds. */
static int interesting(u8* p)
{
    u8 c = p[0];
    if (c == '/') return p[1] == '*';
    if (c == 'f') return p[1] == 'u' || p[1] == ' ';
    if (c == 'M') return p[1] == 'o';
    return 0;
}

static int scan(u8* lo, u8* hi, const char* how)
{
    u8* p;
    for (p = lo; p + 8 < hi; p++) {
        if (!interesting(p)) continue;
        if (try_anchor(p, lo, hi, how)) { loghex("hit_off", (u64)(p - lo)); return 1; }
    }
    return 0;
}

static DWORD WINAPI worker(LPVOID pv)
{
    int i;
    (void)pv;
    SetThreadPriority(GetCurrentThread(), 15); /* TIME_CRITICAL: beat Node's boot */
    logmsg("--- whalejs9 ---\n");
    for (i = 0; i < 1200; i++) {
        HMODULE m = GetModuleHandleW((LPCWSTR)L"QQNT.dll");
        if (m) {
            u8* base = (u8*)m;
            u32 lfanew = *(u32*)(base + 0x3C);
            u32 sizeImg = *(u32*)(base + lfanew + 80);
            u8* lo = base, *hi = base + sizeImg;

            loghex("qqnt", (u64)m);
            loghex("size", (u64)sizeImg);

            if (try_anchor(base + KNOWN_RVA, lo, hi, "PATCHED FAST\n")) return 0;

            if (scan((base + KNOWN_RVA > lo + WIN_RADIUS) ? base + KNOWN_RVA - WIN_RADIUS : lo,
                     (base + KNOWN_RVA + WIN_RADIUS < hi) ? base + KNOWN_RVA + WIN_RADIUS : hi,
                     "PATCHED WINDOW\n")) return 0;

            if (scan(lo, hi, "PATCHED SCAN\n")) return 0;

            logmsg("NO ANCHOR\n");
            return 0;
        }
        Sleep(3);
    }
    logmsg("NO QQNT.dll\n");
    return 0;
}

__declspec(dllexport) int WINAPI DllMain(HANDLE mod, DWORD reason, LPVOID res)
{
    (void)mod; (void)res;
    if (reason == 1) CreateThread(0, 0, worker, 0, 0, 0);
    return 1;
}

void* memset(void* d, int c, unsigned long long n)
{
    unsigned char* p = (unsigned char*)d;
    while (n--) *p++ = (unsigned char)c;
    return d;
}
