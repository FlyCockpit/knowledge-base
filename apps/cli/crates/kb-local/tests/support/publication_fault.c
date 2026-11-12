// Native fault fixture: keeps real Git, SQLite, OS locks and filesystem I/O.
// A per-test control file arms exactly one syscall target after fixture setup.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fault(int fd) {
    char mode[32], target[4096], path[4096], link[64];
    FILE *control = fopen(R52_CONTROL, "r");
    if (!control) return 0;
    int parsed = fscanf(control, "%31s\n%4095[^\n]", mode, target);
    fclose(control);
    if (parsed != 2) return 0;
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, path, sizeof(path)-1);
    if (n < 0) return 0;
    path[n] = 0;
    struct stat meta;
    if (fstat(fd, &meta) != 0) return 0;
    int matches = strcmp(mode, "object") == 0
        ? S_ISREG(meta.st_mode) && strstr(path, target) && strstr(path, "/objects/")
        : strcmp(path, target) == 0;
    if (!matches) return 0;
    int marker = open(R52_MARKER, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (marker >= 0) {
        dprintf(marker, "%s %s\n", mode, path);
        close(marker);
    }
    if (strcmp(mode, "park") == 0) {
        // The parent kills this recorded Git PID while its actual ref lock
        // exists and the inherited store fence is still held.
        marker = open(R52_PID, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (marker >= 0) { dprintf(marker, "%d\n", getpid()); close(marker); }
        for (int i=0; i<12000; ++i) usleep(10000);
    }
    errno = EIO;
    return -1;
}

int fsync(int fd) {
    if (fault(fd)) return -1;
    int (*real_sync)(int) = dlsym(RTLD_NEXT, "fsync");
    return real_sync(fd);
}

int fdatasync(int fd) {
    if (fault(fd)) return -1;
    int (*real_sync)(int) = dlsym(RTLD_NEXT, "fdatasync");
    return real_sync(fd);
}
