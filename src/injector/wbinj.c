/* wbinj - minimal injector: wbinj.exe <pid> <dllpath>  (UTF-16 path, no CRT) */
#include "win32min.h"

typedef unsigned long long u64;

HANDLE WINAPI OpenProcess(DWORD, BOOL, DWORD);
LPVOID WINAPI VirtualAllocEx(HANDLE, LPVOID, SIZE_T, DWORD, DWORD);
BOOL   WINAPI WriteProcessMemory(HANDLE, LPVOID, LPCVOID, SIZE_T, SIZE_T*);
HANDLE WINAPI CreateRemoteThread(HANDLE, LPVOID, SIZE_T, LPVOID, LPVOID, DWORD, LPDWORD);
DWORD  WINAPI WaitForSingleObject(HANDLE, DWORD);
BOOL   WINAPI GetExitCodeThread(HANDLE, LPDWORD);
HMODULE WINAPI GetModuleHandleW(LPCWSTR);
void*  WINAPI GetProcAddress(HMODULE, LPCSTR);
BOOL   WINAPI CloseHandle(HANDLE);

static void (WINAPI* g_exit)(DWORD);
static void die(DWORD c) { g_exit(c); }

static LPCWSTR next_w(LPCWSTR p, WCHAR* out, int cap)
{
    int n = 0;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == '"') {
        p++;
        while (*p && *p != '"' && n < cap - 1) out[n++] = *p++;
        if (*p == '"') p++;
    } else {
        while (*p && *p != ' ' && *p != '\t' && n < cap - 1) out[n++] = *p++;
    }
    out[n] = 0;
    return p;
}

void wbinj_entry(void)
{
    WCHAR wpid[32], wdll[1024];
    DWORD pid = 0, tid = 0, code = 0;
    HANDLE hp, ht;
    HMODULE k32;
    void* ll;
    void* mem;
    SIZE_T wr = 0, n = 0;
    LPCWSTR p;
    LPCWSTR (WINAPI* g_cmdlinew)(void);

    k32 = GetModuleHandleW((LPCWSTR)L"kernel32.dll");
    if (!k32) for(;;){}
    g_exit = (void (WINAPI*)(DWORD))GetProcAddress(k32, (LPCSTR)"ExitProcess");
    g_cmdlinew = (LPCWSTR (WINAPI*)(void))GetProcAddress(k32, (LPCSTR)"GetCommandLineW");
    ll = GetProcAddress(k32, (LPCSTR)"LoadLibraryW");
    if (!g_exit || !g_cmdlinew || !ll) for(;;){}

    p = g_cmdlinew();
    { WCHAR skip[512]; p = next_w(p, skip, 512); }
    p = next_w(p, wpid, 32);
    p = next_w(p, wdll, 1024);
    { int i = 0; while (wpid[i]) { pid = pid * 10 + (DWORD)(wpid[i] - '0'); i++; } }
    while (wdll[n]) n++;
    if (!pid || !n) die(2);

    hp = OpenProcess(0x1F0FFF, 0, pid);
    if (!hp) die(5);
    mem = VirtualAllocEx(hp, 0, (n + 1) * 2, 0x3000, 0x04);
    if (!mem) { CloseHandle(hp); die(6); }
    if (!WriteProcessMemory(hp, mem, wdll, (n + 1) * 2, &wr)) { CloseHandle(hp); die(7); }
    ht = CreateRemoteThread(hp, 0, 0, ll, mem, 0, &tid);
    if (!ht) { CloseHandle(hp); die(8); }
    WaitForSingleObject(ht, 8000);
    GetExitCodeThread(ht, &code);
    CloseHandle(ht);
    CloseHandle(hp);
    die(code ? 0 : 9);
}