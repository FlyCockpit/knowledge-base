/*
 * Parent-death guard for the forked Qwen model child.
 *
 *   kb-child-guard <expected-parent-pid> <program> [args...]
 *
 * Arms PR_SET_PDEATHSIG=SIGKILL, closes the fork/prctl race by re-checking the
 * parent PID, then execs <program> in place (same PID, inherited IPC fd). If
 * the worker parent dies for any reason — including SIGKILL, where no Node
 * handler runs — the kernel kills the model child, so a native addon can never
 * outlive its supervisor. Linux only: the worker image is Debian glibc.
 *
 * Errors print fixed text only — never argv or environment values.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

#ifndef __linux__
#error "kb-child-guard requires Linux PR_SET_PDEATHSIG"
#endif

static int parse_pid(const char *text, pid_t *out) {
	char *end = NULL;
	errno = 0;
	long value = strtol(text, &end, 10);
	if (errno != 0 || end == text || *end != '\0' || value < 1 || value > 0x3fffffffL)
		return -1;
	*out = (pid_t)value;
	return 0;
}

int main(int argc, char **argv) {
	pid_t expected;
	if (argc < 3 || parse_pid(argv[1], &expected) != 0) {
		fputs("kb-child-guard: usage: kb-child-guard <parent-pid> <program> [args...]\n", stderr);
		return 64;
	}
	if (argv[2][0] != '/') {
		fputs("kb-child-guard: program must be an absolute path\n", stderr);
		return 64;
	}
	if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) {
		fputs("kb-child-guard: cannot arm parent-death signal\n", stderr);
		return 70;
	}
	/* The parent may have died between fork() and prctl(): then we were
	 * reparented and the death signal will never fire. */
	if (getppid() != expected) return 70;
	execv(argv[2], &argv[2]);
	fputs("kb-child-guard: exec failed\n", stderr);
	return 127;
}
