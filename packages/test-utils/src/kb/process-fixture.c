/* Linux test-only ownership: acquire once, then signal only through pidfd. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int pid = atoi(argv[1]);
  if (pid <= 0) return 2;
  int fd = syscall(SYS_pidfd_open, pid, 0);
  if (fd < 0) {
    if (errno == ESRCH) { puts("STALE"); return 0; }
    perror("pidfd_open"); return 1;
  }
  /* Validate after acquisition. Even if /proc now describes a successor,
     a mismatch closes the handle without signaling either process. */
  struct stat pinned, current;
  if (fstat(3, &pinned) != 0) { close(fd); return 1; }
  char directory[64];
  snprintf(directory, sizeof(directory), "/proc/%d", pid);
  if (stat(directory, &current) != 0 || pinned.st_dev != current.st_dev || pinned.st_ino != current.st_ino) {
    close(fd); puts("STALE"); return 0;
  }
  int stat_fd = openat(3, "stat", O_RDONLY);
  FILE *stat = stat_fd < 0 ? NULL : fdopen(stat_fd, "r");
  char *line = NULL;
  size_t size = 0;
  char *start = NULL;
  if (stat && getline(&line, &size, stat) > 0) {
    char *last = strrchr(line, ')');
    char *save = NULL;
    if (last) {
      char *field = strtok_r(last + 1, " \n", &save);
      for (int n = 3; field && n < 22; n++) field = strtok_r(NULL, " \n", &save);
      start = field;
    }
  }
  int matches = start && strcmp(start, argv[2]) == 0;
  free(line);
  if (stat) fclose(stat);
  if (!matches) { close(fd); puts("STALE"); return 0; }
  puts("READY");
  fflush(stdout);
  struct pollfd waits[2] = {{fd, POLLIN, 0}, {STDIN_FILENO, POLLIN | POLLHUP, 0}};
  for (;;) {
    int result = poll(waits, 2, -1);
    if (result < 0 && errno == EINTR) continue;
    if (result < 0) { perror("poll"); close(fd); return 1; }
    /* Natural exit retires ownership before any cleanup command. */
    if (waits[0].revents) { close(fd); return 0; }
    if (waits[1].revents) break;
  }
  if (syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0) < 0 && errno != ESRCH) {
    perror("pidfd_send_signal"); close(fd); return 1;
  }
  int drained;
  do { drained = poll(waits, 1, 15000); } while (drained < 0 && errno == EINTR);
  close(fd);
  return drained > 0 ? 0 : 1;
}
