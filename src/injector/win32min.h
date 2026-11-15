/*
 * win32min.h - the smallest Win32 surface this project needs.
 *
 * Why hand-rolled: the build machine that produced the shipped binaries has
 * MSVC but no Windows SDK, so <windows.h> is not available. Everything below
 * is just enough to declare the kernel32 entry points we call, plus a tiny
 * .def file (k32extra.def) so lib.exe can synthesise an import library.
 *
 * Keep this file ASCII-only: it is compiled under whatever code page the build
 * shell happens to use, and a stray non-ASCII byte turns into a hard error.
 */
#ifndef WHALEBRIDGE_WIN32MIN_H
#define WHALEBRIDGE_WIN32MIN_H

typedef unsigned long  DWORD;
typedef int            BOOL;
typedef unsigned char  BYTE;
typedef unsigned short WORD;
typedef void*          HANDLE;
typedef void*          HMODULE;
typedef void*          LPVOID;
typedef const void*    LPCVOID;
typedef const char*    LPCSTR;
typedef char*          LPSTR;
typedef const unsigned short* LPCWSTR;
typedef unsigned short* LPWSTR;
typedef unsigned short WCHAR;
typedef unsigned long long ULONGLONG;
typedef unsigned int   UINT;
typedef unsigned long* LPDWORD;
typedef unsigned long long SIZE_T;

#define WINAPI __stdcall
#define DLL_PROCESS_ATTACH 1
#define DLL_PROCESS_DETACH 0
#define INVALID_HANDLE_VALUE ((HANDLE)(long long)-1)
#define GENERIC_WRITE 0x40000000
#define GENERIC_READ  0x80000000
#define CREATE_ALWAYS 2
#define OPEN_ALWAYS   4
#define FILE_ATTRIBUTE_NORMAL 0x80
#define FILE_SHARE_READ  0x00000001
#define FILE_SHARE_WRITE 0x00000002
#define DONT_RESOLVE_DLL_REFERENCES 0x00000001
#define FALSE 0
#define TRUE  1

#ifdef __cplusplus
extern "C" {
#endif

HANDLE WINAPI CreateFileA(LPCSTR, DWORD, DWORD, LPVOID, DWORD, DWORD, HANDLE);
BOOL   WINAPI WriteFile(HANDLE, LPCVOID, DWORD, LPDWORD, LPVOID);
DWORD  WINAPI GetLastError(void);
BOOL   WINAPI SetLastError(DWORD);
BOOL   WINAPI CloseHandle(HANDLE);
DWORD  WINAPI GetCurrentProcessId(void);
BOOL   WINAPI DisableThreadLibraryCalls(HANDLE);

/* module / export resolution */
HMODULE WINAPI LoadLibraryW(LPCWSTR);
HMODULE WINAPI LoadLibraryExW(LPCWSTR, HANDLE, DWORD);
HMODULE WINAPI GetModuleHandleW(LPCWSTR);
BOOL    WINAPI GetModuleHandleExW(DWORD, LPCWSTR, HMODULE*);
void*   WINAPI GetProcAddress(HMODULE, LPCSTR);
HANDLE  WINAPI CreateThread(LPVOID, SIZE_T, DWORD (WINAPI*)(LPVOID), LPVOID, DWORD, LPDWORD);
void    WINAPI Sleep(DWORD);
LPVOID  WINAPI VirtualAlloc(LPVOID, SIZE_T, DWORD, DWORD);
BOOL    WINAPI VirtualFree(LPVOID, SIZE_T, DWORD);
DWORD   WINAPI GetModuleFileNameW(HMODULE, LPWSTR, DWORD);
BOOL    WINAPI VirtualProtect(LPVOID, SIZE_T, DWORD, DWORD*);
SIZE_T  WINAPI VirtualQuery(LPVOID, LPVOID, SIZE_T);
HANDLE WINAPI CreateFileW(LPCWSTR, DWORD, DWORD, LPVOID, DWORD, DWORD, HANDLE);
HANDLE WINAPI CreateNamedPipeW(LPCWSTR, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPVOID);
BOOL   WINAPI ConnectNamedPipe(HANDLE, LPVOID);
BOOL   WINAPI PeekNamedPipe(HANDLE, LPVOID, DWORD, LPDWORD, LPDWORD, LPDWORD);
BOOL   WINAPI DisconnectNamedPipe(HANDLE);
BOOL   WINAPI ReadFile(HANDLE, LPVOID, DWORD, LPDWORD, LPVOID);
BOOL   WINAPI FlushFileBuffers(HANDLE);
HANDLE WINAPI CreateEventW(LPVOID, BOOL, BOOL, LPCWSTR);
BOOL   WINAPI SetEvent(HANDLE);
DWORD  WINAPI WaitForSingleObject(HANDLE, DWORD);
DWORD  WINAPI GetTickCount(void);
DWORD  WINAPI SetFilePointer(HANDLE, long, long*, DWORD);
DWORD  WINAPI GetFileAttributesA(LPCSTR);
BOOL   WINAPI DeleteFileA(LPCSTR);

/* MEMORY_BASIC_INFORMATION for x64: 8 + 8 + 4(+4 pad) + 8 + 4 + 4 + 4(+4 pad).
   Spelled out as a struct so the kernel fills it at the right offsets. */
typedef struct {
    unsigned long long BaseAddress;
    unsigned long long AllocationBase;
    DWORD              AllocationProtect;
    DWORD              pad0;
    unsigned long long RegionSize;
    DWORD              State;
    DWORD              Protect;
    DWORD              Type;
    DWORD              pad1;
} MEMORY_BASIC_INFORMATION_LOCAL;

#define MEM_COMMIT 0x1000
#define MEM_IMAGE  0x1000000

#define PAGE_NOACCESS          0x01
#define PAGE_READONLY          0x02
#define PAGE_READWRITE         0x04
#define PAGE_WRITECOPY         0x08
#define PAGE_EXECUTE           0x10
#define PAGE_EXECUTE_READ      0x20
#define PAGE_EXECUTE_READWRITE 0x40
#define PAGE_EXECUTE_WRITECOPY 0x80

/* True when the address is committed and its page protection allows reading. */
static int readable_address(unsigned long long addr)
{
    MEMORY_BASIC_INFORMATION_LOCAL mbi;
    unsigned long long probe = addr & ~0xFFFull;
    SIZE_T r = VirtualQuery((LPVOID)probe, &mbi, sizeof(mbi));
    DWORD prot;
    if (!r) return 0;
    if (mbi.State != MEM_COMMIT) return 0;
    prot = mbi.Protect & 0xFF;
    if (mbi.Protect & PAGE_NOACCESS) return 0;
    if (prot == PAGE_NOACCESS) return 0;
    return prot == PAGE_READONLY || prot == PAGE_READWRITE || prot == PAGE_WRITECOPY
        || prot == PAGE_EXECUTE_READ || prot == PAGE_EXECUTE_READWRITE
        || prot == PAGE_EXECUTE_WRITECOPY || prot == PAGE_EXECUTE;
}

#ifdef __cplusplus
}
#endif

#endif
